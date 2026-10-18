import { randomUUID } from 'node:crypto';
import { runSeatTurn } from './seat.js';
import { callLlmJsonValidated, resolveDefaultRoute } from './llm-json.js';
import { toReviewError } from './errors.js';
import { parseSeatResponse, validateMinutes } from './protocol.js';
import { buildBriefPrompt, buildDiscussionPrompt, buildBallotPrompt, buildMinutesPrompt } from './prompts.js';
import { aggregateFindings } from '../core/aggregate.js';
import { applyBlockingStatus, decide } from '../core/policy.js';
import { assessRisk } from '../core/risk.js';
import { assignSeatRefs, buildDocket, buildReveal } from '../core/anonymity.js';
import { buildDigest } from '../core/digest.js';
import { buildTemplateMinutes } from '../core/minutes-template.js';
import { parseUnifiedDiff, hashDiff } from '../core/canonical-diff.js';
import { redactSecrets } from '../core/redact.js';
import { extractJson } from '../core/json.js';
import { DEFAULTS } from './config.js';

const defaultCore = { aggregateFindings, applyBlockingStatus, decide, assessRisk, assignSeatRefs,
  buildDocket, buildReveal, buildDigest, buildTemplateMinutes, parseUnifiedDiff, hashDiff, redactSecrets };
const perspectives = {
  'builtin:architect': '核查设计边界、接口一致性、可维护性，以及用户请求和交付声称与实际变更是否一致。',
  'builtin:engineer': '核查实现正确性、边界条件、测试证据、性能与可操作性。',
  'builtin:adversary': '独立寻找反例、安全漏洞、失败路径与容易遗漏的回归，以代码证据检验假设。',
};
export const service = (ctx, name) => {
  try { return typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name]; } catch { return undefined; }
};
export const now = clock => typeof clock === 'function' ? clock() : clock?.now?.() ?? Date.now();
const asText = prompt => typeof prompt === 'string' ? prompt : `${prompt.system}\n\n${prompt.user}`;
const replyText = response => response?.text || response?.raw || JSON.stringify(response?.structured ?? response?.value) || '';

// Only host-generated validation messages belong here, never provider diagnostics or values.
function minutesCause(errors, rawLength, finishReason, attempts) {
  const diagnostic = { errors: [], rawLength, finishReason, attempts };
  for (const error of errors) {
    diagnostic.errors.push(error);
    if (JSON.stringify(diagnostic).length > 1000) { diagnostic.errors.pop(); break; }
  }
  return JSON.stringify(diagnostic);
}

/** Every host wait is bounded even when an injected provider ignores cancellation. */
export async function bounded(work, { signal, timeoutMs, clock } = {}) {
  const controller = new AbortController();
  const schedule = clock?.setTimeout?.bind(clock) ?? setTimeout;
  const cancel = clock?.clearTimeout?.bind(clock) ?? clearTimeout;
  let timer, rejectWait;
  const stopped = new Promise((_, reject) => { rejectWait = reject; });
  const abort = reason => { controller.abort(reason); rejectWait(reason); };
  const onAbort = () => abort(signal.reason ?? Object.assign(new Error('Cancelled'), { code: 'REVIEWER_ABORTED' }));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  if (Number.isFinite(timeoutMs)) timer = schedule(() => abort(Object.assign(new Error('Timed out'), { code: 'REVIEWER_TIMEOUT' })), timeoutMs);
  try {
    return await Promise.race([stopped, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return work(controller.signal);
    })]);
  } finally {
    if (timer !== undefined) cancel(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function reviewDeadline(signal, timeoutMs, clock) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason ?? Object.assign(new Error('Cancelled'), { code: 'REVIEWER_ABORTED' }));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = (clock?.setTimeout?.bind(clock) ?? setTimeout)(() => controller.abort(
    Object.assign(new Error('Review budget exhausted'), { code: 'BUDGET_EXCEEDED', timeout: true })), timeoutMs);
  return { controller, signal: controller.signal, close() {
    (clock?.clearTimeout?.bind(clock) ?? clearTimeout)(timer);
    signal?.removeEventListener('abort', onAbort);
  } };
}

async function askHuman(ctx, request) {
  const answer = await service(ctx, 'userQuestions')?.ask(request);
  const choice = answer?.answers?.[0]?.custom || answer?.answers?.[0]?.selected?.[0];
  return { answered: ['continue', 'ballot'].includes(choice), choice };
}

