import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandArgs, prepareCommandReview, commandHelp } from '../../lib/host/command.js';
import { apply } from '../../lib/index.js';

for (const [text, expected] of [
  ['', {}], ['--help', { help: true }], ['-h', { help: true }],
  ['--uncommitted', { target: 'working-tree' }],
  ['--base main', { base: 'main', target: 'branch' }],
  ['--commit HEAD~1', { commit: 'HEAD~1', target: 'commit' }],
  ['重点检查权限绕过', { instructions: '重点检查权限绕过' }],
  ['--base main "check public API"', { base: 'main', target: 'branch', instructions: 'check public API' }],
  ['quick --uncommitted --focus security,tests', { mode: 'quick', target: 'working-tree', focus: ['security', 'tests'] }],
  ['--target base-ref --base main', { target: 'base-ref', base: 'main' }],
  ['-- --base is literal $(echo hi)', { instructions: '--base is literal $(echo hi)' }],
  ['-- Check "quoted".', { instructions: 'Check "quoted".' }],
  ['-- Check the string "unterminated\nnext line', { instructions: 'Check the string "unterminated\nnext line' }],
  ['"quick"', { instructions: 'quick' }],
  ["Check that users can't bypass auth", { instructions: "Check that users can't bypass auth" }],
]) test(`command parses ${text || 'empty picker request'}`, () => assert.deepEqual(parseCommandArgs(text), expected));

for (const text of ['quick council', '--staged --uncommitted', '--base main --staged', '--staged --base main',
  '--base main --commit HEAD', '--commit HEAD --base main', '--target turn --commit HEAD',
  '--report id --seats 4', '--report id instructions', '--help --uncommitted', '--base main --base develop',
  '--target patch', '--target branch', '--target commit', '--detail full', '--seats 4', '--provider p', '--model m',
  '--bogus', '--base', '--base "unterminated', '--base "main"suffix']) {
  test(`command rejects ambiguous or unsupported ${text}`, () => assert.throws(() => parseCommandArgs(text)));
}

function interaction(answers, services = {}) {
  const requests = [], calls = [], commands = [];
  const agent = { session: { id: 'session', header: { cwd: '/fallback' } } };
  const controller = new AbortController();
  const ctx = { effect: fn => fn(), on: () => () => {}, tools: { register: () => () => {} },
    commands: { register: command => { commands.push(command); return () => {}; } },
    get: name => name === 'userQuestions' ? { ask: async request => {
      requests.push(request);
      const value = answers.shift();
      if (value instanceof Error) throw value;
      if (typeof value === 'function') return value(request);
      return { answers: [{ id: request.questions[0].id, selected: value ? [value] : [] }] };
    } } : name === 'workingDirectory' ? { get: () => '/workspace' } : services[name] };
  const deps = { store: {}, runReview: async input => { calls.push(input); return { ok: false, error: { code: 'NO_CHANGES', message: 'empty' } }; },
    listReviewBranches: async request => { assert.equal(request.cwd, '/workspace'); return [{ ref: 'refs/heads/main', current: false }]; },
    listReviewCommits: async request => { assert.equal(request.cwd, '/workspace'); return [{ oid: 'abcdef1234567890', subject: 'A change' }]; } };
  apply(ctx, {}, deps);
  return { ctx, agent, signal: controller.signal, controller, requests, calls, deps, command: commands[0] };
}

for (const [answers, expected] of [
  [['审查未提交的改动'], { target: 'working-tree' }],
  [['与基线分支比较', 'refs/heads/main'], { target: 'branch', base: 'refs/heads/main' }],
  [['审查某次提交', 'abcdef1234 · A change'], { target: 'commit', commit: 'abcdef1234567890' }],
  [['审查某次提交', 'HEAD~2'], { target: 'commit', commit: 'HEAD~2' }],
  [['自定义审查要求', request => ({ answers: [{ id: request.questions[0].id, selected: [], custom: '  检查权限回归  ' }] })],
    { target: 'working-tree', instructions: '检查权限回归' }],
]) test(`picker completes ${answers[0]}`, async () => {
  const f = interaction([...answers]);
  await f.command.handler({ agent: f.agent, signal: f.signal });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, expected);
  assert.ok(f.requests.every(request => request.agent === f.agent && request.signal === f.signal));
  assert.equal(f.calls[0].deps.invokedAs, 'command');
});

for (const answers of [['取消评审'], [null], ['与基线分支比较', '取消评审'], ['审查某次提交', null],
  ['自定义审查要求', null], [Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' })],
  [Object.assign(new Error('cancelled'), { code: 'ASK_CANCELLED' })]]) {
  test(`picker cancellation starts no review: ${JSON.stringify(answers)}`, async () => {
    const f = interaction([...answers]);
    const response = await f.command.handler({ agent: f.agent, signal: f.signal });
    assert.match(response.text, /已取消/);
    assert.equal(f.calls.length, 0);
  });
}

test('help, direct calls and unavailable questions never fall into a hanging picker', async () => {
  const f = interaction([]);
  assert.match((await f.command.handler({ rawInput: '--help' })).text, /--uncommitted/);
  assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 0);
  for (const rawInput of ['--uncommitted', 'quick', '检查兼容性']) {
    await f.command.handler({ rawInput, agent: f.agent, signal: f.signal });
    assert.equal(f.calls.at(-1).args.target, 'working-tree');
  }
  assert.equal(f.requests.length, 0);
  await assert.rejects(prepareCommandReview({ ctx: { get: () => undefined }, agent: f.agent, args: {} }), /无法显示范围选择/);
  assert.match(commandHelp('custom-review'), /\/custom-review --commit/);
  assert.doesNotMatch(commandHelp('custom-review'), /\/magi-review/);
});

test('invalid menu answer, listing failure and abort cannot start a review', async () => {
  const invalid = interaction(['unknown']);
  assert.equal((await invalid.command.handler({ agent: invalid.agent })).kind, 'error');
  assert.equal(invalid.calls.length, 0);
  const aborted = interaction([]); aborted.controller.abort();
  assert.match((await aborted.command.handler({ agent: aborted.agent, signal: aborted.signal })).text, /已取消/);
  assert.equal(aborted.requests.length, 0); assert.equal(aborted.calls.length, 0);
  const listed = interaction(['与基线分支比较']);
  listed.deps.listReviewBranches = async () => { throw new Error('No repository'); };
  const response = await listed.command.handler({ agent: listed.agent });
  assert.equal(response.kind, 'error'); assert.equal(listed.calls.length, 0);
});
