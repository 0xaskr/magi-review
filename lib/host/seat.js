import { extractJson } from '../core/json.js';
import { toReviewError } from './errors.js';

/** One activation per stage; caller delivery prevents parent completion notices.
 * cleanup is completed/failed/pending/not_started. A late start is disposed too.
 */
export async function runSeatTurn(subagents, { parentAgent, cwd, preset, provider, model, prompt, outputSchema,
  timeoutMs = 120000, signal, label } = {}) {
  const started = Date.now(), controller = new AbortController();
  let activation, timer, abortCode, rejectAbort, disposePromise, cleanup = 'not_started';
  const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
  const dispose = () => {
    if (!activation) return Promise.resolve();
    if (!disposePromise) {
      cleanup = 'pending';
      disposePromise = Promise.resolve().then(() => activation.dispose()).then(() => { cleanup = 'completed'; }, () => { cleanup = 'failed'; });
    }
    return disposePromise;
  };
  const abort = code => {
    if (abortCode) return;
    abortCode = code;
    const error = Object.assign(new Error(code === 'REVIEWER_TIMEOUT' ? 'Reviewer timed out' : 'Reviewer aborted'), { code });
    controller.abort(error);
    rejectAbort(error);
    void dispose();
  };
  const onAbort = () => abort('REVIEWER_ABORTED');
  let outcome;
  try {
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    timer = setTimeout(() => abort('REVIEWER_TIMEOUT'), Math.max(0, timeoutMs));
    const work = async () => {
      if (abortCode) throw controller.signal.reason;
      activation = await subagents.startActivation({ provider: 'spawn', label,
        request: { parent: parentAgent, agentPreset: preset, agentOptions: { provider, model },
          prompt: [{ type: 'text', text: prompt }], ...(cwd ? { cwd } : {}), ...(outputSchema ? { outputSchema } : {}) },
        signal: controller.signal, delivery: 'caller' });
      // Always consume a rejection, even if activation was published after cancellation.
      const resultPromise = Promise.resolve(activation.result);
      resultPromise.catch(() => {});
      if (abortCode) { void dispose(); throw controller.signal.reason; }
      const result = await resultPromise;
      const text = (result.output ?? []).filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n');
      const common = { text, ...(result.structured !== undefined ? { structured: result.structured } : {}), stopReason: result.stopReason };
      return result.stopReason === 'completed' ? { ok: true, ...common }
        : { ok: false, ...common, error: { ...toReviewError(`Reviewer stopped: ${result.stopReason}`, { stage: 'reviewer', code: 'REVIEWER_ERROR' }), stopReason: result.stopReason } };
    };
    outcome = await Promise.race([work(), interrupted]);
    await Promise.race([dispose(), interrupted]);
  } catch (error) {
    outcome = { ok: false, text: outcome?.text ?? '', error: toReviewError(error, { stage: 'reviewer', code: abortCode ?? 'REVIEWER_ERROR' }) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    // Bound cancellation cleanup too: a broken runtime disposer must not hang the host.
    let cleanupTimer;
    await Promise.race([dispose(), new Promise(resolve => { cleanupTimer = setTimeout(resolve, Math.min(1000, Math.max(1, timeoutMs))); })]);
    clearTimeout(cleanupTimer);
  }
  return { ...outcome, childId: activation?.childId, durationMs: Date.now() - started, cleanup };
}

export function extractProtocol(result) { return result?.structured ?? extractJson(result?.text); }
