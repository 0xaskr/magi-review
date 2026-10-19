import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, parseCommandArgs } from '../../lib/index.js';

function registry() {
  const tools = [], commands = [], disposers = [];
  const ctx = {
    effect(callback) { disposers.push(callback()); },
    on: () => () => {},
    get: () => undefined,
    tools: { register(value) { tools.push(value); return () => {}; } },
    commands: { register(value) { commands.push(value); return () => {}; } },
  };
  return { ctx, tools, commands, dispose() { for (const dispose of disposers.reverse()) dispose?.(); } };
}

const noChanges = { ok: false, error: { code: 'NO_CHANGES', message: 'No changes to review: the selected target is empty.',
  hint: '审查已提交改动：target=base-ref 且 base=<改动前的提交>。' } };

test('apply registers only the review tool and command, even with legacy selftest enabled', t => {
  for (const config of [{}, { debug: { selftest: false } }, { debug: { selftest: true } }]) {
    const r = registry(); t.after(() => r.dispose());
    apply(r.ctx, config, { runReview: async () => noChanges, store: {} });
    assert.deepEqual(r.tools.map(tool => tool.name), ['magi_review']);
    assert.deepEqual(r.commands.map(command => command.name), ['magi-review']);
    assert.equal(r.tools[0].parameters.additionalProperties, false);
    assert.equal(r.tools[0].parameters.properties.__invokedAs, undefined);
    assert.match(r.tools[0].description, /untrusted evidence/);
    assert.match(r.tools[0].description, /insufficient is not approval/);
  }
});

test('disabled entry points stay disabled with legacy selftest enabled', t => {
  const r = registry(); t.after(() => r.dispose());
  apply(r.ctx, { tool: { enabled: false }, command: { enabled: false }, debug: { selftest: true } }, { store: {} });
  assert.deepEqual(r.tools, []);
  assert.deepEqual(r.commands, []);
});

for (const [input, expected] of [
  ['', {}],
  ['  quick  ', { mode: 'quick' }],
  ['council --base main', { mode: 'council', base: 'main' }],
  ['quick --staged --seats 5 --focus security,tests --detail full',
    { mode: 'quick', target: 'staged', seats: 5, focus: ['security', 'tests'], detail: 'full' }],
  ['--target working-tree --seats 7 --detail digest', { target: 'working-tree', seats: 7, detail: 'digest' }],
  ['--report 4741cc06-a1e4-4db5-a8df-7f717306f9fe', { report: '4741cc06-a1e4-4db5-a8df-7f717306f9fe' }],
  ['--base "feature one" --focus "security, tests, ,"', { base: 'feature one', focus: ['security', 'tests'] }],
  ["--report 'report with spaces'", { report: 'report with spaces' }],
  ['--focus "$(echo injected),`literal`,a;b"', { focus: ['$(echo injected)', '`literal`', 'a;b'] }],
]) {
  test(`parseCommandArgs: ${input || '(defaults)'}`, () => assert.deepEqual(parseCommandArgs(input), expected));
}

for (const [input, pattern] of [
  ['--unknown value', /未知参数/],
  ['toString value', /未知参数/],
  ['__proto__ value', /未知参数/],
  ['ping', /未知参数/],
  ['--base', /缺少参数/],
  ['--seats --staged', /缺少参数/],
  ['--report ""', /缺少参数/],
  ['--base "unclosed', /引号未闭合/],
  ["--focus 'unclosed", /引号未闭合/],
  ['--patch change.diff', /V1 命令不读取 patch 文件/],
]) {
  test(`parseCommandArgs rejects ${input}`, () => assert.throws(() => parseCommandArgs(input), pattern));
}

