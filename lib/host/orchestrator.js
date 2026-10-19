import { normalizeConfig, validateConfig, resolveSeatModels, resolveExecution, isFirstPartyProvider } from './config.js';
import { snapshotReview } from './git.js';
import { buildIntentContext, lastTurnWindow, latestWorkspaceChangesSeq } from './session-context.js';
import { listAvailableRoutes, resolveDefaultRoute } from './llm-json.js';
import { createStore } from './store.js';
import { captureWorkspaceState, detectWorkspaceMutation } from './guard.js';
import { runClerk } from './clerk.js';
import { toReviewError } from './errors.js';
import { runCouncil, bounded, reviewDeadline, service, now } from './council.js';
import { runQuick } from './quick.js';
import { budgetSnapshot } from './prompts.js';
import { buildDigest } from '../core/digest.js';
import { redactSecrets } from '../core/redact.js';
import { parseUnifiedDiff } from '../core/canonical-diff.js';
import { assessRisk } from '../core/risk.js';
import { buildTemplateMinutes } from '../core/minutes-template.js';
import { makeError } from '../core/error-codes.js';

const targets = ['auto', 'turn', 'working-tree', 'staged', 'base-ref', 'patch'];
const defaults = { normalizeConfig, validateConfig, resolveSeatModels, resolveExecution, snapshotReview,
  buildIntentContext, lastTurnWindow, latestWorkspaceChangesSeq, listAvailableRoutes, resolveDefaultRoute,
  createStore, captureWorkspaceState, detectWorkspaceMutation, runClerk, runCouncil, runQuick, toReviewError };

function validateArgs(args) {
  if (args.mode !== undefined && !['quick', 'council'].includes(args.mode)) throw new Error('mode must be quick or council');
  if (args.target !== undefined && !targets.includes(args.target)) throw new Error('Invalid target');
  if (args.seats !== undefined && ![3, 5, 7].includes(args.seats)) throw new Error('seats must be 3, 5, or 7');
  for (const name of ['base', 'patch', 'cwd']) if (args[name] !== undefined && typeof args[name] !== 'string') throw new Error(`${name} must be a string`);
  for (const name of ['paths', 'focus']) if (args[name] !== undefined && (!Array.isArray(args[name]) || args[name].some(s => typeof s !== 'string'))) throw new Error(`${name} must be a string array`);
  if (args.detail !== undefined && !['digest', 'full'].includes(args.detail)) throw new Error('Invalid detail');
  if (args.target === 'patch' && typeof args.patch !== 'string') throw new Error('target=patch requires patch text');
  if (args.target === 'base-ref' && !args.base?.trim()) throw new Error('base-ref requires base');
}

function catalog(routes) {
  if (!Array.isArray(routes)) return routes;
  const providers = new Map();
  for (const route of routes.filter(r => r.available !== false)) {
    if (!providers.has(route.provider)) providers.set(route.provider, { id: route.provider, models: [] });
    providers.get(route.provider).models.push({ id: route.model });
  }
  return { providers: [...providers.values()] };
}

function assignmentsFor(config, routes, proposal, resolve) {
  const routeInfo = catalog(routes);
  // Treat a valid proposal as a temporary pin; the actual profile pin wins first.
  const proposed = resolve({ ...config, seats: config.seats.map(s => {
    const choice = proposal.modelAssignment?.find(a => a.seatId === s.id);
    return { ...s, ...(s.model ? {} : choice ? { model: { provider: choice.provider, model: choice.model } } : {}) };
  }) }, routeInfo).assignments;
  const fallback = resolve(config, routeInfo).assignments;
  return proposed.map((a, i) => {
    const seat = config.seats[i], choice = proposal.modelAssignment?.find(p => p.seatId === seat.id);
    let selected = a;
    if (!seat.model && (seat.id === 'adversary' || seat.perspective === 'builtin:adversary')
      && proposed.every(p => p.model === a.model) && fallback[i]?.model !== a.model) selected = fallback[i] ?? a;
    return { ...selected, fallback: selected.fallback === true || /fallback/.test(selected.assignmentReason),
      assignmentReason: seat.model ? selected.assignmentReason : selected.provider === choice?.provider && selected.model === choice?.model
        ? choice.assignmentReason ?? 'clerk_assignment' : selected.assignmentReason };
  });
}

