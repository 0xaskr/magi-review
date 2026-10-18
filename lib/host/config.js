/** Profile configuration. Workspace data must not be passed as trusted overrides. */
export const DEFAULTS = deepFreeze({
  seats: ['architect', 'engineer', 'adversary'].map(id => ({ id, perspective: `builtin:${id}`, required: true })),
  clerk: {},
  modes: { default: 'council', quick: { seats: 3 }, council: { seats: 3 } },
  models: { defaultRoute: { provider: 'deepseek-official', model: 'deepseek-flash' }, fallbackOnError: true },
  discussion: { maxRounds: 3, onExhaustion: 'ask_human', extendByRounds: 2, humanConfirmationTimeoutMs: 300000, allowScripts: true },
  anonymity: { mode: 'until_verdict', revealInReport: true, auditLedger: true },
  policy: { approval: 'majority', blockingSeverity: 'high', escalateOnRisk: false },
  execution: { concurrency: 3, briefTimeoutMs: 240000, discussionRoundTimeoutMs: 180000, ballotTimeoutMs: 60000, totalTimeoutMs: 1800000, promptBudgetTokens: 16000, maxCostUsd: 0.5, cache: true },
  output: { detail: 'digest', exportMarkdownDir: null },
  security: { redactSecrets: true, allowThirdPartyProviders: true },
  tool: { enabled: true, name: 'magi_review' },
  command: { enabled: true, name: 'magi-review' },
  debug: { selftest: false },
});

function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child);
  return Object.freeze(value);
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const route = value => object(value) && nonempty(value.provider) && nonempty(value.model);
const size = value => [3, 5, 7].includes(value);
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

/** Invalid values fall back independently; an invalid seat roster falls back as a unit.
 * Unknown keys are ignored, never copied into configuration prototypes.
 * @returns {{config:object,warnings:string[],errors:string[]}}
 */
