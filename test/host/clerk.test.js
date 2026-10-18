import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, resolveSeatModels } from '../../lib/host/config.js';
import { runClerk, clerkFallbackDegraded } from '../../lib/host/clerk.js';

const routes = { providers: [{ id: 'p', models: [{ id: 'standard' }, { id: 'strong' }] }, { id: 'q', models: [{ id: 'alternate' }] }] };
const snapshot = { kind: 'working-tree', patchHash: 'frozen-hash', canonicalPatch: '+changed\n',
  files: [{ path: 'src/app.js', additions: 1, deletions: 0, status: 'modified' }, { path: 'test/app.js', additions: 1, deletions: 0, status: 'modified' }] };
const intent = { task: 'Fix the bounds check.', claims: 'Added coverage.', turn: 3 };
const configOf = (extra = {}) => normalizeConfig({ models: { defaultRoute: { provider: 'p', model: 'standard' } }, ...extra });
const proposal = (extra = {}) => ({ targetKind: 'working-tree', rationale: 'Review changed implementation and tests.', confidence: 'high',
  files: ['src/app.js', 'test/app.js'], intent: { task: intent.task },
  modelAssignment: ['architect', 'engineer', 'adversary'].map(seatId => ({ seatId, provider: 'p', model: 'standard', assignmentReason: 'Available.' })), ...extra });

function harness(responses, { config = configOf(), catalog = routes, selection = { provider: 'p', model: 'standard' } } = {}) {
  const calls = [];
  const llm = {
    listProviders: () => catalog.providers.map(p => ({ id: p.id })),
    listModels: provider => catalog.providers.find(p => p.id === provider)?.models ?? [],
    async *stream(request) {
      calls.push(request);
      const response = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (response instanceof Error) throw response;
      const body = typeof response === 'string' ? response : '```json\n' + JSON.stringify(response) + '\n```';
      const middle = Math.floor(body.length / 2);
      yield { type: 'text-delta', text: body.slice(0, middle) };
      yield { type: 'text-delta', text: body.slice(middle) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const ctx = { llm, config, get: name => name === 'llm' ? llm : name === 'agentDefaultModel'
    ? { currentSelection: () => selection } : name === 'config' ? config : undefined };
  return { calls, ctx, input: { ctx, config, routes: catalog, snapshot, intent, args: {} } };
}

test('clerk succeeds with injected streaming LLM and returns normalized new proposal', async () => {
  const raw = proposal({ unknown: 'discard', rationale: '  review  ' });
  raw.modelAssignment[0].unknown = 'discard';
  const h = harness([raw]), before = structuredClone(raw);
  const result = await runClerk(h.input);
  assert.equal(result.ok, true); assert.equal(result.fallback, false); assert.deepEqual(result.errors, []);
  assert.equal(result.proposal.rationale, 'review'); assert.equal(result.proposal.unknown, undefined);
  assert.equal(result.proposal.modelAssignment[0].unknown, undefined);
  assert.deepEqual(result.clerkRoute, { provider: 'p', model: 'standard' });
  assert.ok(result.durationMs >= 0); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].maxTokens, 1500); assert.equal(h.calls[0].temperature, 0);
  assert.ok(h.calls[0].signal instanceof AbortSignal);
  assert.match(h.calls[0].system, /Do not vote or evaluate code/);
  assert.match(h.calls[0].messages[0].content[0].text, /untrusted-[a-f0-9]{16}/);
  assert.deepEqual(raw, before); assert.equal(clerkFallbackDegraded, 'clerk_fallback');
});

test('clerk retries invalid JSON once and then succeeds', async () => {
  const h = harness(['not JSON', proposal()]);
  const result = await runClerk(h.input);
  assert.equal(result.ok, true); assert.equal(result.fallback, false); assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].messages[0].content[0].text, /previous response failed JSON validation/);
});

test('clerk retries schema-invalid JSON including unavailable routes before success', async () => {
  const malformed = proposal(); malformed.modelAssignment[1].model = 'not-available';
  const h = harness([malformed, proposal()]);
  const result = await runClerk(h.input);
  assert.equal(result.ok, true); assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].messages[0].content[0].text, /route unavailable/);
});

test('clerk falls back after two invalid responses with full snapshot and deterministic assignments', async () => {
  const h = harness(['no JSON', { invalid: true }]);
  const result = await runClerk(h.input);
  assert.equal(result.ok, false); assert.equal(result.fallback, true); assert.equal(h.calls.length, 2);
  assert.equal(result.proposal.targetKind, snapshot.kind); assert.equal(result.proposal.confidence, 'low');
  assert.deepEqual(result.proposal.files, snapshot.files.map(f => f.path));
  assert.match(result.proposal.rationale, /^clerk_fallback: /); assert.ok(result.errors.length > 0);
  assert.deepEqual(result.proposal.modelAssignment, resolveSeatModels(h.input.config, routes).assignments);
  assert.deepEqual(result.proposal.intent, intent); assert.notEqual(result.proposal.intent, intent);
});

