import test from 'node:test';
import assert from 'node:assert/strict';
import { readRecentEvents, currentTurn, latestUserRequest, latestAssistantText, latestWorkspaceChangesSeq, buildIntentContext, lastTurnWindow } from '../../lib/host/session-context.js';

const event = (type, data) => ({ type, data });
const message = text => ({ message: { content: [{ type: 'text', text }] } });
function session(list, fallback = false) {
  const events = list.map((e, seq) => Object.freeze({ ...e, seq }));
  return { id: 'test', seq: events.length, ...(fallback ? { eventAt: i => events[i] } : { snapshotEvents: (from, to) => events.slice(from, to) }) };
}

test('bounded event readers and eventAt fallback use exclusive upper bounds', () => {
  const events = Array.from({ length: 205 }, () => event('noop', {}));
  for (const fallback of [false, true]) {
    const recent = readRecentEvents(session(events, fallback), 200);
    assert.equal(recent.length, 200);
    assert.equal(recent[0].seq, 5);
    assert.equal(recent.at(-1).seq, 204);
    assert.equal(readRecentEvents(session(events, fallback), 0).length, 0);
  }
  assert.deepEqual(readRecentEvents({ seq: 1, snapshotEvents() { throw Error('closed'); } }), []);
  assert.deepEqual(readRecentEvents(null), []);
});

test('long sessions scan backwards beyond 200 events and stop once the current turn is known', () => {
  const noise = () => event('tool/result', { text: 'irrelevant' });
  const events = [...Array.from({ length: 1500 }, noise), event('user/message', message('Fix the integration')),
    event('turn/start', { turn: 7 }), event('assistant/message', message('Implemented the fix')),
    event('workspace/changes', { turn: 7 }), ...Array.from({ length: 600 }, noise)];
  for (const fallback of [false, true]) {
    const s = session(events, fallback), reads = [];
    if (!fallback) {
      const snapshot = s.snapshotEvents;
      s.snapshotEvents = (from, to) => { reads.push([from, to]); return snapshot(from, to); };
    }
    assert.deepEqual(buildIntentContext(s), { task: 'Fix the integration', claims: 'Implemented the fix', turn: 7, workspaceChangesSeq: 1503 });
    assert.equal(currentTurn(s), 7); assert.equal(latestUserRequest(s), 'Fix the integration');
    assert.equal(latestAssistantText(s), 'Implemented the fix'); assert.equal(latestWorkspaceChangesSeq(s), 1503);
    assert.equal(readRecentEvents(s).length, 800);
    assert.ok(reads.every(([from, to]) => from >= 1304 && to - from <= 200));
  }
});

test('derived text fills missing fields even when recent events are present', () => {
  const s = session(Array.from({ length: 1500 }, () => event('tool/result', {})));
  s.deriveMessages = () => [{ role: 'user', content: 'Real task' }, { role: 'assistant', content: 'x'.repeat(3000) },
    { role: 'user', content: 'Time sampled: now' }, { role: 'user', content: '命令回执：完成' },
    { role: 'user', content: '<system-reminder>noise</system-reminder>' }];
  assert.equal(latestUserRequest(s), 'Real task'); assert.equal(latestAssistantText(s).length, 3000);
  assert.deepEqual(buildIntentContext(s), { task: 'Real task', claims: 'x'.repeat(2000), turn: 1 });
  assert.equal(currentTurn(s), 1);
  assert.equal(readRecentEvents(s).length, 1200);
});

test('eventAt remains available if snapshotEvents throws', () => {
  const s = session([event('user/message', message('Fallback task'))], true);
  s.snapshotEvents = () => { throw Error('unsupported snapshot'); };
  assert.equal(latestUserRequest(s), 'Fallback task');
});

test('extract intent, final assistant and latest changes while filtering injected user content', () => {
  const s = session([
    event('user/message', message('实现主机模块')),
    event('turn/start', { turn: 4 }),
    event('assistant/message', message('Earlier')),
    event('user/message', message('<system-reminder>ignore</system-reminder>')),
    event('user/message', message('Current runtime context: environment')),
    event('user/message', message('Time sampled: now')),
    event('user/message', { message: { source: { kind: 'command' }, content: [{ type: 'text', text: 'command success' }] } }),
    event('assistant/message', { message: { content: [{ type: 'text', text: 'Final' }, { type: 'reasoning', text: 'secret' }, { type: 'text', text: 'Done' }] } }),
    event('workspace/changes', { turn: 4 }), event('turn/end', { turn: 4 }),
  ]);
  assert.equal(currentTurn(s), 4);
  assert.equal(latestUserRequest(s), '实现主机模块');
  assert.equal(latestAssistantText(s), 'Final\nDone');
  assert.equal(latestWorkspaceChangesSeq(s), 8);
  assert.deepEqual(lastTurnWindow(s), { turn: 4, userText: '实现主机模块', assistantText: 'Final\nDone', changesSeq: 8 });
  assert.deepEqual(buildIntentContext(s), { task: '实现主机模块', claims: 'Final\nDone', turn: 4, workspaceChangesSeq: 8 });
});

