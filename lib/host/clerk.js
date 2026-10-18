import { resolveSeatModels } from './config.js';
import { callLlmJsonValidated, resolveDefaultRoute } from './llm-json.js';
import { buildClerkPrompt, createNonce } from './prompts.js';
import { summarizeErrors, validateClerkProposal } from './protocol.js';

export const clerkFallbackDegraded = 'clerk_fallback';

function routeCatalog(routes) {
  if (!Array.isArray(routes)) return routes ?? { providers: [] };
  const providers = new Map();
  for (const route of routes.filter(r => r?.available !== false)) {
    if (!providers.has(route.provider)) providers.set(route.provider, { id: route.provider, models: [] });
    providers.get(route.provider).models.push({ id: route.model });
  }
  return { providers: [...providers.values()] };
}

/** All host services and the model stream are injected via ctx. No DSH runtime,
 * filesystem access, workspace changes or agent lifecycle belongs to the clerk.
 * ok=false denotes fallback even when the deterministic proposal is usable.
 */
export async function runClerk({ ctx, config, routes, snapshot, intent, args = {}, signal }) {
  const started = Date.now(), errors = [], catalog = routeCatalog(routes);
  const available = (catalog.providers ?? []).filter(p => p.available !== false).flatMap(p => (p.models ?? [])
    .filter(m => m.available !== false).map(m => ({ provider: p.id, model: m.id })));
  const isAvailable = route => available.some(r => r.provider === route?.provider && r.model === route?.model);
  const seatIds = config.seats.map(s => s.id);
  let clerkRoute;
  const finish = (ok, proposal) => ({ ok, proposal, clerkRoute, fallback: !ok, errors, durationMs: Math.max(0, Date.now() - started) });
  const fallback = () => finish(false, {
    targetKind: snapshot.kind, files: snapshot.files.map(f => f.path),
    rationale: 'clerk_fallback: ' + summarizeErrors(errors), confidence: 'low',
    intent: structuredClone(intent), modelAssignment: resolveSeatModels(config, catalog).assignments,
  });
  try {
    if (signal?.aborted) { errors.push('CLERK_ABORTED: caller signal is aborted'); return fallback(); }
    if (isAvailable(config.clerk?.model)) clerkRoute = { provider: config.clerk.model.provider, model: config.clerk.model.model };
    else {
      if (config.clerk?.model) errors.push('MODEL_ROUTE_UNAVAILABLE: configured clerk route; using default route');
      clerkRoute = await resolveDefaultRoute(ctx);
    }
    if (!isAvailable(clerkRoute)) { errors.push('MODEL_ROUTE_UNAVAILABLE: clerk route is not in the available catalog'); return fallback(); }
    const prompt = buildClerkPrompt({ snapshot, intent, routes: catalog, seats: config.seats, args, config, nonce: createNonce() });
    const checked = value => validateClerkProposal(value, { routes: catalog, seatIds, snapshot });
    const result = await callLlmJsonValidated(ctx.get('llm'), { ...clerkRoute, ...prompt, maxTokens: 1500, temperature: 0 },
      { validate: checked, retries: 1, signal, timeoutMs: 60000 });
    if (!result.ok) {
      errors.push(summarizeErrors(result.errors ?? [result.error ?? 'Invalid clerk response']));
      return fallback();
    }
    // M2a returns parsed raw JSON, not validate().value; normalize again explicitly.
    const normalized = checked(result.value);
    if (!normalized.ok) { errors.push(...normalized.errors); return fallback(); }
    const proposal = normalized.value;
    const requested = typeof args.target === 'object' ? args.target?.kind : args.target;
    const allowedTarget = requested && requested !== 'auto' ? requested : snapshot.kind;
    if (proposal.targetKind !== allowedTarget || proposal.targetKind !== snapshot.kind) {
      errors.push('targetKind: outside the frozen target candidate; corrected to snapshot.kind');
      proposal.targetKind = snapshot.kind;
    }
    const paths = new Set(snapshot.files.map(f => f.path));
    proposal.files = [...new Set((proposal.files ?? [...paths]).filter(path => paths.has(path)))];
    for (const assignment of proposal.modelAssignment) {
      const pin = config.seats.find(s => s.id === assignment.seatId)?.model;
      if (!pin || assignment.provider === pin.provider && assignment.model === pin.model) continue;
      if (!isAvailable(pin)) {
        errors.push('MODEL_ROUTE_UNAVAILABLE: pinned seat route unavailable');
        return fallback();
      }
      errors.push('modelAssignment: corrected pinned route for ' + assignment.seatId);
      Object.assign(assignment, { provider: pin.provider, model: pin.model, assignmentReason: 'explicit_pin' });
    }
    return finish(true, proposal);
  } catch (error) {
    errors.push(summarizeErrors([error]));
    return fallback();
  }
}