test('clerk corrects pinned seat assignment without discarding an otherwise valid proposal', async () => {
  const config = configOf({ seats: [
    { id: 'architect', perspective: 'builtin:architect', model: { provider: 'p', model: 'strong' } },
    { id: 'engineer', perspective: 'builtin:engineer' }, { id: 'adversary', perspective: 'builtin:adversary' },
  ] });
  const h = harness([proposal()], { config });
  const result = await runClerk(h.input);
  assert.equal(result.ok, true); assert.equal(result.fallback, false); assert.equal(h.calls.length, 1);
  const assigned = result.proposal.modelAssignment.find(s => s.seatId === 'architect');
  assert.equal(assigned.model, 'strong'); assert.equal(assigned.assignmentReason, 'explicit_pin');
  assert.match(result.errors.join('; '), /corrected pinned route/);
});

test('clerk corrects a valid targetKind that is outside the permitted frozen target', async () => {
  for (const args of [{}, { target: 'auto' }, { target: 'working-tree' }]) {
    const h = harness([proposal({ targetKind: 'staged' })]);
    const result = await runClerk({ ...h.input, args });
    assert.equal(result.ok, true); assert.equal(result.proposal.targetKind, snapshot.kind);
    assert.match(result.errors.join('; '), /targetKind/); assert.equal(h.calls.length, 1);
  }
});

test('clerk never relabels the frozen snapshot even if request and snapshot disagree', async () => {
  const h = harness([proposal({ targetKind: 'staged' })]);
  const result = await runClerk({ ...h.input, args: { target: 'staged' } });
  assert.equal(result.proposal.targetKind, snapshot.kind); assert.ok(result.errors.length > 0);
});

test('configured clerk route wins over default; unavailable configuration uses the resolved default', async () => {
  for (const [model, expected] of [['strong', 'strong'], ['missing', 'standard']]) {
    const config = configOf({ clerk: { model: { provider: 'p', model } } });
    const h = harness([proposal()], { config });
    const result = await runClerk(h.input);
    assert.equal(result.ok, true); assert.equal(result.clerkRoute.model, expected);
    assert.equal(h.calls[0].model, expected);
    if (model === 'missing') assert.match(result.errors.join('; '), /configured clerk route/);
  }
});

test('clerk uses the current agent default selection when no clerk route is pinned', async () => {
  const h = harness([proposal()], { selection: { provider: 'q', model: 'alternate' } });
  const result = await runClerk(h.input);
  assert.deepEqual(result.clerkRoute, { provider: 'q', model: 'alternate' });
  assert.equal(h.calls[0].provider, 'q');
});

test('clerk with no available route falls back without dispatching the LLM', async () => {
  const h = harness([proposal()], { catalog: { providers: [] } });
  const result = await runClerk(h.input);
  assert.equal(result.fallback, true); assert.equal(h.calls.length, 0);
  assert.match(result.errors.join('; '), /MODEL_ROUTE_UNAVAILABLE/);
});

test('clerk records unavailable seat pins and uses resolver fallback instead of inventing availability', async () => {
  const config = configOf(); config.seats[0].model = { provider: 'p', model: 'missing' };
  const h = harness([proposal()], { config });
  const result = await runClerk(h.input);
  assert.equal(result.fallback, true);
  assert.equal(result.proposal.modelAssignment[0].model, 'standard');
  assert.equal(result.proposal.modelAssignment[0].assignmentReason, 'pin_unavailable_fallback');
  assert.match(result.errors.join('; '), /pinned seat route unavailable/);
});

test('clerk defaults omitted files to the snapshot and deduplicates requested paths', async () => {
  for (const [files, expected] of [[undefined, ['src/app.js', 'test/app.js']], [['src/app.js', 'src/app.js'], ['src/app.js']], [[], []]]) {
    const h = harness([proposal({ files })]);
    const result = await runClerk(h.input);
    assert.equal(result.ok, true); assert.deepEqual(result.proposal.files, expected);
  }
});

test('out-of-snapshot files are rejected and retried before fallback', async () => {
  const h = harness([proposal({ files: ['../../outside'] }), proposal()]);
  const result = await runClerk(h.input);
  assert.equal(result.ok, true); assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].messages[0].content[0].text, /path outside snapshot/);
});

test('provider exception and missing injected service return deterministic fallback', async () => {
  const h = harness([new Error('provider offline')]);
  const result = await runClerk(h.input);
  assert.equal(result.fallback, true); assert.match(result.errors.join('; '), /provider offline/);
  const missing = await runClerk({ ...h.input, config: configOf({ clerk: { model: { provider: 'p', model: 'standard' } } }),
    ctx: { get() { throw new Error('llm unavailable'); } } });
  assert.equal(missing.fallback, true); assert.match(missing.errors.join('; '), /llm unavailable/);
});

test('an already-aborted caller is not dispatched', async () => {
  const controller = new AbortController(); controller.abort();
  const h = harness([proposal()]);
  const result = await runClerk({ ...h.input, signal: controller.signal });
  assert.equal(result.fallback, true); assert.equal(h.calls.length, 0); assert.match(result.errors.join('; '), /ABORTED/);
});

test('flat route input is adapted to the M2a assignment resolver on fallback', async () => {
  const h = harness(['bad', 'bad']);
  const flat = routes.providers.flatMap(p => p.models.map(m => ({ provider: p.id, model: m.id })));
  const result = await runClerk({ ...h.input, routes: flat });
  assert.equal(result.fallback, true);
  assert.deepEqual(result.proposal.modelAssignment, resolveSeatModels(h.input.config, routes).assignments);
});