/** Degrade after the reveal (guard/storage/minutes); retain the rule verdict unless explicitly unsafe. */
export function degradeResult(result, reason, { unsafe = false } = {}) {
  result.degradedReasons = [...new Set([...(result.degradedReasons ?? result.digest?.degradedReasons ?? []), reason])];
  if (result.decision.status !== 'error') {
    result.decision.status = 'degraded'; result.decision.trust = 'needs_review';
    if (unsafe && result.decision.verdict === 'approve') {
      result.decision.verdict = 'insufficient';
      result.decision.rationale += ` ${reason}: approval withheld.`;
      result.decision.dissent = result.ballots.filter(b => b.finalVerdict).map(b => ({ seatRef: b.seatRef,
        verdict: b.finalVerdict, reason: b.changeReason ?? b.finalFindings?.map(f => f.rationale).join('\n') ?? '' }));
      if (result.minutes) result.minutes = buildTemplateMinutes(result);
    }
  }
  result.digest = buildDigest(result);
}

/** All I/O is injectable. Expected operational failures return values, never reject. */
export async function runReview({ ctx, agent, args = {}, signal, deps = {} } = {}) {
  const d = { ...defaults, ...deps.git, ...deps.guard, ...deps };
  const core = { buildDigest, redactSecrets, parseUnifiedDiff, assessRisk, ...deps.core };
  let deadline, result, stage = 'input';
  try {
    validateArgs(args);
    const invokedAs = (args.__invokedAs ?? deps.invokedAs) === 'command' ? 'command' : 'tool';
    stage = 'config';
    const raw = deps.configRaw ?? deps.config ?? {};
    const config = d.normalizeConfig(raw), validation = d.validateConfig(raw);
    if (validation.errors?.length) return { ok: false, error: makeError('config', 'CONFIG_INVALID', validation.errors.join('; ')) };
    // The frozen config normalizer still supplies the legacy five-minute default.
    config.discussion.humanConfirmationTimeoutMs = raw.discussion?.humanConfirmationTimeoutMs ?? 120000;
    const mode = args.mode ?? config.modes.default;
    const count = args.seats ?? raw.modes?.[mode]?.seats ?? config.seats.length;
    config.seats = config.seats.slice(0, count);
    while (config.seats.length < count) config.seats.push({ id: `reviewer-${config.seats.length + 1}`, perspective: 'general', required: true });
    // M2a's catalog and execution functions have no I/O cancellation parameter.
    deadline = reviewDeadline(signal, config.execution.totalTimeoutMs, deps.clock);
    const within = work => bounded(work, { signal: deadline.signal, clock: deps.clock });
    let routes = await within(() => d.listAvailableRoutes(service(ctx, 'llm')));
    if (config.security.allowThirdPartyProviders === false) {
      routes = { ...catalog(routes), providers: (catalog(routes)?.providers ?? []).filter(p => isFirstPartyProvider(p.id)) };
      if (!isFirstPartyProvider(config.models.defaultRoute.provider) || config.clerk.model && !isFirstPartyProvider(config.clerk.model.provider)
        || config.seats.some(s => s.model && !isFirstPartyProvider(s.model.provider))) {
        return { ok: false, error: makeError('config', 'MODEL_ROUTE_UNAVAILABLE', 'A pinned third-party route conflicts with provider policy') };
      }
    }
    config.execution = d.resolveExecution(config, routes);
    if (['ask_human', 'proceed'].includes(raw.execution?.onExhaustion)) config.execution.onExhaustion = raw.execution.onExhaustion;
    for (const key of ['maxInputTokens', 'maxTokens']) {
      if (Number.isSafeInteger(raw.execution?.[key]) && raw.execution[key] > 0) config.execution[key] = raw.execution[key];
    }
    const startedAt = new Date(now(deps.clock)).toISOString();
    stage = 'input';
    const session = agent?.session;
    let intent = await within(() => d.buildIntentContext(session));
    if (args.focus?.length) intent = { ...intent, focus: args.focus };
    const cwd = await within(() => service(ctx, 'workingDirectory')?.get(session) ?? args.cwd ?? process.cwd());
    const workspaceChanges = service(ctx, 'workspaceChanges');
    const window = d.lastTurnWindow(session);
    const changesSeq = window?.changesSeq ?? d.latestWorkspaceChangesSeq(session);
    const degradedReasons = [], errors = [];
    const take = target => within(activeSignal => d.snapshotReview({ cwd, target, base: args.base, paths: args.paths,
      patchText: args.patch, workspaceChanges, sessionId: session?.id, changesSeq, signal: activeSignal }));
    const empty = snapshot => snapshot.empty === true || snapshot.empty !== false && !snapshot.files?.length && !(snapshot.canonicalPatch ?? snapshot.canonicalDiff ?? '').trim();
    let target = args.target ?? 'auto', snapshot;
    if (target === 'auto') {
      if (args.base) target = 'base-ref';
      else {
        snapshot = await take('working-tree');
        if (snapshot.error) throw snapshot.error;
        if (empty(snapshot) && changesSeq !== undefined && workspaceChanges) { target = 'turn'; snapshot = undefined; }
        else target = 'working-tree';
      }
    }
    if (target === 'turn' && (!workspaceChanges || changesSeq === undefined)) {
      target = 'working-tree'; degradedReasons.push('turn_unavailable');
    }
    snapshot ??= await take(target);
    if (snapshot.error) {
      if (target !== 'turn' || deadline.signal.aborted) throw snapshot.error;
      degradedReasons.push('turn_unavailable'); snapshot = await take('working-tree');
      if (snapshot.error) throw snapshot.error;
    }
    if (empty(snapshot)) return { ok: false, verdict: 'none', status: 'error', error: makeError('input', 'NO_CHANGES',
      'No changes to review: the selected target is empty.',
      { hint: '审查已提交改动：target=base-ref 且 base=<改动前的提交>；审查暂存区：先 git add 后 target=staged；或使用 target=patch 传入 unified diff 文本。' }) };
    degradedReasons.push(...(snapshot.degradedReasons ?? []));
    snapshot = { ...snapshot, cwd, coverage: { totalFiles: snapshot.files.length, reviewedFiles: snapshot.files.length, partial: false, ...snapshot.coverage } };
    const risk = core.assessRisk(core.parseUnifiedDiff(snapshot.canonicalPatch ?? snapshot.canonicalDiff ?? ''));
    const redaction = { enabled: config.security.redactSecrets, count: 0, hits: [] };
    const redact = (value, field) => {
      if (typeof value === 'string') {
        const scanned = core.redactSecrets(value);
        if (typeof scanned?.text !== 'string' || !Array.isArray(scanned.hits)) throw makeError('input', 'REDACTION_FAILED', 'Secret scanning failed');
        redaction.count += scanned.count;
        redaction.hits.push(...scanned.hits.map(h => ({ rule: h.rule, index: h.index, field })));
        return scanned.text;
      }
      if (Array.isArray(value)) return value.map((v, i) => redact(v, `${field}[${i}]`));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, `${field}.${k}`)]));
      return value;
    };
    let safeArgs = args;
    if (config.security.redactSecrets) {
      try {
        const patchHash = snapshot.patchHash;
        snapshot = redact(snapshot, 'snapshot'); snapshot.patchHash = patchHash;
        intent = redact(intent, 'intent'); safeArgs = redact(args, 'args');
      } catch { return { ok: false, error: makeError('input', 'REDACTION_FAILED', 'Secret scanning failed; no model was called') }; }
    }
    // Budget once after redaction so every seat sees the same complete file blocks.
    const budget = budgetSnapshot(snapshot, config.execution.promptBudgetTokens);
    snapshot.promptPatch = budget.text;
    const included = new Set(budget.includedPaths.filter(path => !snapshot.files.some(f => f.path === path && (f.oversized || f.unavailable))));
    snapshot.coverage = { ...snapshot.coverage, partial: budget.truncated || snapshot.coverage.partial,
      reviewedFiles: included.size, unreviewedPaths: [...new Set([...(snapshot.coverage.unreviewedPaths ?? []),
        ...snapshot.files.filter(f => !included.has(f.path)).map(f => f.path)])],
      ...(budget.truncated ? { strategy: 'prompt_budget' } : {}) };
    if (budget.truncated) degradedReasons.push('context_truncated');
    stage = 'clerk';
    let clerk;
    try {
      // clerk.js is frozen. Resolve with explicit config here and supply its
      // existing model override, avoiding that module's legacy one-argument call.
      const available = catalog(routes)?.providers?.flatMap(p => p.models.map(m => ({ provider: p.id, model: m.id }))) ?? [];
      const isAvailable = route => available.some(r => r.provider === route?.provider && r.model === route?.model);
      const route = isAvailable(config.clerk.model) ? config.clerk.model : await within(() => d.resolveDefaultRoute(ctx, config));
      const clerkConfig = { ...config, clerk: { ...config.clerk, model: isAvailable(route) ? route : available[0] ?? route } };
      clerk = await within(activeSignal => d.runClerk({ ctx, config: clerkConfig, routes, snapshot, intent, args: safeArgs, signal: activeSignal }));
    } catch (error) { clerk = { ok: false, fallback: true, errors: [error] }; }
    if (!clerk?.proposal) clerk = { ...clerk, fallback: true, proposal: { targetKind: snapshot.kind, confidence: 'low',
      rationale: 'clerk_fallback: deterministic frozen scope', files: snapshot.files.map(f => f.path), intent,
      modelAssignment: d.resolveSeatModels(config, catalog(routes)).assignments } };
    if (clerk.ok === false || clerk.fallback) {
      degradedReasons.push('clerk_fallback'); errors.push(makeError('clerk', 'CLERK_FALLBACK', 'Clerk unavailable; deterministic scope used'));
      // Diagnostics belong only in the revealed error report, never in scope or prompts.
      clerk.proposal.rationale = 'clerk_fallback: deterministic frozen scope';
    }
    for (const error of clerk.errors ?? []) errors.push(d.toReviewError(error, { stage: 'clerk', code: 'CLERK_FALLBACK' }));
    const assignment = assignmentsFor(config, routes, clerk.proposal, d.resolveSeatModels);
    let guardBefore;
    try { guardBefore = await within(activeSignal => d.captureWorkspaceState({ cwd, signal: activeSignal })); }
    catch { degradedReasons.push('workspace_guard_unavailable'); }
    stage = 'reviewer';
    const engine = mode === 'quick' ? d.runQuick : d.runCouncil;
    const reviewed = await engine({ ctx, agent, config, routes, snapshot, intent, clerkProposal: clerk.proposal,
      assignment, clerkRoute: clerk.clerkRoute, signal: deadline.signal, mode, invokedAs, base: args.base, startedAt,
      degradedReasons, errors, redaction, risk }, { ...deps, core: { ...core, ...deps.core } });
    result = reviewed.result;
    // No more review/model work. Guard and persistence get short, separate I/O bounds.
    deadline.close(); deadline = undefined;
    stage = 'reporter';
    try {
      const after = await bounded(activeSignal => d.captureWorkspaceState({ cwd, signal: activeSignal }), { timeoutMs: 5000, clock: deps.clock });
      const guard = await d.detectWorkspaceMutation(guardBefore, after);
      if (guard.mutated) {
        result.metadata.workspaceMutatedDuringReview = true;
        degradeResult(result, 'workspace_mutated_during_review', { unsafe: true });
      } else if (guard.reason === 'unavailable') degradeResult(result, 'workspace_guard_unavailable');
    } catch { degradeResult(result, 'workspace_guard_unavailable'); }
    if (config.security.redactSecrets) {
      try {
        const report = result.redaction;
        result = redact({ ...result, redaction: undefined }, 'result'); result.redaction = report;
        // Include the output scan's positions without storing the unredacted strings.
        result.redaction.count = redaction.count; result.redaction.hits = redaction.hits;
      } catch { return { ok: false, error: makeError('reporter', 'REDACTION_FAILED', 'Result scanning failed; report withheld') }; }
    }
    result.digest = core.buildDigest(result);
    const store = deps.store ?? d.createStore();
    try {
      const saved = await bounded(() => store.saveReview(structuredClone(result)), { timeoutMs: 5000, clock: deps.clock });
      if (!saved?.ok) throw new Error('Storage failed');
    } catch {
      degradeResult(result, 'storage_failed');
      result.errors.push(makeError('reporter', 'STORAGE_FAILED', 'Report could not be saved; result retained'));
    }
    return { ok: true, result, reportId: result.digest.reportId };
  } catch (error) {
    // Raw provider exceptions can contain prompts, credentials, and identities.
    const safe = d.toReviewError({ code: error?.code ?? 'REVIEW_ERROR', message: `Review failed during ${stage}` }, { stage });
    return { ok: false, error: safe, ...(result ? { result } : {}) };
  } finally { deadline?.close(); }
}