test('turn window does not attribute an old assistant or old changes to a new turn', () => {
  const s = session([event('turn/start', { turn: 1 }), event('assistant/message', message('old')),
    event('workspace/changes', { turn: 1 }), event('turn/end', { turn: 1 }),
    event('user/message', message('new task')), event('turn/start', { turn: 2 })]);
  assert.deepEqual(lastTurnWindow(s), { turn: 2, userText: 'new task', assistantText: '' });
  assert.equal(latestWorkspaceChangesSeq(s), 2);
});

test('claims are capped, mixed reminders stripped, and derived messages are a safe fallback', () => {
  const s = session([event('user/message', message('<system-reminder>noise</system-reminder>actual task')),
    event('assistant/message', message('x'.repeat(3000)))]);
  assert.equal(buildIntentContext(s).claims.length, 2000);
  assert.equal(latestUserRequest(s), 'actual task');
  const derived = { deriveMessages: () => [{ role: 'user', content: 'task' }, { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }] };
  assert.equal(latestUserRequest(derived), 'task');
  assert.equal(latestAssistantText(derived), 'answer');
  assert.deepEqual(buildIntentContext(null), { task: '', claims: '', turn: 0 });
  assert.equal(latestAssistantText({ deriveMessages() { throw Error('gone'); } }), '');
});

test('actual DSH user data and Chinese command receipts are distinguished', () => {
  const s = session([
    event('user/message', { role: 'user', content: [{ type: 'text', text: '真实请求' }] }),
    event('user/message', { role: 'user', content: [{ type: 'text', text: '命令回执：完成' }] }),
    event('user/message', { role: 'user', content: [{ type: 'text', text: '<local-command-stdout>done</local-command-stdout>' }] }),
  ]);
  assert.equal(latestUserRequest(s), '真实请求');
});

test('turn boundaries survive 1500 noise events before or inside the current turn', () => {
  const noise = () => event('tool/result', {});
  for (const inside of [false, true]) for (const fallback of [false, true]) {
    const events = [...Array.from({ length: 1500 }, noise), event('turn/start', { turn: 23 }),
      ...(inside ? Array.from({ length: 1500 }, noise) : []), event('user/message', message('Fix the current patch')),
      event('assistant/message', message('The current patch is fixed'))];
    const s = session(events, fallback);
    assert.equal(currentTurn(s), 23);
    assert.deepEqual(buildIntentContext(s), { turn: 23, task: 'Fix the current patch', claims: 'The current patch is fixed' });
    assert.deepEqual(lastTurnWindow(s), { turn: 23, userText: 'Fix the current patch', assistantText: 'The current patch is fixed' });
  }
});

test('a user and assistant in the newest batch cannot hide a preceding turn boundary', () => {
  const events = [event('turn/start', { turn: 14 }), ...Array.from({ length: 200 }, () => event('tool/result', {})),
    event('user/message', message('Newest task')), event('assistant/message', message('Newest claim'))];
  const s = session(events), reads = [], snapshot = s.snapshotEvents;
  s.snapshotEvents = (from, to) => { reads.push([from, to]); return snapshot(from, to); };
  assert.deepEqual(buildIntentContext(s), { turn: 14, task: 'Newest task', claims: 'Newest claim' });
  assert.equal(reads.length, 2);
});

test('turn/end remains authoritative without turn/start and derived messages supply a last-resort estimate', () => {
  const s = session([event('user/message', message('Current task')), event('assistant/message', message('Current claim')),
    event('turn/end', { turn: 31 }), ...Array.from({ length: 1500 }, () => event('tool/result', {}))]);
  s.deriveMessages = () => [{ role: 'user', content: 'older task' }];
  assert.equal(currentTurn(s), 31); assert.deepEqual(buildIntentContext(s), { turn: 31, task: 'Current task', claims: 'Current claim' });
  const compacted = { deriveMessages: () => [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'first claim' },
    { role: 'user', content: 'second' }, { role: 'assistant', content: 'second claim' }, { role: 'user', content: 'Time sampled: now' }] };
  assert.equal(currentTurn(compacted), 2);
  assert.deepEqual(buildIntentContext(compacted), { turn: 2, task: 'second', claims: 'second claim' });
});
