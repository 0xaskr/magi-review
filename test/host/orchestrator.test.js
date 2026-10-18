import test from 'node:test';
import assert from 'node:assert/strict';
import { runReview, buildCardPayload, renderCommandMarkdown } from '../../lib/host/orchestrator.js';
import { runCouncil } from '../../lib/host/council.js';
import { apply, parseCommandArgs } from '../../lib/index.js';

const patch = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-old\n+new\n';
function fixture() {
  const calls = { snapshots: [], clerk: [], seats: [], saved: [], captures: [] };
  const snapshot = { kind: 'working-tree', cwd: 'C:/fake', canonicalPatch: patch, patchHash: 'original-hash',
    files: [{ path: 'src/a.js' }], coverage: { totalFiles: 1, reviewedFiles: 1, partial: false }, empty: false };
  const deps = {
    configRaw: { modes: { default: 'quick' } },
    listAvailableRoutes: async () => ({ providers: [{ id: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }, { id: 'other', models: [{ id: 'other-model' }] }] }),
    buildIntentContext: () => ({ task: 'Verify change', claims: 'Done' }), lastTurnWindow: () => ({}), latestWorkspaceChangesSeq: () => undefined,
    snapshotReview: async args => { calls.snapshots.push(args); return { ...snapshot, kind: args.target }; },
    runClerk: async input => { calls.clerk.push(input); return { ok: true, proposal: { confidence: 'high', rationale: 'Frozen scope',
      modelAssignment: input.config.seats.map(s => ({ seatId: s.id, provider: 'deepseek-official', model: 'deepseek-flash', assignmentReason: 'selected' })) } }; },
    captureWorkspaceState: async args => { calls.captures.push(args); return { combined: 'stable' }; },
    detectWorkspaceMutation: () => ({ mutated: false }),
    store: { saveReview: async result => { calls.saved.push(result); return { ok: true, reportId: result.digest.reportId }; } },
    runSeatTurn: async (_service, request) => {
      calls.seats.push(request); const [, kind, seatRef] = request.label.split('-');
      return { ok: true, childId: `child-${calls.seats.length}`, structured: kind === 'brief'
        ? { seatRef, verdict: 'approve', impact: 'normal', findings: [], summary: 'Checked' }
        : { seatRef, finalVerdict: 'approve', finalFindings: [], changedFromBrief: false } };
    },
  };
  const ctx = { get: name => name === 'workingDirectory' ? { get: () => 'C:/session-cwd' } : {} };
  return { deps, calls, snapshot, input: { ctx, agent: { session: { id: 'session' } }, args: {}, deps } };
}

test('NO_CHANGES returns a non-throwing error without calling clerk, guard or store', async () => {
  const f = fixture(); f.snapshot.empty = true; f.snapshot.files = []; f.snapshot.canonicalPatch = '';
  const response = await runReview(f.input);
  assert.equal(response.ok, false); assert.equal(response.error.code, 'NO_CHANGES');
  assert.equal(response.verdict, 'none'); assert.equal(response.status, 'error');
  assert.equal(f.calls.clerk.length, 0); assert.equal(f.calls.saved.length, 0); assert.equal(f.calls.captures.length, 0);
});