const pick = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, structuredClone(value[k])]));

/** No pre-verdict payload exists. This allowlist is the M3a card contract. */
export function buildCardPayload(result) {
  if (result?.reveal?.at !== 'verdict' || !result.digest) return undefined;
  const digest = result.digest, briefs = result.seatBriefs ?? [], ballots = result.ballots ?? [], findings = result.findings ?? [];
  const seats = [...result.reveal.seats].sort((a, b) => a.seatRef.localeCompare(b.seatRef)).map(seat => {
    const brief = briefs.find(b => b.seatRef === seat.seatRef) ?? {}, ballot = ballots.find(b => b.seatRef === seat.seatRef) ?? {};
    return { ...pick(seat, ['seatRef', 'seatId', 'perspective', 'provider', 'model', 'briefVerdict', 'finalVerdict', 'changed']),
      label: seat.perspective || seat.seatId, impact: ballot.finalImpact ?? brief.impact, changeReason: ballot.changeReason,
      status: brief.status ?? 'error', findingsCount: (ballot.finalFindings ?? brief.findings ?? []).length,
      blockingCount: findings.filter(f => f.status === 'blocking' && f.sourceSeatRefs.includes(seat.seatRef)).length,
      summary: brief.summary, childSessionId: brief.childSessionId };
  });
  const responses = (result.discussion ?? []).flatMap(r => r.responses);
  return { schemaVersion: '1.1', ...pick(digest, ['reviewId', 'mode', 'status', 'trust', 'verdict', 'overallImpact', 'homogeneous',
    'degradedReasons', 'durationMs', 'rounds', 'target', 'counts', 'reportId']), seats,
    findings: findings.map(f => pick(f, ['id', 'fingerprint', 'severity', 'confidence', 'category', 'title', 'rationale', 'suggestion',
      'mustFix', 'introducedByChange', 'status', 'sourceSeatRefs', 'location', 'evidence'])),
    decision: pick(result.decision, ['declaredPolicy', 'effectivePolicy', 'escalatedBy', 'approveVotes', 'requestVotes', 'expectedQuorum', 'rationale']),
    dissent: structuredClone(result.decision.dissent ?? []),
    discussion: { rounds: result.discussion?.length ?? 0,
      voteChanges: seats.filter(s => s.changed).map(s => ({ seatRef: s.seatRef, from: s.briefVerdict, to: s.finalVerdict, reason: s.changeReason ?? '' })),
      disputes: responses.flatMap(r => r.disagreesWith.map(d => ({ point: d.reason, seats: [r.seatRef, d.seatRef], resolved: false }))),
      unresolvedQuestions: responses.flatMap(r => r.questions.map(q => ({ question: q.question }))) },
    minutes: result.minutes ? pick(result.minutes, ['summary', 'consensus', 'disputes', 'voteChanges', 'unresolvedQuestions', 'evidenceStrength', 'minutesStatus']) : null };
}