/** Shared one-shot engine; quick.js selects the independent brief/ballot path. */
export async function runCouncil(input, deps = {}) {
  const core = { ...defaultCore, ...deps.core };
  const seatTurn = deps.runSeatTurn ?? runSeatTurn;
  const llmJson = deps.callLlmJsonValidated ?? callLlmJsonValidated;
  const { ctx, agent, config, snapshot, intent = {}, clerkProposal = {} } = input;
  const mode = input.mode ?? 'council', execution = { ...DEFAULTS.execution, ...config.execution };
  const invokedAs = input.invokedAs ?? 'tool';
  const onExhaustion = execution.onExhaustion ?? config.discussion.onExhaustion;
  const humanConfirmationTimeoutMs = config.discussion.humanConfirmationTimeoutMs ?? 120000;
  const deadline = reviewDeadline(input.signal, execution.totalTimeoutMs, deps.clock);
  const signal = deadline.signal;
  const startedAt = input.startedAt ?? new Date(now(deps.clock)).toISOString();
  const degradedReasons = [...new Set(input.degradedReasons ?? [])], errors = [...(input.errors ?? [])];
  const addReason = reason => { if (!degradedReasons.includes(reason)) degradedReasons.push(reason); };
  const usage = { ...(input.usage ?? {}) };
  const redaction = input.redaction ?? { count: 0, hits: [] };
  let estimatedInputTokens = Number.isFinite(usage.estimatedInputTokens) ? Math.max(0, usage.estimatedInputTokens) : 0;
  let estimatedOutputTokens = Number.isFinite(usage.estimatedOutputTokens) ? Math.max(0, usage.estimatedOutputTokens) : 0;
  const usedSeats = new Set();
  function account(value) {
    for (const key of ['inputTokens', 'outputTokens', 'estimatedCostUsd']) {
      if (Number.isFinite(value?.[key]) && value[key] >= 0) usage[key] = (usage[key] ?? 0) + value[key];
    }
  }
  function stopped() {
    if ((execution.maxInputTokens !== undefined && (usage.inputTokens >= execution.maxInputTokens || estimatedInputTokens > execution.maxInputTokens))
      || execution.maxCostUsd === 0 || (usage.estimatedCostUsd !== undefined && usage.estimatedCostUsd >= execution.maxCostUsd)) {
      deadline.controller.abort(Object.assign(new Error('Review budget exhausted'), { code: 'BUDGET_EXCEEDED' }));
    }
    if (!signal.aborted) return false;
    if (signal.reason?.code === 'BUDGET_EXCEEDED') { addReason('budget_exceeded'); if (signal.reason.timeout) addReason('timeout'); }
    else if (signal.reason?.code === 'REDACTION_FAILED') addReason('redaction_failed');
    else addReason('cancelled');
    return true;
  }
  function reserveInput(promptText) {
    const estimate = Math.ceil(promptText.length / 3);
    if (execution.maxInputTokens !== undefined && estimatedInputTokens + estimate > execution.maxInputTokens) {
      deadline.controller.abort(Object.assign(new Error('Input token budget exhausted'), { code: 'BUDGET_EXCEEDED' }));
      stopped();
      return false;
    }
    estimatedInputTokens += estimate;
    return true;
  }
  const refs = core.assignSeatRefs(config.seats), allowedSeatRefs = refs.map(s => s.seatRef);
  const assignment = refs.map((ref, index) => {
    const seat = config.seats[index];
    const route = (input.assignment ?? clerkProposal.modelAssignment ?? []).find(a => a.seatId === ref.seatId);
    return { ...ref, perspective: seat.perspective, ...(route ?? seat.model ?? config.models.defaultRoute), seatId: ref.seatId };
  });
  // Never copy provider diagnostics, raw output, or real identities into retry prompts/errors.
  const safeError = (kind, seatRef, code, attempts, timeoutMs) => ({
    ...toReviewError({ code, message: `${kind} failed for anonymous seat ${seatRef}`, attempts },
      { stage: kind === 'brief' || kind === 'ballot' ? 'reviewer' : 'discussion', code }),
    ...(code === 'REVIEWER_TIMEOUT' ? { timeoutMs } : {}),
  });
  const knownIdentities = assignment.flatMap(a => [a.seatId, a.perspective, a.provider, a.model]).filter(Boolean);
  function anonymous(value) {
    if (typeof value === 'string') {
      for (const identity of [...knownIdentities].sort((a, b) => b.length - a.length)) value = value.replaceAll(identity, '[anonymous]');
      return value;
    }
    if (Array.isArray(value)) return value.map(anonymous);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, anonymous(v)]));
    return value;
  }
  const docketFor = briefs => anonymous(core.buildDocket(briefs));
  function scrub(value, field) {
    if (config.security?.redactSecrets === false) return value;
    if (typeof value === 'string') {
      const scanned = core.redactSecrets(value);
      if (typeof scanned?.text !== 'string' || !Array.isArray(scanned.hits)) throw new Error('Invalid redaction response');
      redaction.count += scanned.count;
      redaction.hits.push(...scanned.hits.map(hit => ({ rule: hit.rule, index: hit.index, field })));
      return scanned.text;
    }
    if (Array.isArray(value)) return value.map((v, i) => scrub(v, `${field}[${i}]`));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, `${field}.${k}`)]));
    return value;
  }
  async function batch(items, work) {
    const values = [], width = Math.max(1, execution.concurrency ?? 3);
    for (let i = 0; i < items.length; i += width) values.push(...await Promise.all(items.slice(i, i + width).map(work)));
    return values;
  }
  async function turn(seat, kind, prompt, round, ownBrief) {
    let lastCode = 'INVALID_SEAT_OUTPUT', validationErrors = '执行未完成或 JSON 未通过校验', attempts = 0;
    const timeoutMs = kind === 'brief' ? execution.briefTimeoutMs : kind === 'discussion' ? execution.discussionRoundTimeoutMs : execution.ballotTimeoutMs;
    for (let attempt = 0; attempt < 2 && !stopped(); attempt++) {
      const promptText = asText(prompt) + (attempt ? `\n\n你上一轮回复无效：${validationErrors}，请重新只输出合法 JSON` : '');
      if (!reserveInput(promptText)) break;
      attempts++;
      try {
        const raw = await bounded(turnSignal => {
          usedSeats.add(seat.seatRef);
          return seatTurn(service(ctx, 'subagents'), {
            parentAgent: agent, cwd: snapshot.cwd ?? snapshot.repoRoot, provider: seat.provider, model: seat.model,
            preset: kind === 'discussion' && config.discussion.allowScripts !== false ? 'magi-reviewer-verify' : 'magi-reviewer-readonly',
            prompt: promptText,
            timeoutMs, signal: turnSignal, label: `magi-${kind}-${seat.seatRef}`,
          });
        }, { signal, timeoutMs, clock: deps.clock });
        account(raw.usage);
        // Include failed replies and retries too; structured-only providers have a JSON fallback.
        estimatedOutputTokens += Math.ceil(replyText(raw).length / 3);
        const parsed = parseSeatResponse(raw, { seatRef: seat.seatRef, kind, round, allowedSeatRefs });
        if (parsed.ok && kind === 'ballot' && parsed.value.finalVerdict !== ownBrief?.verdict && !parsed.value.changeReason?.trim()) {
          parsed.ok = false; parsed.errors = ['changeReason: a changed verdict requires a reason'];
        }
        if (parsed.ok) {
          let value;
          try { value = scrub(parsed.value, `${kind}.${seat.seatRef}`); }
          catch {
            deadline.controller.abort(Object.assign(new Error('Output secret scanning failed'), { code: 'REDACTION_FAILED' }));
            break;
          }
          return { value, childSessionId: raw.childSessionId ?? raw.childId,
            usage: raw.usage ?? { durationMs: raw.durationMs ?? 0 } };
        }
        lastCode = raw.error?.code ?? 'INVALID_SEAT_OUTPUT';
        validationErrors = anonymous((parsed.errors ?? []).slice(0, 5).join('; ')).slice(0, 1500);
      } catch (error) { lastCode = error?.code === 'REVIEWER_TIMEOUT' ? 'REVIEWER_TIMEOUT' : 'REVIEWER_ERROR'; }
    }
    if (lastCode === 'REVIEWER_TIMEOUT') addReason('timeout');
    const error = safeError(kind, seat.seatRef, stopped() ? 'REVIEWER_ABORTED' : lastCode, attempts, timeoutMs);
    errors.push(error);
    return { error };
  }
  try {
    const briefs = await batch(assignment, async seat => {
      const response = await turn(seat, 'brief', buildBriefPrompt({ seatRef: seat.seatRef,
        perspectiveText: perspectives[seat.perspective] ?? '依据冻结差异独立核查正确性、风险、测试与任务符合程度。', snapshot, intent, config }));
      if (response.error) addReason(`reviewer_error:${seat.seatRef}`);
      return { ...(response.value ?? { seatRef: seat.seatRef, findings: [], summary: '' }),
        status: response.error ? 'error' : 'completed', model: { provider: seat.provider, model: seat.model },
        perspective: seat.perspective, ...(response.childSessionId ? { childSessionId: response.childSessionId } : {}),
        ...(response.usage ? { usage: response.usage } : {}), ...(response.error ? { error: response.error } : {}) };
    });
    // Merge once before discussion as well as after sealed ballots. No vote tally is exposed here.
    core.aggregateFindings(briefs);
    let docket = docketFor(briefs);
    const discussion = [], active = assignment.filter(s => briefs.find(b => b.seatRef === s.seatRef)?.status === 'completed');
    const previous = new Map(), latest = new Map();
    let previousDisputes = 0, limit = config.discussion.maxRounds;
    if (mode === 'council' && active.length) for (let round = 1; round <= limit && !stopped(); round++) {
      const docketHash = core.hashDiff(JSON.stringify(docket));
      const responses = (await batch(active, async seat => {
        const ownBrief = docketFor([briefs.find(b => b.seatRef === seat.seatRef)]).seats[0];
        const response = await turn(seat, 'discussion', buildDiscussionPrompt({ seatRef: seat.seatRef, round, ownBrief,
          docket, ownPreviousResponses: previous.get(seat.seatRef) ?? [], config }), round);
        if (response.error) { addReason(`discussion_missing:${seat.seatRef}`); return null; }
        const value = anonymous(response.value);
        previous.set(seat.seatRef, [...(previous.get(seat.seatRef) ?? []), value]);
        latest.set(seat.seatRef, value);
        return value;
      })).filter(Boolean);
      // Missing responses retain their previous stance but cannot prove stability.
      const disputes = [...latest.values()].reduce((sum, r) => sum + r.disagreesWith.length, 0);
      const stable = responses.length === active.length && responses.every(r => !r.positionChanged && !r.newFindings.length)
        && disputes <= previousDisputes;
      let termination = { ended: stable, reason: stable ? 'positions_stable' : 'positions_unstable' };
      if (!stable && round === limit) {
        termination = { ended: true, reason: 'round_cap' };
        if (round === config.discussion.maxRounds && onExhaustion === 'ask_human' && !stopped()) {
          let answer;
          if (invokedAs === 'command') try {
            answer = await bounded(humanSignal => (deps.askHuman ?? (r => askHuman(ctx, r)))({ agent, signal: humanSignal,
              questions: [{ id: 'magi-extend', question: '讨论已达轮次上限。继续讨论还是直接表决？',
                options: [{ label: 'ballot', description: '直接表决' }, { label: 'continue', description: '追加有限轮次' }] }],
              timeoutMs: humanConfirmationTimeoutMs }),
            { signal, timeoutMs: humanConfirmationTimeoutMs, clock: deps.clock });
          } catch { answer = { answered: false }; }
          if (!answer?.answered || !['continue', 'ballot'].includes(answer.choice)) addReason('human_confirmation_missing');
          else if (answer.choice === 'continue') { limit += config.discussion.extendByRounds; termination = { ended: false, reason: 'human_decided' }; }
          else termination.reason = 'human_decided';
        }
      }
      if (stopped()) termination = { ended: true, reason: round === limit ? 'round_cap' : 'interrupted' };
      discussion.push({ index: round, docketHash, responses, termination });
      previousDisputes = disputes;
      docket = docketFor(briefs.map(b => ({ ...b, findings: [...b.findings,
        ...(previous.get(b.seatRef) ?? []).flatMap(r => r.newFindings)] })));
      if (termination.ended) break;
    }
    const ballots = await batch(active, async seat => {
      const brief = briefs.find(b => b.seatRef === seat.seatRef);
      const ownBrief = docketFor([brief]).seats[0];
      const response = await turn(seat, 'ballot', buildBallotPrompt({ seatRef: seat.seatRef, ownBrief,
        docket: mode === 'quick' ? docketFor([brief]) : docket, discussionRecord: discussion, config }), undefined, brief);
      if (response.error) {
        addReason(`ballot_missing:${seat.seatRef}`);
        return { seatRef: seat.seatRef, finalVerdict: brief.verdict, finalImpact: brief.impact,
          finalFindings: structuredClone(brief.findings), changedFromBrief: false };
      }
      const ballot = response.value;
      // The host, rather than a self-reported flag, determines whether the vote changed.
      if (ballot.finalVerdict !== brief.verdict) ballot.changedFromBrief = true;
      return ballot;
    });
    stopped();
    const aggregate = core.aggregateFindings(briefs.map(b => ({ ...b,
      findings: ballots.find(v => v.seatRef === b.seatRef)?.finalFindings ?? b.findings })));
    const findings = core.applyBlockingStatus(aggregate.findings, config.policy);
    const risk = input.risk ?? core.assessRisk(core.parseUnifiedDiff(snapshot.canonicalPatch ?? snapshot.canonicalDiff ?? ''));
    const coverage = { ...snapshot.coverage, ...(signal.aborted ? { interrupted: true } : {}) };
    const decision = core.decide({ seats: briefs, ballots, findings, coverage, degradedReasons, policy: config.policy, risk });
    const reveal = core.buildReveal(assignment, briefs, ballots, discussion);
    const reportId = input.reportId ?? randomUUID();
    const result = {
      schemaVersion: '1.1', engineVersion: '0.1.0', reportId, mode,
      scope: { ...clerkProposal, rationale: clerkProposal.rationale ?? 'Frozen review snapshot', confidence: clerkProposal.confidence ?? 'low',
        artifactKind: 'code-change', target: { kind: snapshot.kind, patchHash: snapshot.patchHash,
        ...(snapshot.baseOid ? { baseOid: snapshot.baseOid } : {}), ...(snapshot.headOid ? { headOid: snapshot.headOid } : {}),
        ...(input.base ? { baseRef: input.base } : {}), ...(snapshot.turn !== undefined ? { turn: snapshot.turn } : {}),
        ...(agent?.session?.id ? { sessionId: agent.session.id } : {}) },
      files: snapshot.files.map(f => f.path), intent, modelAssignment: assignment.map(({ seatRef, ...a }) => a) },
      coverage, risk, reveal, decision, findings, seatBriefs: briefs, discussion, ballots, minutes: null,
      errors, degradedReasons, redaction,
      metadata: { startedAt, finishedAt: new Date(now(deps.clock)).toISOString(),
        homogeneous: new Set(assignment.map(a => a.model)).size <= 1,
        models: assignment.map(a => ({ seatId: a.seatId, provider: a.provider, model: a.model, fallback: a.fallback === true })),
        usage, estimatedInputTokens, workspaceMutatedDuringReview: false, sessionId: agent?.session?.id },
    };
    result.digest = core.buildDigest(result);
    if (mode === 'council' && decision.status !== 'error') {
      const template = core.buildTemplateMinutes(result);
      if (stopped()) result.minutes = template;
      else {
        let invalid = false, validationErrors = [], rawLength = 0, finishReason = 'unknown', attempts = 0;
        const checkMinutes = value => {
          const checked = validateMinutes(value);
          validationErrors = checked.errors;
          if (!checked.ok) return checked;
          // The narrator must preserve dissent and cannot invent identities, findings, or vote changes.
          const minutes = checked.value, ids = reveal.seats.map(s => s.seatId), fingerprints = findings.map(f => f.fingerprint);
          if (minutes.seatSummaries.length !== ids.length || new Set(minutes.seatSummaries.map(s => s.seatId)).size !== ids.length
            || minutes.seatSummaries.some(s => !ids.includes(s.seatId))) validationErrors.push('seatSummaries: must contain each revealed seat exactly once');
          if (minutes.consensus.some(c => c.fingerprint && !fingerprints.includes(c.fingerprint))) validationErrors.push('consensus: unknown finding fingerprint');
          if (minutes.disputes.some(d => d.seats.some(id => !ids.includes(id)) || d.fingerprint && !fingerprints.includes(d.fingerprint))) validationErrors.push('disputes: unknown seat or finding fingerprint');
          if (minutes.voteChanges.length !== template.voteChanges.length
            || minutes.voteChanges.some(v => !template.voteChanges.some(t => t.seatId === v.seatId && t.from === v.from && t.to === v.to))) validationErrors.push('voteChanges: differs from fixed vote changes');
          if (minutes.dissent.length !== template.dissent.length
            || template.dissent.some(d => !minutes.dissent.some(m => m.seatId === d.seatId && m.verdict === d.verdict && m.reason === d.reason))) validationErrors.push('dissent: must preserve every fixed dissent and verbatim reason');
          return { ...checked, ok: validationErrors.length === 0 };
        };
        try {
          const route = input.clerkRoute ?? config.clerk.model ?? await bounded(() => (deps.resolveDefaultRoute ?? resolveDefaultRoute)(ctx, config), { signal, clock: deps.clock });
          for (let attempt = 0; attempt < 2; attempt++) {
            if (stopped()) throw new Error('Minutes budget exhausted');
            const prompt = buildMinutesPrompt({ result, minutesTemplate: template }, { compact: attempt > 0 });
            if (!reserveInput(asText(prompt))) throw new Error('Minutes budget exhausted');
            attempts++;
            const response = await bounded(minutesSignal => llmJson(service(ctx, 'llm'), {
              ...route, ...prompt, stage: 'minutes', maxTokens: attempt === 0 ? 6000 : 4000,
            }, { validate: checkMinutes, timeoutMs: 60000, retries: 0, signal: minutesSignal }), { signal, timeoutMs: 60000, clock: deps.clock });
            if (Number.isSafeInteger(response.attempts) && response.attempts > 1) attempts += response.attempts - 1;
            account(response.usage);
            rawLength = replyText(response).length;
            // Only the kind belongs in diagnostics, never provider messages or objects.
            finishReason = typeof response.finishReason === 'string' && /^[a-z][a-z0-9_-]{0,63}$/i.test(response.finishReason)
              ? response.finishReason : 'unknown';
            invalid = response.ok || response.error instanceof SyntaxError || ['INVALID_JSON', 'LLM_OUTPUT_INVALID'].includes(response.error?.code);
            const checked = checkMinutes(response.ok ? response.value : extractJson(response.raw ?? response.text ?? ''));
            if (response.ok && checked.ok) {
              result.minutes = scrub(checked.value, 'minutes');
              let cleared = false;
              for (let i = degradedReasons.length - 1; i >= 0; i--) {
                if (['minutes_invalid', 'minutes_failed'].includes(degradedReasons[i])) {
                  degradedReasons.splice(i, 1); cleared = true;
                }
              }
              if (cleared) Object.assign(decision, core.decide({ seats: briefs, ballots, findings, coverage, degradedReasons, policy: config.policy, risk }));
              break;
            }
            // Retry once with the compact prompt when the reply was truncated by
            // the output budget, too short to be a minutes object, or not an object.
            const truncated = finishReason === 'max-tokens';
            if (attempt === 0 && invalid && (truncated || rawLength < 300 || validationErrors.some(e => e.includes('Expected an object')))) continue;
            throw new Error('Minutes unavailable');
          }
        } catch {
          addReason(invalid ? 'minutes_invalid' : 'minutes_failed');
          errors.push(toReviewError({ message: 'Minutes unavailable; deterministic template used',
            ...(invalid ? { cause: minutesCause(validationErrors.length ? validationErrors : ['Minutes validation failed'], rawLength, finishReason, attempts) } : {}),
          }, { stage: 'minutes', code: invalid ? 'MINUTES_INVALID' : 'MINUTES_FAILED' }));
          result.minutes = { ...template, minutesStatus: invalid ? 'invalid' : 'ok' };
        }
      }
    }
    stopped();
    if (degradedReasons.length && decision.status !== 'error') {
      decision.status = 'degraded'; decision.trust = 'needs_review';
    }
    result.metadata.finishedAt = new Date(now(deps.clock)).toISOString();
    result.metadata.estimatedInputTokens = estimatedInputTokens;
    Object.assign(usage, { estimatedInputTokens, estimatedOutputTokens, seatsUsed: usedSeats.size, rounds: discussion.length });
    result.digest = core.buildDigest(result);
    return { result, degradedReasons, errors };
  } finally { deadline.close(); }
}