export function validateConfig(raw = {}) {
  const warnings = [], errors = [];
  if (!object(raw)) { errors.push('config must be an object'); raw = {}; }
  function merge(defaults, input, prefix = '') {
    const result = structuredClone(defaults);
    for (const [key, value] of Object.entries(input)) {
      const name = prefix + key;
      if (!Object.hasOwn(defaults, key)) {
        if (name === 'clerk.model' && route(value)) result.model = { provider: value.provider, model: value.model };
        else if (name === 'clerk.model') errors.push(`${name}: expected provider/model`);
        else warnings.push(`Ignored unknown configuration key: ${name}`);
        continue;
      }
      if (value === undefined) continue;
      if (object(defaults[key])) {
        if (object(value)) result[key] = merge(defaults[key], value, name + '.');
        else errors.push(`${name}: expected object`);
      } else result[key] = value;
    }
    return result;
  }
  const config = merge(DEFAULTS, raw);
  function check(name, valid) {
    const parts = name.split('.');
    const key = parts.pop();
    const parent = parts.reduce((v, p) => v[p], config);
    if (!valid(parent[key])) {
      errors.push(`${name}: invalid value; using default`);
      parent[key] = structuredClone(parts.reduce((v, p) => v[p], DEFAULTS)[key]);
    }
  }
  check('seats', seats => Array.isArray(seats) && size(seats.length)
    && seats.every(s => object(s) && nonempty(s.id) && nonempty(s.perspective)
      && (s.model === undefined || route(s.model)) && (s.required === undefined || typeof s.required === 'boolean'))
    && new Set(seats.map(s => s.id.trim())).size === seats.length);
  config.seats = config.seats.map(s => ({ id: s.id.trim(), perspective: s.perspective.trim(), required: s.required ?? true,
    ...(s.model ? { model: { provider: s.model.provider, model: s.model.model } } : {}) }));
  const enums = {
    'modes.default': ['council', 'quick'], 'policy.approval': ['majority', 'unanimous'],
    'policy.blockingSeverity': ['critical', 'high', 'medium'], 'discussion.onExhaustion': ['ask_human', 'proceed'],
    'anonymity.mode': ['until_verdict'], 'output.detail': ['digest', 'full'],
  };
  for (const [name, values] of Object.entries(enums)) check(name, v => values.includes(v));
  for (const mode of ['quick', 'council']) check(`modes.${mode}.seats`, size);
  check('execution.concurrency', v => integer(v, 1, 8));
  check('execution.promptBudgetTokens', v => integer(v, 1, 2147483647));
  check('discussion.maxRounds', v => integer(v, 1, 5));
  check('discussion.extendByRounds', v => integer(v, 1, 5));
  for (const key of ['briefTimeoutMs', 'discussionRoundTimeoutMs', 'ballotTimeoutMs', 'totalTimeoutMs']) {
    check(`execution.${key}`, v => integer(v, 1, 2147483647));
  }
  check('discussion.humanConfirmationTimeoutMs', v => integer(v, 1, 2147483647));
  check('execution.maxCostUsd', v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  for (const name of ['models.fallbackOnError', 'discussion.allowScripts', 'anonymity.revealInReport', 'anonymity.auditLedger',
    'policy.escalateOnRisk', 'execution.cache', 'security.redactSecrets', 'security.allowThirdPartyProviders',
    'tool.enabled', 'command.enabled', 'debug.selftest']) check(name, v => typeof v === 'boolean');
  for (const name of ['models.defaultRoute.provider', 'models.defaultRoute.model', 'tool.name', 'command.name']) check(name, nonempty);
  check('output.exportMarkdownDir', v => v === null || nonempty(v));
  return { config, warnings, errors };
}

export function normalizeConfig(raw) { return validateConfig(raw).config; }

export function isFirstPartyProvider(provider) {
  return typeof provider === 'string' && provider.startsWith('deepseek-');
}

const providerAllowed = (config, provider) => config.security.allowThirdPartyProviders || isFirstPartyProvider(provider);
function allowedRoutes(config, routeInfo) {
  return (routeInfo?.providers ?? []).flatMap(p => (p.models ?? []).map(m => ({ provider: p.id, model: m.id })))
    .filter(r => route(r) && providerAllowed(config, r.provider));
}
function defaultRouteFor(config, routes) {
  return routes.find(r => r.provider === config.models.defaultRoute.provider && r.model === config.models.defaultRoute.model)
    ?? routes[0]
    // With provider restrictions, an empty allowed catalog must fail closed.
    ?? (config.security.allowThirdPartyProviders ? config.models.defaultRoute : undefined);
}

/** Pure catalog/default selection, subject to the same provider policy as seats.
 * An undefined route means the caller must degrade without making a model call.
 */
export function resolveDefaultRoute(raw, routeInfo) {
  const config = normalizeConfig(raw);
  return defaultRouteFor(config, allowedRoutes(config, routeInfo));
}

/** Catalog visibility is not a credential/reachability check. */
export function resolveSeatModels(raw, routeInfo) {
  const config = normalizeConfig(raw);
  const routes = allowedRoutes(config, routeInfo);
  const warnings = config.seats.filter(seat => seat.model && !providerAllowed(config, seat.model.provider))
    .map(seat => `pin_disallowed:${seat.id}:${seat.model.provider}`);
  const pinned = config.seats.some(seat => seat.model && providerAllowed(config, seat.model.provider));
  const find = wanted => routes.find(r => r.provider === wanted?.provider && r.model === wanted?.model);
  const defaultRoute = defaultRouteFor(config, routes);
  if (!defaultRoute) return { assignments: [], homogeneous: true, pinned, warnings, errors: ['no_allowed_providers'] };
  const assignments = config.seats.map(seat => {
    const pinnedRoute = find(seat.model);
    const selected = pinnedRoute ?? defaultRoute;
    const assignmentReason = pinnedRoute ? 'explicit_pin' : seat.model ? 'pin_unavailable_fallback'
      : !routes.length ? 'routes_unavailable_default_fallback' : find(config.models.defaultRoute) ? 'default_route' : 'first_available_route';
    return { seatId: seat.id, perspective: seat.perspective, ...selected, assignmentReason,
      ...(!routes.length ? { available: false, fallback: true } : {}) };
  });
  const adversary = config.seats.findIndex(s => s.id === 'adversary' || s.perspective === 'builtin:adversary');
  if (adversary >= 0 && (!config.seats[adversary].model || !providerAllowed(config, config.seats[adversary].model.provider))) {
    const others = new Set(assignments.filter((_, i) => i !== adversary).map(a => a.model));
    // Catalogs carry no reliable prices. A zero budget forbids calls; otherwise
    // prefer model diversity without inventing cost or strength metadata.
    const alternate = config.execution.maxCostUsd > 0 && routes.find(r => r.model !== defaultRoute.model && !others.has(r.model));
    if (alternate) Object.assign(assignments[adversary], alternate, { assignmentReason: 'adversary_model_diversity' });
  }
  return { assignments, homogeneous: new Set(assignments.map(a => a.model)).size <= 1,
    pinned, warnings, errors: [] };
}

/** The catalog has no dependable cost/capacity metadata; do not infer a budget from it. */
export function resolveExecution(config, _routeInfo) { return normalizeConfig(config).execution; }
export function resolveDetail(config, args = {}) {
  return ['digest', 'full'].includes(args?.detail) ? args.detail : normalizeConfig(config).output.detail;
}
