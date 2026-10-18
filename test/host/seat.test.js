import test from 'node:test';
import assert from 'node:assert/strict';
import { runSeatTurn, extractProtocol } from '../../lib/host/seat.js';

const options = { parentAgent: { id: 'parent' }, preset: 'readonly', provider: 'p', model: 'm', prompt: 'review', timeoutMs: 1000, label: 'A' };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('seat activation uses caller delivery and returns text, structured and child identity', async () => {
  let disposed = 0, received;
  const subagents = { startActivation(args) { received = args; return { childId: 'child', result: Promise.resolve({ stopReason: 'completed',
    output: [{ type: 'text', text: 'first' }, { type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'last' }], structured: { ok: true } }), dispose: async () => { disposed++; } }; } };
  const outputSchema = { type: 'object' };
  const result = await runSeatTurn(subagents, { ...options, cwd: '/workspace', outputSchema });
  assert.equal(received.provider, 'spawn');
  assert.equal(received.delivery, 'caller');
  assert.deepEqual(received.request, { parent: options.parentAgent, agentPreset: 'readonly', agentOptions: { provider: 'p', model: 'm' },
    prompt: [{ type: 'text', text: 'review' }], cwd: '/workspace', outputSchema });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'first\nlast');
  assert.deepEqual(result.structured, { ok: true });
  assert.equal(result.childId, 'child');
  assert.equal(result.cleanup, 'completed');
  assert.equal(disposed, 1);
  assert.deepEqual(extractProtocol(result), { ok: true });
  assert.deepEqual(extractProtocol({ text: '```json\n{"vote":"approve"}\n```' }), { vote: 'approve' });
  assert.equal(extractProtocol({ text: 'invalid' }), null);
});

test('timeouts and external abort dispose and preserve childId', async () => {
  for (const abort of [false, true]) {
    let disposed = 0, childSignal;
    const controller = new AbortController();
    const subagents = { startActivation(args) {
      childSignal = args.signal;
      assert.equal(Object.hasOwn(args.request, 'cwd'), false);
      return { childId: 'slow', result: new Promise(() => {}), dispose() { disposed++; } };
    } };
    const pending = runSeatTurn(subagents, { ...options, timeoutMs: abort ? 1000 : 15, signal: controller.signal });
    if (abort) controller.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error.code, abort ? 'REVIEWER_ABORTED' : 'REVIEWER_TIMEOUT');
    assert.equal(result.childId, 'slow');
    assert.equal(childSignal.aborted, true);
    assert.equal(disposed, 1);
  }
});

test('every non-completed stop is a reviewer error and disposal failure is recorded', async () => {
  for (const stopReason of ['aborted', 'error', 'max-tokens', 'refusal']) {
    const result = await runSeatTurn({ startActivation: () => ({ childId: 'failed', result: Promise.resolve({ output: [], stopReason }), dispose() { throw Error('cleanup'); } }) }, options);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'REVIEWER_ERROR');
    assert.equal(result.error.stopReason, stopReason);
    assert.equal(result.cleanup, 'failed');
    assert.equal(result.childId, 'failed');
  }
  const rejected = await runSeatTurn({ startActivation: () => ({ childId: 'rejected', result: Promise.reject(Error('provider')), dispose() {} }) }, options);
  assert.equal(rejected.error.code, 'REVIEWER_ERROR');
  assert.equal(rejected.childId, 'rejected');
});

test('late activations are disposed; pre-abort does not start work; stuck cleanup is bounded', async () => {
  const late = deferred(), cleaned = deferred();
  const result = await runSeatTurn({ startActivation: () => late.promise }, { ...options, timeoutMs: 15 });
  assert.equal(result.error.code, 'REVIEWER_TIMEOUT');
  assert.ok(Object.hasOwn(result, 'childId'));
  late.resolve({ childId: 'late', result: Promise.reject(Error('late rejection')), dispose: () => cleaned.resolve() });
  await cleaned.promise;
  const controller = new AbortController(); controller.abort();
  const preaborted = await runSeatTurn({ startActivation() { assert.fail('must not start'); } }, { ...options, signal: controller.signal });
  assert.equal(preaborted.error.code, 'REVIEWER_ABORTED');
  const stuck = await runSeatTurn({ startActivation: () => ({ childId: 'stuck', result: new Promise(() => {}), dispose: () => new Promise(() => {}) }) }, { ...options, timeoutMs: 15 });
  assert.equal(stuck.cleanup, 'pending');
  assert.equal(stuck.error.code, 'REVIEWER_TIMEOUT');
});