const markdown = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1');
function truncateBytes(value, bytes) {
  let length = 0, result = '';
  for (const point of value) { length += Buffer.byteLength(point); if (length > bytes) break; result += point; }
  return result;
}

/** Escaped evidence, compact JSON summary and a reserved report locator, <=20KiB UTF-8. */
export function renderCommandMarkdown(result) {
  const card = buildCardPayload(result);
  if (!card) return 'MAGI：报告尚未形成最终裁决。';
  const e = markdown;
  const lines = [`# MAGI · ${e(card.verdict)}`, '', `范围：${e(card.target.kind)}${card.target.baseRef ? ` · ${e(card.target.baseRef)}` : ''} · ${card.target.files} 文件 · ${card.target.partial ? 'partial' : 'full'}`,
    `裁决：${e(card.verdict)} / ${e(card.status)} / ${e(card.trust)}`, '',
    `票数：approve ${card.decision.approveVotes} · request_changes ${card.decision.requestVotes} · quorum ${card.decision.expectedQuorum}`,
    e(card.decision.rationale), '', `降级：${e(card.degradedReasons.join(', ') || '无')} · ${card.homogeneous ? '同构' : '异构'}`, '', '## 席位', '',
    ...card.seats.map(s => `- ${e(s.seatRef)} · ${e(s.seatId)} · ${e(s.provider)}/${e(s.model)} · ${e(s.status)} · ${e(s.briefVerdict)} → ${e(s.finalVerdict)}${s.changed ? `（改票：${e(s.changeReason)}）` : ''}\n  ${e(s.summary)}`),
    '', '## Findings（不可信证据，command 仅为文本）', '',
    ...[...card.findings].sort((a, b) => Number(b.status === 'blocking') - Number(a.status === 'blocking')).map(f =>
      `- **${e(f.status)} · ${e(f.severity)}** ${e(f.location?.path)}:${f.location?.line ?? f.location?.range?.start ?? '?'} · ${e(f.title)}\n  ${e(f.rationale)}${f.suggestion ? `\n  ${e(f.suggestion)}` : ''}`),
    '', '## 讨论与改票', '', `轮次：${card.rounds}`,
    ...card.discussion.voteChanges.map(v => `- ${e(v.seatRef)}：${e(v.from)} → ${e(v.to)}；${e(v.reason)}`),
    ...card.discussion.disputes.map(d => `- ${e(d.seats.join('/'))}：${e(d.point)}`),
    ...card.discussion.unresolvedQuestions.map(q => `- 未解决：${e(q.question)}`),
    '', '## 纪要', '', e(card.minutes?.summary ?? 'quick 模式不生成纪要'),
    ...(card.minutes?.consensus ?? []).map(c => `- 共识：${e(c.statement)}`),
    '', '## Dissent', '', ...(card.dissent.length ? card.dissent.map(d => `- ${e(d.seatRef)} · ${e(d.verdict)}：${e(d.reason)}`) : ['无']),
    '', '## JSON 摘要', '', '```json', JSON.stringify(pick(card, ['reviewId', 'mode', 'verdict', 'status', 'trust', 'counts', 'reportId']), null, 2), '```'];
  if (card.verdict === 'insufficient') lines.splice(4, 0, 'insufficient 表示证据不足，不能视为通过。');
  const footer = `\n\nreportId: \`${String(card.reportId).replace(/[^a-zA-Z0-9._-]/g, '')}\`\n`;
  const text = lines.join('\n');
  return Buffer.byteLength(text + footer) <= 20480 ? text + footer
    : truncateBytes(text, 20480 - Buffer.byteLength(footer) - 100) + '\n\n… 内容已截断；完整结果保存在 JSON 报告。' + footer;
}