test('ordinary quick review preserves hash, pins/different providers, cwd, and persists full result', async () => {
  const f = fixture(); f.deps.configRaw.seats = [
    { id: 'architect', perspective: 'builtin:architect', model: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    { id: 'engineer', perspective: 'builtin:engineer' }, { id: 'adversary', perspective: 'builtin:adversary' },
  ];
  const response = await runReview(f.input);
  assert.equal(response.ok, true); assert.equal(response.result.digest.verdict, 'approve');
  assert.equal(response.result.scope.target.patchHash, 'original-hash');
  assert.equal(f.calls.snapshots[0].cwd, 'C:/session-cwd'); assert.equal(f.calls.snapshots.length, 1);
  assert.equal(response.result.reveal.seats[0].provider, 'deepseek-official');
  assert.equal(response.result.reveal.seats[2].provider, 'other'); assert.equal(response.result.metadata.homogeneous, false);
  assert.equal(f.calls.saved[0].digest.reportId, response.reportId); assert.equal(response.result.schemaVersion, '1.1');
  const usage = f.calls.saved[0].metadata.usage;
  assert.ok(usage.estimatedInputTokens > 0); assert.ok(usage.estimatedOutputTokens > 0);
  assert.equal(usage.seatsUsed, 3); assert.equal(usage.rounds, 0);
});

test('invocation context and timeout defaults reach both engines without editing the entrypoint', async () => {
  for (const mode of ['quick', 'council']) for (const [argsValue, depsValue, expected] of [
    [undefined, undefined, 'tool'], ['tool', 'command', 'tool'], [undefined, 'command', 'command'], ['command', undefined, 'command'],
  ]) {
    const f = fixture(); f.input.args = { mode, ...(argsValue ? { __invokedAs: argsValue } : {}) };
    f.deps.invokedAs = depsValue;
    f.deps[mode === 'quick' ? 'runQuick' : 'runCouncil'] = async (input, deps) => {
      assert.equal(input.invokedAs, expected); assert.equal(input.config.discussion.humanConfirmationTimeoutMs, 120000);
      return runCouncil({ ...input, mode: 'quick' }, deps);
    };
    assert.equal((await runReview(f.input)).ok, true);
  }
});

test('explicit confirmation timeout, exhaustion policy and input cap survive frozen config normalization', async () => {
  const f = fixture(); f.deps.invokedAs = 'command';
  f.deps.configRaw.discussion = { humanConfirmationTimeoutMs: 300000 };
  f.deps.configRaw.execution = { maxInputTokens: 1000000, onExhaustion: 'proceed' };
  f.deps.runQuick = async (input, deps) => {
    assert.equal(input.invokedAs, 'command'); assert.equal(input.config.discussion.humanConfirmationTimeoutMs, 300000);
    assert.equal(input.config.execution.maxInputTokens, 1000000); assert.equal(input.config.execution.onExhaustion, 'proceed');
    return runCouncil({ ...input, mode: 'quick' }, deps);
  };
  assert.equal((await runReview(f.input)).ok, true);
});

test('explicit target wins over base, auto base chooses base-ref, and paths/focus are forwarded', async () => {
  const f = fixture(); f.input.args = { target: 'staged', base: 'main', paths: ['src/a.js'], focus: ['tests'] };
  assert.equal((await runReview(f.input)).ok, true);
  assert.equal(f.calls.snapshots[0].target, 'staged'); assert.deepEqual(f.calls.clerk[0].intent.focus, ['tests']);
  const g = fixture(); g.input.args = { base: 'main' }; await runReview(g.input);
  assert.equal(g.calls.snapshots[0].target, 'base-ref');
});

test('auto clean tree selects turn, including zero changes sequence', async () => {
  const f = fixture(); f.deps.latestWorkspaceChangesSeq = () => 0;
  f.deps.snapshotReview = async args => { f.calls.snapshots.push(args); return args.target === 'working-tree'
    ? { ...f.snapshot, empty: true, files: [], canonicalPatch: '' } : { ...f.snapshot, kind: 'turn' }; };
  const response = await runReview(f.input);
  assert.equal(response.ok, true); assert.deepEqual(f.calls.snapshots.map(s => s.target), ['working-tree', 'turn']);
  assert.equal(f.calls.snapshots[1].changesSeq, 0); assert.equal(f.calls.snapshots[1].sessionId, 'session');
});

test('unavailable explicit turn falls back to working tree with degradation', async () => {
  const f = fixture(); f.input.args.target = 'turn';
  const response = await runReview(f.input);
  assert.equal(response.ok, true); assert.equal(f.calls.snapshots[0].target, 'working-tree');
  assert.ok(response.result.digest.degradedReasons.includes('turn_unavailable'));
});

test('clerk fallback propagates to digest/decision even when all votes approve', async () => {
  const f = fixture(); f.deps.runClerk = async () => { throw new Error('private model routing error'); };
  const response = await runReview(f.input);
  assert.equal(response.ok, true); assert.equal(response.result.digest.status, 'degraded');
  assert.ok(response.result.digest.degradedReasons.includes('clerk_fallback'));
  assert.equal(response.result.scope.confidence, 'low'); assert.equal(response.result.ballots.length, 3);
  assert.ok(response.result.errors.some(e => e.message.includes('private model routing error')));
  assert.doesNotMatch(response.result.scope.rationale, /private model routing error/);
  assert.doesNotMatch(JSON.stringify(f.calls.seats), /private model routing error/);
});

test('workspace mutation withholds approval and updates stored digest and card', async () => {
  const f = fixture(); f.deps.detectWorkspaceMutation = () => ({ mutated: true });
  const response = await runReview(f.input);
  assert.equal(response.result.digest.verdict, 'insufficient'); assert.equal(response.result.digest.trust, 'needs_review');
  assert.equal(response.result.metadata.workspaceMutatedDuringReview, true);
  assert.equal(f.calls.saved[0].digest.verdict, 'insufficient'); assert.equal(buildCardPayload(response.result).verdict, 'insufficient');
});

test('storage returned failure and thrown failure retain full result with storage_failed', async () => {
  for (const throws of [false, true]) {
    const f = fixture(); f.deps.store.saveReview = async () => { if (throws) throw new Error('disk full'); return { ok: false }; };
    const response = await runReview(f.input);
    assert.equal(response.ok, true); assert.ok(response.result.digest.degradedReasons.includes('storage_failed'));
    assert.equal(response.result.digest.status, 'degraded'); assert.equal(response.result.seatBriefs.length, 3);
  }
});

test('snapshot, route and engine exceptions never escape; raw diagnostics are withheld', async () => {
  for (const key of ['snapshotReview', 'listAvailableRoutes', 'runQuick']) {
    const f = fixture(); f.deps[key] = async () => { throw new Error('SECRET_SESSION_MAPPING'); };
    const response = await runReview(f.input);
    assert.equal(response.ok, false); assert.ok(response.error); assert.doesNotMatch(JSON.stringify(response), /SECRET_SESSION_MAPPING/);
  }
});

test('redaction runs before any model; output is scanned and hash remains original', async () => {
  const f = fixture(), secret = 'sk-abcdefghijklmnopqrstuvwx';
  f.snapshot.canonicalPatch += `+const key = '${secret}';\n`;
  f.deps.buildIntentContext = () => ({ task: secret });
  const response = await runReview(f.input);
  assert.equal(response.ok, true); assert.ok(response.result.redaction.count >= 2);
  assert.doesNotMatch(JSON.stringify(f.calls.clerk), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(f.calls.seats), new RegExp(secret));
  assert.equal(response.result.scope.target.patchHash, 'original-hash');
});

test('redaction fails closed before clerk and never leaks the scanner exception', async () => {
  const f = fixture(); f.deps.core = { redactSecrets() { throw new Error('raw secret'); } };
  const response = await runReview(f.input);
  assert.equal(response.error.code, 'REDACTION_FAILED'); assert.equal(f.calls.clerk.length, 0); assert.equal(f.calls.seats.length, 0);
});

test('prompt truncation marks partial coverage and forbids approval', async () => {
  const f = fixture(); f.snapshot.canonicalPatch += '+' + 'x'.repeat(60000) + '\n';
  const response = await runReview(f.input);
  assert.equal(response.result.coverage.partial, true); assert.equal(response.result.digest.verdict, 'insufficient');
  assert.ok(response.result.digest.degradedReasons.includes('context_truncated'));
});

test('whole-file input budget reports exactly the included files independently of maxTokens', async () => {
  const blocks = ['a', 'b', 'c'].map(name => patch.replaceAll('src/a.js', `src/${name}.js`));
  for (const count of [2, 3]) {
    const f = fixture(); f.snapshot.canonicalPatch = blocks.join('');
    f.snapshot.files = ['a', 'b', 'c'].map(name => ({ path: `src/${name}.js` }));
    f.snapshot.coverage = { totalFiles: 3, reviewedFiles: 3, partial: false };
    f.deps.configRaw.execution = { promptBudgetTokens: Math.ceil(blocks.slice(0, count).join('').length / 3), maxTokens: 1 };
    const { result } = await runReview(f.input);
    assert.equal(result.coverage.partial, count === 2); assert.equal(result.coverage.reviewedFiles, count);
    assert.deepEqual(result.coverage.unreviewedPaths, count === 2 ? ['src/c.js'] : []);
    assert.equal(f.calls.clerk[0].snapshot.promptPatch, blocks.slice(0, count).join(''));
    assert.equal(f.calls.clerk[0].snapshot.canonicalPatch, blocks.join(''));
    for (const request of f.calls.seats.filter(c => c.label.startsWith('magi-brief'))) {
      assert.ok(request.prompt.includes(blocks.slice(0, count).join('')));
      assert.equal(request.prompt.includes(blocks[2]), count === 3);
    }
    assert.equal(result.digest.verdict, count === 2 ? 'insufficient' : 'approve');
  }
});

test('path selection and unavailable files remain partial with a sufficient prompt budget', async () => {
  const f = fixture(); f.snapshot.coverage = { totalFiles: 3, reviewedFiles: 1, partial: true, paths: ['src/a.js'] };
  const selected = await runReview(f.input);
  assert.equal(selected.result.coverage.partial, true); assert.equal(selected.result.coverage.reviewedFiles, 1);
  assert.equal(selected.result.digest.verdict, 'insufficient');
  f.snapshot.files[0].unavailable = true;
  const unavailable = await runReview(f.input);
  assert.equal(unavailable.result.coverage.reviewedFiles, 0); assert.deepEqual(unavailable.result.coverage.unreviewedPaths, ['src/a.js']);
});

test('adversary diversity corrects clerk proposals by model id even across different providers', async () => {
  for (const differentModel of [false, true]) {
    const f = fixture();
    f.deps.listAvailableRoutes = async () => ({ providers: [
      { id: 'deepseek-official', models: [{ id: 'deepseek-flash' }, ...(differentModel ? [{ id: 'deepseek-v4-pro' }] : [])] },
      { id: 'deepseek-account', models: [{ id: 'deepseek-flash' }] },
    ] });
    f.deps.runClerk = async input => ({ ok: true, proposal: { modelAssignment: input.config.seats.map((s, i) => ({ seatId: s.id,
      provider: i === 2 ? 'deepseek-account' : 'deepseek-official', model: 'deepseek-flash', assignmentReason: 'clerk_choice' })) } });
    const { result } = await runReview(f.input);
    assert.equal(result.metadata.homogeneous, !differentModel); assert.equal(result.digest.homogeneous, !differentModel);
    assert.equal(result.reveal.seats[2].model, differentModel ? 'deepseek-v4-pro' : 'deepseek-flash');
    if (differentModel) assert.equal(result.scope.modelAssignment[2].assignmentReason, 'adversary_model_diversity');
  }
});

test('patch integration with real clerk and session extraction works on a get-only Cordis context', async () => {
  const f = fixture(); f.input.args = { mode: 'quick', target: 'patch', patch };
  for (const key of ['runClerk', 'listAvailableRoutes', 'snapshotReview', 'buildIntentContext', 'lastTurnWindow', 'latestWorkspaceChangesSeq']) delete f.deps[key];
  const events = [...Array.from({ length: 1500 }, () => ({ type: 'tool/result' })),
    { type: 'user/message', data: { content: 'Review this small patch' } }, { type: 'turn/start', data: { turn: 12 } },
    { type: 'assistant/message', data: { content: 'The patch is ready' } }, ...Array.from({ length: 600 }, () => ({ type: 'tool/result' }))];
  f.input.agent.session = { id: 'large-session', seq: events.length, snapshotEvents: (from, to) => events.slice(from, to) };
  let modelCalls = 0;
  const llm = { listProviders: () => [{ id: 'deepseek-official' }, { id: 'deepseek-account' }], listModels: () => [{ id: 'deepseek-flash' }],
    async *stream(request) {
      modelCalls++; assert.equal(request.provider, 'deepseek-account'); assert.match(request.messages[0].content[0].text, /Review this small patch/);
      yield { type: 'text-delta', text: JSON.stringify({ targetKind: 'patch', confidence: 'high', rationale: 'Frozen scope',
        modelAssignment: ['architect', 'engineer', 'adversary'].map((seatId, i) => ({ seatId,
          provider: i === 2 ? 'deepseek-account' : 'deepseek-official', model: 'deepseek-flash', assignmentReason: 'Available route' })) }) };
    } };
  f.input.ctx = new Proxy({ get(name) {
    return name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
      : name === 'workingDirectory' ? { get: () => 'C:/fake' } : undefined;
  } }, { get(target, key) { if (key !== 'get') throw Error(`cannot get property ${String(key)} without inject`); return target[key]; } });
  const { ok, result } = await runReview(f.input);
  assert.equal(ok, true); assert.equal(modelCalls, 1); assert.equal(result.digest.status, 'completed');
  assert.ok(!result.degradedReasons.includes('clerk_fallback'));
  assert.deepEqual(result.scope.intent, { task: 'Review this small patch', claims: 'The patch is ready', turn: 12 });
  assert.equal(result.metadata.homogeneous, true); assert.equal(result.coverage.reviewedFiles, 1);
  for (const b of result.seatBriefs) assert.ok(b.usage.durationMs < 240000);
  assert.equal(f.calls.saved.length, 1);
});

test('total deadline bounds hanging preflight and a pre-aborted call performs no I/O', async () => {
  const f = fixture(); f.deps.configRaw.execution = { totalTimeoutMs: 10 };
  f.deps.listAvailableRoutes = () => new Promise(() => {});
  assert.equal((await runReview(f.input)).ok, false);
  const g = fixture(), controller = new AbortController(); controller.abort(); g.input.signal = controller.signal;
  assert.equal((await runReview(g.input)).ok, false); assert.equal(g.calls.snapshots.length, 0);
});

test('config and request validation are errors; 5-seat requests produce all expected seats', async () => {
  const f = fixture(); f.input.args.seats = 4; assert.equal((await runReview(f.input)).ok, false);
  const g = fixture(); g.deps.configRaw.execution = { totalTimeoutMs: -1 }; assert.equal((await runReview(g.input)).error.code, 'CONFIG_INVALID');
  const h = fixture(); h.input.args.seats = 5;
  const response = await runReview(h.input); assert.equal(response.result.seatBriefs.length, 5); assert.equal(response.result.decision.expectedQuorum, 3);
});

test('card emits only final allowlisted data; Markdown is bounded in UTF-8 and keeps reportId', async () => {
  assert.equal(buildCardPayload({ seatBriefs: [{ seatRef: 'A', model: 'hidden' }] }), undefined);
  const f = fixture(), { result } = await runReview(f.input);
  const card = buildCardPayload(result);
  assert.deepEqual(card.seats.map(s => s.seatRef), ['A', 'B', 'C']); assert.equal(card.minutes, null);
  assert.equal(card.seatBriefs, undefined); assert.equal(card.scope, undefined);
  result.seatBriefs[0].summary = '<script>bad</script> 中文'.repeat(5000);
  const text = renderCommandMarkdown(result);
  assert.ok(Buffer.byteLength(text) <= 20480); assert.ok(text.includes(result.digest.reportId));
  assert.doesNotMatch(text, /<script>/); assert.match(text, /已截断/);
});

function registry() {
  const tools = [], commands = [];
  return { tools, commands, ctx: { effect: callback => callback(), on: () => () => {}, get: () => undefined,
    tools: { register: value => { tools.push(value); return () => {}; } },
    commands: { register: value => { commands.push(value); return () => {}; } } } };
}

test('tool registration projects digest and final metadata, catches failures', async () => {
  const f = fixture(), response = await runReview(f.input), r = registry();
  apply(r.ctx, {}, { runReview: async () => response });
  assert.deepEqual(r.tools.map(t => t.name), ['magi_review']);
  const tool = r.tools[0], value = await tool.execute({}, { agent: {}, signal: undefined });
  assert.equal(value.result, undefined); assert.equal(tool.output.presentationMeta({}, JSON.parse(JSON.stringify(value))).verdict, 'approve');
  assert.ok(Buffer.byteLength(tool.output.render({}, value)[0].text) <= 4096);
  assert.deepEqual(tool.parameters.properties.seats.enum, [3, 5, 7]);
  const full = await tool.execute({ detail: 'full' }, {}); assert.ok(full.result);
  const failure = registry(); apply(failure.ctx, {}, { runReview: async () => { throw new Error('secret'); } });
  assert.deepEqual(failure.tools.map(t => t.name), ['magi_review']);
  const failed = await failure.tools[0].execute({}, {}); assert.equal(failed.ok, false); assert.doesNotMatch(JSON.stringify(failed), /secret/);
});

test('command parsing, execution, report lookup and missing report are wired', async () => {
  assert.deepEqual(parseCommandArgs('quick --base "feature one" --seats 5 --focus security,tests --detail full'),
    { mode: 'quick', base: 'feature one', seats: 5, focus: ['security', 'tests'], detail: 'full' });
  assert.throws(() => parseCommandArgs('--patch change.diff'), /V1/); assert.throws(() => parseCommandArgs('--base'), /缺少/);
  assert.throws(() => parseCommandArgs('--base "unclosed'), /引号/);
  const f = fixture(), response = await runReview(f.input), r = registry(); let observed;
  apply(r.ctx, { command: { name: 'custom-review' } }, { runReview: async input => { observed = input.args; return response; },
    store: { getReview: async id => id === 'known' ? response : { ok: false } } });
  assert.equal(r.commands[0].name, 'custom-review');
  assert.equal((await r.commands[0].handler({ rawInput: 'quick --staged' })).kind, 'success');
  assert.deepEqual(observed, { mode: 'quick', target: 'staged' });
  assert.equal((await r.commands[0].handler({ rawInput: '--report known' })).kind, 'success');
  assert.equal((await r.commands[0].handler({ rawInput: '--report missing' })).kind, 'error');
  assert.equal((await r.commands[0].handler({ rawInput: 'ping' })).kind, 'error');
});

test('readonly ballot dispatch guard denies all tools while brief reads and verify shell remain available', () => {
  for (const [label, preset, forbidden, allowed] of [
    ['magi-ballot-A', 'magi-reviewer-readonly', ['read', 'grep', 'structured_output', 'pwsh'], []],
    ['magi-brief-A', 'magi-reviewer-readonly', ['write', 'edit', 'pwsh'], ['read', 'grep']],
    ['magi-discussion-A', 'magi-reviewer-verify', ['write', 'edit'], ['read', process.platform === 'win32' ? 'pwsh' : 'bash']],
  ]) {
    const r = registry(), guards = []; let onCreated;
    const agent = { id: 'child', session: { header: { parentSession: 'parent', agentPreset: preset }, seq: 1,
      snapshotEvents: () => [{ type: 'subagent/descriptor', data: { label } }] } };
    const child = { ctx: { effect: fn => fn(), tools: { guard: fn => { guards.push(fn); return () => {}; } } } };
    r.ctx.on = (_event, fn) => { onCreated = fn; return () => {}; };
    r.ctx.get = name => name === 'agents' ? { get: () => child } : undefined;
    apply(r.ctx); onCreated({ agent });
    for (const name of forbidden) assert.ok(guards.some(guard => guard({ name })), `${label} must deny ${name}`);
    for (const name of allowed) assert.ok(guards.every(guard => guard({ name }) === undefined), `${label} must allow ${name}`);
  }
});

test('third-party policy filters clerk routes and rejects conflicting pins before any model', async () => {
  const f = fixture(); f.deps.configRaw.security = { allowThirdPartyProviders: false };
  const response = await runReview(f.input);
  assert.equal(response.ok, true); assert.equal(f.calls.clerk[0].routes.providers.length, 1);
  const g = fixture(); g.deps.configRaw.security = { allowThirdPartyProviders: false };
  g.deps.configRaw.clerk = { model: { provider: 'other', model: 'other-model' } };
  assert.equal((await runReview(g.input)).ok, false); assert.equal(g.calls.seats.length, 0);
});