test('tool and command bind their own invocation sources and preserve agent/signal/dependencies', async t => {
  const r = registry(), calls = [], store = {}, configRaw = { modes: { default: 'quick' } };
  t.after(() => r.dispose());
  apply(r.ctx, configRaw, { store, invokedAs: 'command', runReview: async input => { calls.push(input); return noChanges; } });
  const toolAgent = { id: 'tool-parent' }, commandAgent = { id: 'command-parent' };
  const toolSignal = new AbortController().signal, commandSignal = new AbortController().signal;
  const args = Object.freeze({ mode: 'quick', __invokedAs: 'command' });
  await Promise.all([
    r.tools[0].execute(args, { agent: toolAgent, signal: toolSignal }),
    r.commands[0].handler({ agent: commandAgent, rawInput: 'quick --staged', signal: commandSignal }),
  ]);
  const toolCall = calls.find(call => call.agent === toolAgent), commandCall = calls.find(call => call.agent === commandAgent);
  assert.equal(calls.length, 2);
  assert.deepEqual(toolCall.args, { mode: 'quick', __invokedAs: 'tool' });
  assert.equal(toolCall.deps.invokedAs, 'tool');
  assert.equal(toolCall.signal, toolSignal);
  assert.equal(args.__invokedAs, 'command');
  assert.deepEqual(commandCall.args, { mode: 'quick', target: 'staged' });
  assert.equal(commandCall.deps.invokedAs, 'command');
  assert.equal(commandCall.signal, commandSignal);
  // This is the orchestrator's precedence rule; no real review is needed here.
  for (const [call, source] of [[toolCall, 'tool'], [commandCall, 'command']]) {
    assert.equal(call.args.__invokedAs ?? call.deps.invokedAs, source);
    assert.equal(call.ctx, r.ctx);
    assert.equal(call.deps.configRaw, configRaw);
    assert.equal(call.deps.store, store);
  }
});

test('command source overrides a tool dependency default', async t => {
  const r = registry(); t.after(() => r.dispose());
  let source;
  apply(r.ctx, {}, { store: {}, invokedAs: 'tool', runReview: async input => { source = input.deps.invokedAs; return noChanges; } });
  const response = await r.commands[0].handler({ rawInput: 'council' });
  assert.equal(source, 'command');
  assert.equal(response.kind, 'error');
  assert.match(response.text, /^NO_CHANGES: No changes to review/);
  assert.match(response.text, /base-ref/);
});

test('invalid commands, including removed ping, never invoke review or storage', async t => {
  const r = registry(); t.after(() => r.dispose());
  let calls = 0;
  apply(r.ctx, { debug: { selftest: true } }, { runReview: async () => { calls++; return noChanges; },
    store: { getReview: async () => { calls++; return { ok: false }; } } });
  for (const rawInput of ['ping', '--unknown', '--base "unclosed']) {
    assert.equal((await r.commands[0].handler({ rawInput })).kind, 'error');
  }
  assert.equal(calls, 0);
});

test('report lookup renders saved Markdown and does not start a review', async t => {
  const r = registry(); t.after(() => r.dispose());
  const ids = [];
  const result = {
    reveal: { at: 'verdict', seats: [] }, seatBriefs: [], ballots: [], findings: [], discussion: [], minutes: null,
    digest: { reportId: 'saved-report', verdict: 'insufficient', status: 'degraded', trust: 'needs_review',
      target: { kind: 'patch', files: 1, partial: true }, rounds: 0, degradedReasons: ['context_truncated'], homogeneous: true },
    decision: { approveVotes: 0, requestVotes: 0, expectedQuorum: 2, rationale: 'Partial coverage', dissent: [] },
  };
  apply(r.ctx, {}, { runReview: async () => assert.fail('report lookup must not review'),
    store: { getReview: async id => { ids.push(id); return id === 'saved-report' ? { ok: true, result } : { ok: false }; } } });
  const saved = await r.commands[0].handler({ rawInput: '--report saved-report' });
  assert.equal(saved.kind, 'success');
  assert.match(saved.text, /reportId: `saved-report`/);
  assert.match(saved.text, /insufficient 表示证据不足，不能视为通过/);
  assert.equal((await r.commands[0].handler({ rawInput: '--report missing' })).kind, 'error');
  assert.deepEqual(ids, ['saved-report', 'missing']);
});
