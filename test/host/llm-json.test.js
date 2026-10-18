import test from 'node:test';
import assert from 'node:assert/strict';
import { listAvailableRoutes, resolveDefaultRoute, callLlmJson, callLlmJsonValidated, estimateTokens } from '../../lib/host/llm-json.js';

const request = { provider: 'p', model: 'm', system: 'system', user: 'task' };
const routes = { listProviders: () => [{ id: 'p', name: 'Provider' }, { id: 'broken' }], listModels: id => {
  if (id === 'broken') throw Error('catalog offline');
  return [{ id: 'm', name: 'Model' }];
} };

test('route discovery isolates provider failures and validates default selections', async () => {
  const result = await listAvailableRoutes(routes);
  assert.equal(result.providers.length, 2);
  assert.deepEqual(result.providers[0].models, [{ id: 'm', name: 'Model' }]);
  assert.deepEqual(result.providers[1].models, []);
  assert.equal(result.errors.length, 1);
  const ctx = { get: name => name === 'llm' ? routes : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'missing', model: 'not-real' }) } : undefined };
  assert.deepEqual(await resolveDefaultRoute(ctx, { models: { defaultRoute: { provider: 'p', model: 'm' } } }), { provider: 'p', model: 'm' });
  assert.deepEqual(await resolveDefaultRoute({ get() { throw Error('missing'); } }), { provider: 'deepseek-official', model: 'deepseek-flash' });
  assert.equal((await listAvailableRoutes(null)).errors.length, 1);
});

test('get-only Cordis context resolves explicit config and supports both JSON call paths', async () => {
  const llm = { listProviders: () => [{ id: 'p' }], listModels: () => [{ id: 'first' }, { id: 'configured' }, { id: 'selected' }],
    async *stream(args) { assert.equal(args.model, 'configured'); yield { type: 'text-delta', text: '{"ok":true}' }; } };
  let selection;
  const ctx = new Proxy({ get(name) {
    assert.ok(['llm', 'agentDefaultModel'].includes(name));
    return name === 'llm' ? llm : { currentSelection: () => selection };
  } }, { get(target, key) { if (key !== 'get') throw Error(`cannot get property ${String(key)} without inject`); return target[key]; } });
  const config = { models: { defaultRoute: { provider: 'p', model: 'configured' } } };
  const route = await resolveDefaultRoute(ctx, config);
  assert.deepEqual(route, config.models.defaultRoute);
  assert.equal((await callLlmJson(ctx.get('llm'), { ...request, ...route })).ok, true);
  assert.deepEqual((await callLlmJsonValidated(ctx.get('llm'), { ...request, ...route })).value, { ok: true });
  selection = { provider: 'p', model: 'selected' };
  assert.deepEqual(await resolveDefaultRoute(ctx, config), selection);
});

test('stream collector accumulates only text, usage and finish with the expected request', async () => {
  const llm = { async *stream(args) {
    assert.deepEqual(args.messages, [{ role: 'user', content: [{ type: 'text', text: 'task' }] }]);
    assert.equal(args.system, 'system');
    assert.equal(args.maxTokens, 2000);
    assert.equal(args.temperature, 0);
    assert.ok(args.signal instanceof AbortSignal);
    yield { type: 'reasoning-delta', text: 'private' };
    yield { type: 'text-delta', text: '{"ok":' };
    yield { type: 'text-delta', text: 'true}' };
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 3 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const result = await callLlmJson(llm, request);
  assert.equal(result.ok, true);
  assert.equal(result.text, '{"ok":true}');
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 3 });
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.attempts, 1);
  assert.equal(estimateTokens('abcd'), 2);
  assert.equal(estimateTokens(''), 0);
});

test('JSON extraction and validation failures trigger one corrective retry', async () => {
  const prompts = [];
  const llm = { async *stream(args) {
    prompts.push(args.messages[0].content[0].text);
    yield { type: 'text-delta', text: prompts.length === 1 ? '```json\n{"count":0}\n```' : '```json\n{"count":2}\n```' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const result = await callLlmJsonValidated(llm, request, { validate: v => ({ valid: v.count > 0, errors: v.count > 0 ? [] : ['count must be positive'] }) });
  assert.deepEqual(result.value, { count: 2 });
  assert.equal(result.attempts, 2);
  assert.equal(result.finishReason, 'stop');
  assert.match(prompts[1], /count must be positive/);
  assert.equal(request.user, 'task');
  const invalid = await callLlmJsonValidated({ async *stream() { yield { type: 'text-delta', text: 'not JSON' }; } }, request);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.attempts, 2);
  assert.equal(invalid.error.code, 'LLM_OUTPUT_INVALID');
});

test('deadline and caller abort finish even if the provider ignores its signal', async () => {
  let signal;
  const llm = { stream(args) { signal = args.signal; return { [Symbol.asyncIterator]() { return this; }, next() { return new Promise(() => {}); }, return() { return new Promise(() => {}); } }; } };
  const timeout = await callLlmJson(llm, request, { timeoutMs: 15 });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.code, 'LLM_TIMEOUT');
  assert.equal(timeout.attempts, 1);
  assert.equal(signal.aborted, true);
  const controller = new AbortController();
  const pending = callLlmJson(llm, request, { timeoutMs: 1000, signal: controller.signal });
  controller.abort();
  assert.equal((await pending).error.code, 'LLM_ABORTED');
  const preaborted = await callLlmJson({ stream() { assert.fail('must not dispatch'); } }, request, { signal: controller.signal });
  assert.equal(preaborted.code, 'LLM_ABORTED');
});

test('error and aborted finish reasons are failures, without schema retries', async () => {
  for (const kind of ['error', 'aborted']) {
    let calls = 0;
    const llm = { async *stream() { calls++; yield { type: 'finish', reason: { kind, message: 'upstream stopped' } }; } };
    const result = await callLlmJsonValidated(llm, { ...request, stage: 'minutes' });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1);
    assert.equal(result.finishReason, kind);
    assert.equal(calls, 1);
    assert.equal(result.error.stage, 'minutes');
    assert.equal(result.error.code, kind === 'error' ? 'LLM_ERROR' : 'LLM_ABORTED');
  }
  assert.equal((await callLlmJson({ stream() { throw Error('network down'); } }, request)).error.code, 'LLM_ERROR');
});

test('validated failures retain the last finish kind and usage from all attempts', async () => {
  let calls = 0;
  const result = await callLlmJsonValidated({ async *stream() {
    calls++;
    yield { type: 'text-delta', text: 'not JSON' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } };
    yield { type: 'finish', reason: calls === 1 ? 'stop' : { kind: 'max-tokens', message: 'private provider diagnostics' } };
  } }, { ...request, stage: 'minutes' });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'LLM_OUTPUT_INVALID');
  assert.equal(result.attempts, 2); assert.equal(result.finishReason, 'max-tokens');
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 4 });
  assert.doesNotMatch(JSON.stringify(result), /private provider/);
});

test('a stream factory resolving after timeout closes its iterator without dispatching next', async () => {
  let publish, closed;
  const cleanup = new Promise(resolve => { closed = resolve; });
  const result = await callLlmJson({ stream: () => new Promise(resolve => { publish = resolve; }) }, request, { timeoutMs: 15 });
  assert.equal(result.code, 'LLM_TIMEOUT');
  publish({ [Symbol.asyncIterator]() { return this; }, next() { assert.fail('late stream must not be consumed'); }, return: () => { closed(); return { done: true }; } });
  await cleanup;
});
