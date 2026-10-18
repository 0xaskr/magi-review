import { extractJson } from '../core/json.js';
import { DEFAULTS, normalizeConfig, isFirstPartyProvider } from './config.js';
import { toReviewError } from './errors.js';

export async function listAvailableRoutes(llm) {
  const providers = [], errors = [];
  try {
    const listed = await llm.listProviders();
    for (const provider of listed) {
      if (typeof provider?.id !== 'string') continue;
      const entry = { id: provider.id, name: provider.name ?? provider.id, models: [] };
      try {
        entry.models = (await llm.listModels(provider.id)).filter(m => typeof m?.id === 'string')
          .map(m => ({ id: m.id, name: m.name ?? m.id }));
      } catch (error) { errors.push({ ...toReviewError(error, { stage: 'config', code: 'MODEL_ROUTE_UNAVAILABLE' }), provider: provider.id }); }
      providers.push(entry);
    }
  } catch (error) { errors.push(toReviewError(error, { stage: 'config', code: 'MODEL_ROUTE_UNAVAILABLE' })); }
  return { providers, errors };
}

function service(ctx, name) { try { return ctx?.get?.(name); } catch { return undefined; } }
/** Configuration is explicit: Cordis contexts forbid undeclared property access. */
export async function resolveDefaultRoute(ctx, config) {
  const routes = await listAvailableRoutes(service(ctx, 'llm'));
  const normalized = normalizeConfig(config), configured = normalized.models.defaultRoute;
  let selection;
  try { selection = await service(ctx, 'agentDefaultModel')?.currentSelection?.(); } catch { /* optional service */ }
  const candidates = [selection, configured, DEFAULTS.models.defaultRoute];
  const available = routes.providers.filter(p => normalized.security.allowThirdPartyProviders || isFirstPartyProvider(p.id))
    .flatMap(p => p.models.map(m => ({ provider: p.id, model: m.id })));
  for (const candidate of candidates) {
    const found = available.find(r => r.provider === candidate?.provider && r.model === candidate?.model);
    if (found) return found;
  }
  // An empty catalog is not proof of a working route. Seat assignment marks this fallback.
  return available[0] ?? { ...(normalized.security.allowThirdPartyProviders || isFirstPartyProvider(configured.provider)
    ? configured : DEFAULTS.models.defaultRoute) };
}

/** Collect one streaming call, enforcing deadlines even on noncooperative iterators.
 * request.stage may select 'minutes'; the default error stage is 'clerk'.
 */
export async function callLlmJson(llm, request, { signal, timeoutMs = 120000 } = {}) {
  const controller = new AbortController();
  const stage = request?.stage === 'minutes' ? 'minutes' : 'clerk';
  let timer, abortCode, rejectAbort, iterator;
  let text = '', usage, finishReason = 'unknown';
  const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = code => {
    if (abortCode) return;
    abortCode = code;
    const error = Object.assign(new Error(code === 'LLM_TIMEOUT' ? 'LLM call timed out' : 'LLM call aborted'), { code });
    controller.abort(error);
    rejectAbort(error);
  };
  const onAbort = () => abort('LLM_ABORTED');
  try {
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    timer = setTimeout(() => abort('LLM_TIMEOUT'), Math.max(0, timeoutMs));
    const collect = async () => {
      if (abortCode) throw controller.signal.reason;
      const stream = await llm.stream({ provider: request.provider, model: request.model, system: request.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: request.user }] }],
        maxTokens: request.maxTokens ?? 2000, temperature: request.temperature ?? 0,
        ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}), signal: controller.signal });
      iterator = stream[Symbol.asyncIterator]();
      if (abortCode) {
        // A stream factory can settle after the outer deadline and its finally.
        try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* best effort */ }
        throw controller.signal.reason;
      }
      while (!controller.signal.aborted) {
        const { value: chunk, done } = await iterator.next();
        if (done) break;
        if (chunk?.type === 'text-delta') text += chunk.text ?? '';
        if (chunk?.type === 'usage') usage = chunk.usage;
        if (chunk?.type === 'finish') {
          const kind = chunk.reason?.kind ?? chunk.reason;
          finishReason = typeof kind === 'string' ? kind : 'unknown';
          if (kind === 'error' || kind === 'aborted') throw Object.assign(new Error(chunk.reason?.message ?? `LLM finished: ${kind}`), {
            code: kind === 'error' ? 'LLM_ERROR' : 'LLM_ABORTED',
          });
          break;
        }
      }
      if (abortCode) throw controller.signal.reason;
      return { ok: true, text, usage, finishReason, attempts: 1 };
    };
    return await Promise.race([collect(), interrupted]);
  } catch (error) {
    const code = abortCode ?? (error?.code === 'LLM_ABORTED' || error?.name === 'AbortError' ? 'LLM_ABORTED' : 'LLM_ERROR');
    return { ok: false, code, text, usage, finishReason, attempts: 1, error: toReviewError(error, { stage, code }) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    // return() can itself hang while a provider is stuck in next(); never extend the deadline.
    try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* best effort */ }
  }
}

/** Validators may return boolean, an errors array, {ok|valid|success, errors}, or
 * throw. A void return is accepted for assertion-style validators.
 */
export async function callLlmJsonValidated(llm, request, { validate, retries = 1, signal, timeoutMs } = {}) {
  let raw = '', error, finishReason;
  const usage = {};
  const count = Number.isInteger(retries) && retries >= 0 ? retries + 1 : 2;
  let next = { ...request };
  for (let attempts = 1; attempts <= count; attempts++) {
    const result = await callLlmJson(llm, next, { signal, timeoutMs });
    raw = result.text ?? '';
    finishReason = result.finishReason;
    for (const key of ['inputTokens', 'outputTokens', 'estimatedCostUsd']) {
      if (Number.isFinite(result.usage?.[key]) && result.usage[key] >= 0) usage[key] = (usage[key] ?? 0) + result.usage[key];
    }
    if (!result.ok) return { ok: false, raw, attempts, finishReason, usage, error: result.error };
    const value = extractJson(raw);
    try {
      if (value === null) throw new Error('Expected a JSON object');
      const verdict = validate ? await validate(value) : true;
      if (verdict === false || Array.isArray(verdict) && verdict.length > 0
        || verdict?.ok === false || verdict?.valid === false || verdict?.success === false || verdict?.errors?.length) {
        throw new Error(JSON.stringify(verdict?.errors ?? verdict));
      }
      return { ok: true, value, raw, attempts, finishReason, usage };
    } catch (cause) {
      error = toReviewError(cause, { stage: request.stage === 'minutes' ? 'minutes' : 'clerk', code: 'LLM_OUTPUT_INVALID' });
      next = { ...request, user: `${request.user}\n\nThe previous response failed JSON validation: ${error.message.slice(0, 2000)}\nReturn a corrected JSON object matching the requested schema.` };
    }
  }
  return { ok: false, raw, attempts: count, finishReason, usage, error };
}

export function estimateTokens(text) { return Math.ceil(String(text ?? '').length / 3); }
