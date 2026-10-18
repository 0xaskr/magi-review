import test from 'node:test';
import assert from 'node:assert/strict';
import { runCouncil } from '../../lib/host/council.js';
import { normalizeConfig } from '../../lib/host/config.js';
import { decide } from '../../lib/core/policy.js';
import { buildDocket } from '../../lib/core/anonymity.js';

const patch = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-old\n+new\n';
function fixture(overrides = {}) {
  return { ctx: { get: () => ({}) }, agent: { session: { id: 'session' } }, mode: 'council',
    config: normalizeConfig({ discussion: { maxRounds: 2, extendByRounds: 1, humanConfirmationTimeoutMs: 10 }, ...overrides }),
    snapshot: { kind: 'patch', cwd: 'C:/fake', canonicalPatch: patch, patchHash: 'original-hash', files: [{ path: 'src/a.js' }],
      coverage: { totalFiles: 1, reviewedFiles: 1, partial: false } }, intent: { task: 'review' },
    clerkRoute: { provider: 'clerk-provider', model: 'clerk-model' } };
}
function wire(value, extra = {}) { return { ok: true, structured: value, childId: 'child-' + value.seatRef, ...extra }; }
const brief = seatRef => ({ seatRef, verdict: 'approve', impact: 'normal', findings: [], summary: 'Evidence checked.' });
const ballot = seatRef => ({ seatRef, finalVerdict: 'approve', finalImpact: 'normal', finalFindings: [], changedFromBrief: false });
const discussion = (seatRef, round, changed = false) => ({ seatRef, round, agreesWith: [{ seatRef: seatRef === 'A' ? 'B' : 'A', reason: 'Verified' }],
  disagreesWith: [], positionChanged: changed, ...(changed ? { changeReason: 'New evidence' } : {}), newFindings: [], questions: [] });
const minutes = () => ({ summary: 'All evidence recorded.', seatSummaries: ['architect', 'engineer', 'adversary'].map(seatId => ({ seatId, label: seatId, view: 'Checked' })),
  consensus: [], disputes: [], voteChanges: [], unresolvedQuestions: [], evidenceStrength: 'moderate', dissent: [], minutesStatus: 'ok' });
function fake(options = {}) {
  const calls = [], minuteCalls = [], decisions = [], dockets = [];
  return { calls, minuteCalls, decisions, dockets, deps: {
    async runSeatTurn(_subagents, request) {
      calls.push(request);
      const [, kind, ref] = request.label.split('-'), round = Number(request.prompt.match(/round=(\d+)/)?.[1]);
      const value = options.reply ? await options.reply(kind, ref, round, request, calls) : undefined;
      return value ?? wire(kind === 'brief' ? brief(ref) : kind === 'ballot' ? ballot(ref) : discussion(ref, round, options.unstable));
    },
    async callLlmJsonValidated(_llm, request, opts) {
      minuteCalls.push({ request, opts });
      if (options.minutesError) throw new Error('provider credential diagnostics');
      return { ok: true, value: options.invalidMinutes ? { ...minutes(), verdict: 'approve' } : minutes() };
    },
    askHuman: options.askHuman ?? (async () => ({ answered: false })),
    core: { decide(input) { decisions.push(input); return decide(input); }, buildDocket(briefs) {
      const docket = buildDocket(briefs); dockets.push(docket); return docket;
    } },
  } };
}

test('council uses one-shot presets, stable termination, anonymous docket and post-decision reveal', async () => {
  const f = fake(), { result } = await runCouncil(fixture(), f.deps);
  assert.equal(result.seatBriefs.length, 3); assert.equal(result.discussion.length, 1);
  assert.equal(result.discussion[0].termination.reason, 'positions_stable');
  assert.equal(result.digest.verdict, 'approve'); assert.equal(result.digest.status, 'completed');
  assert.equal(f.decisions.length, 1); assert.equal(f.calls.length, 9);
  assert.equal(result.reveal.seats[0].seatId, 'architect'); assert.equal(result.reveal.seats[0].seatRef, 'A');
  assert.equal(result.seatBriefs[0].childSessionId, 'child-A');
  assert.equal(result.scope.target.patchHash, 'original-hash');
  assert.equal(result.minutes.summary, 'All evidence recorded.');
  assert.equal(f.minuteCalls[0].request.provider, 'clerk-provider'); assert.equal(f.minuteCalls[0].opts.timeoutMs, 60000);
  assert.equal(f.minuteCalls[0].request.maxTokens, 6000);
  for (const docket of f.dockets) assert.doesNotMatch(JSON.stringify(docket), /"(?:seatId|perspective|model|provider|childSessionId)"/);
  for (const call of f.calls) {
    assert.equal(call.timeoutMs, call.label.startsWith('magi-brief') ? 240000 : call.label.startsWith('magi-discussion') ? 180000 : 60000);
    assert.equal(call.preset, call.label.startsWith('magi-discussion') ? 'magi-reviewer-verify' : 'magi-reviewer-readonly');
    if (!call.label.startsWith('magi-brief')) assert.doesNotMatch(call.prompt, /builtin:|deepseek-official|deepseek-flash|child-A/);
  }
});

test('hanging briefs retry once and record the actual timeout with anonymous errors', async () => {
  const f = fake({ reply(kind, ref) { if (kind === 'brief' && ref === 'A') return new Promise(() => {}); } });
  const { result } = await runCouncil(fixture({ execution: { briefTimeoutMs: 5 } }), f.deps);
  assert.equal(f.calls.filter(c => c.label === 'magi-brief-A').length, 2);
  assert.deepEqual(result.seatBriefs[0].error, { stage: 'reviewer', code: 'REVIEWER_TIMEOUT',
    message: 'brief failed for anonymous seat A', attempts: 2, timeoutMs: 5 });
  assert.ok(result.degradedReasons.includes('timeout')); assert.ok(result.degradedReasons.includes('reviewer_error:A'));
  assert.equal(result.digest.status, 'degraded');
  assert.ok(result.errors.some(e => e.code === 'REVIEWER_TIMEOUT' && e.timeoutMs === 5));
  for (const docket of f.dockets) assert.doesNotMatch(JSON.stringify(docket), /REVIEWER_TIMEOUT|timeoutMs/);
});

test('minutes route resolution receives explicit config on a get-only host', async () => {
  const f = fake(), input = fixture(); delete input.clerkRoute;
  input.ctx = new Proxy({ get: () => undefined }, { get(target, key) {
    if (key !== 'get') throw Error(`cannot get property ${String(key)} without inject`); return target[key];
  } });
  f.deps.resolveDefaultRoute = async (ctx, config) => {
    assert.equal(ctx, input.ctx); assert.equal(config, input.config);
    return { provider: 'configured-provider', model: 'configured-model' };
  };
  const { result } = await runCouncil(input, f.deps);
  assert.equal(result.digest.status, 'completed'); assert.equal(f.minuteCalls[0].request.model, 'configured-model');
});

test('same model id across providers is homogeneous in report and digest', async () => {
  const input = fixture(), f = fake();
  input.assignment = input.config.seats.map((seat, i) => ({ seatId: seat.id,
    provider: i === 2 ? 'deepseek-account' : 'deepseek-official', model: 'deepseek-flash' }));
  const same = await runCouncil(input, f.deps);
  assert.equal(same.result.metadata.homogeneous, true); assert.equal(same.result.digest.homogeneous, true);
  input.assignment[2].model = 'deepseek-v4-pro';
  assert.equal((await runCouncil(input, f.deps)).result.metadata.homogeneous, false);
});

test('invalid JSON retries exactly once with a fresh one-shot invocation', async () => {
  let attempts = 0;
  const f = fake({ reply(kind, ref) {
    if (kind === 'brief' && ref === 'A' && ++attempts === 1) return { ok: true, text: 'not json' };
  } });
  const { result } = await runCouncil(fixture(), f.deps);
  const a = f.calls.filter(c => c.label === 'magi-brief-A');
  assert.equal(a.length, 2); assert.match(a[1].prompt, /上一轮回复无效/);
  assert.equal(result.seatBriefs[0].status, 'completed'); assert.equal(result.digest.status, 'completed');
});

test('brief errors remain anonymous and cannot manufacture votes', async () => {
  const f = fake({ reply(kind, ref) {
    if (kind === 'brief' && ref === 'A') throw new Error('architect=A model=private-provider');
  } });
  const { result } = await runCouncil(fixture(), f.deps);
  assert.equal(result.seatBriefs[0].status, 'error'); assert.equal(result.ballots.length, 2);
  assert.ok(result.digest.degradedReasons.includes('reviewer_error:A'));
  assert.doesNotMatch(JSON.stringify(result.errors), /architect|private-provider/);
  assert.equal(result.decision.expectedQuorum, 2);
});

test('ballot failures use brief evidence and record degradation', async () => {
  const f = fake({ reply(kind, ref) { if (kind === 'ballot' && ref === 'B') return { ok: false, error: { code: 'REVIEWER_TIMEOUT' } }; } });
  const { result } = await runCouncil(fixture(), f.deps);
  assert.equal(f.calls.filter(c => c.label === 'magi-ballot-B').length, 2);
  assert.equal(result.ballots[1].finalVerdict, 'approve'); assert.equal(result.ballots[1].changedFromBrief, false);
  assert.ok(result.digest.degradedReasons.includes('ballot_missing:B')); assert.equal(result.digest.status, 'degraded');
});

test('tool and unspecified invocation never ask a human at an unstable round cap', async () => {
  for (const invokedAs of ['tool', undefined]) {
    let asked = 0;
    const f = fake({ unstable: true, askHuman: () => { asked++; return new Promise(() => {}); } });
    const input = { ...fixture(), invokedAs };
    // execution alias wins over the legacy discussion setting.
    input.config.execution.onExhaustion = 'ask_human'; input.config.discussion.onExhaustion = 'proceed';
    const { result } = await runCouncil(input, f.deps);
    assert.equal(asked, 0); assert.equal(result.ballots.length, 3);
    assert.ok(result.degradedReasons.includes('human_confirmation_missing'));
    assert.deepEqual(result.discussion.map(r => r.termination), [
      { ended: false, reason: 'positions_unstable' }, { ended: true, reason: 'round_cap' },
    ]);
  }
});

test('command round cap asks once; a hanging human request times out to ballot', async () => {
  let asked = 0;
  const f = fake({ unstable: true, askHuman: () => { asked++; return new Promise(() => {}); } });
  const { result } = await runCouncil({ ...fixture(), invokedAs: 'command' }, f.deps);
  assert.equal(asked, 1); assert.equal(result.discussion.length, 2);
  assert.equal(result.discussion.at(-1).termination.reason, 'round_cap');
  assert.ok(result.digest.degradedReasons.includes('human_confirmation_missing')); assert.equal(result.ballots.length, 3);
});

test('command human confirmation defaults to 120 seconds and aborts the timed out request', async () => {
  const input = { ...fixture(), invokedAs: 'command' }; delete input.config.discussion.humanConfirmationTimeoutMs;
  let request, asked = 0;
  const delays = [], f = fake({ unstable: true, askHuman: value => { request = value; asked++; return new Promise(() => {}); } });
  f.deps.clock = { setTimeout(callback, ms) { delays.push(ms); return setTimeout(callback, ms === 120000 ? 1 : ms); }, clearTimeout };
  const { result } = await runCouncil(input, f.deps);
  assert.equal(asked, 1); assert.equal(request.timeoutMs, 120000); assert.equal(request.signal.aborted, true);
  assert.ok(delays.includes(120000)); assert.equal(result.ballots.length, 3);
  assert.ok(result.degradedReasons.includes('human_confirmation_missing'));
});

test('human continuation extends only once and passes prior responses to each new child', async () => {
  let asked = 0;
  const f = fake({ unstable: true, askHuman: async () => { asked++; return { answered: true, choice: 'continue' }; } });
  const { result } = await runCouncil({ ...fixture(), invokedAs: 'command' }, f.deps);
  assert.equal(asked, 1); assert.equal(result.discussion.length, 3);
  assert.equal(result.discussion[1].termination.ended, false); assert.equal(result.discussion[2].termination.ended, true);
  assert.equal(result.discussion[1].termination.reason, 'human_decided'); assert.equal(result.discussion[2].termination.reason, 'round_cap');
  assert.match(f.calls.find(c => c.label === 'magi-discussion-A' && c.prompt.includes('round=2')).prompt, /own-previous-responses/);
});

test('explicit human ballot and configured proceed terminate at the cap', async () => {
  const f = fake({ unstable: true, askHuman: async () => ({ answered: true, choice: 'ballot' }) });
  const { result } = await runCouncil({ ...fixture(), invokedAs: 'command' }, f.deps);
  assert.equal(result.discussion.at(-1).termination.reason, 'human_decided');
  const g = fake({ unstable: true, askHuman: () => assert.fail('must not ask') });
  const next = await runCouncil(fixture({ discussion: { maxRounds: 1, onExhaustion: 'proceed' } }), g.deps);
  assert.equal(next.result.discussion.length, 1); assert.equal(next.result.discussion[0].termination.reason, 'round_cap');
});

test('missing discussion response is not treated as stable agreement', async () => {
  const f = fake({ reply(kind, ref) { if (kind === 'discussion' && ref === 'C') return { ok: true, text: '{}' }; } });
  const { result } = await runCouncil(fixture(), f.deps);
  assert.equal(result.discussion.length, 2); assert.ok(result.digest.degradedReasons.includes('discussion_missing:C'));
  assert.equal(result.discussion[0].responses.length, 2);
});

for (const invalid of [false, true]) test(`minutes ${invalid ? 'invalid' : 'failure'} preserves verdict and uses template`, async () => {
  const f = fake(invalid ? { invalidMinutes: true } : { minutesError: true });
  const { result } = await runCouncil(fixture(), f.deps);
  assert.equal(result.digest.verdict, 'approve'); assert.equal(result.digest.status, 'degraded');
  assert.match(result.minutes.summary, /3 seats/);
  assert.ok(result.digest.degradedReasons.includes(invalid ? 'minutes_invalid' : 'minutes_failed'));
  if (invalid) {
    const error = result.errors.find(e => e.code === 'MINUTES_INVALID');
    assert.ok(error.cause.length <= 1000);
    assert.deepEqual(JSON.parse(error.cause).errors, ['verdict: forbidden top-level minutes field']);
    assert.ok(JSON.parse(error.cause).rawLength > 0); assert.equal(result.minutes.minutesStatus, 'invalid');
  }
});

test('total deadline retains completed evidence and stops later stages even if a child hangs', async () => {
  const input = fixture({ execution: { concurrency: 1, totalTimeoutMs: 30, briefTimeoutMs: 1000 } });
  const f = fake({ reply(kind, ref) { if (kind === 'brief' && ref === 'B') return new Promise(() => {}); } });
  const { result } = await runCouncil(input, f.deps);
  assert.equal(result.seatBriefs[0].status, 'completed'); assert.equal(f.calls.length, 2);
  assert.ok(result.digest.degradedReasons.includes('budget_exceeded'));
  assert.equal(result.digest.verdict, 'insufficient'); assert.equal(result.coverage.interrupted, true);
  assert.equal(f.minuteCalls.length, 0);
});

test('a timeout retry cannot extend the shared review deadline or start later seats', async () => {
  let attempts = 0;
  const input = fixture({ execution: { concurrency: 1, totalTimeoutMs: 20, briefTimeoutMs: 1000 } });
  const f = fake({ reply(kind, ref) {
    assert.equal(kind, 'brief'); assert.equal(ref, 'A');
    if (++attempts === 1) return { ok: false, error: { code: 'REVIEWER_TIMEOUT' } };
    return new Promise(() => {});
  } });
  const { result } = await runCouncil(input, f.deps);
  assert.equal(attempts, 2); assert.equal(f.calls.length, 2);
  assert.equal(f.calls.at(-1).signal.aborted, true);
  assert.equal(result.seatBriefs[0].error.attempts, 2);
  assert.ok(result.degradedReasons.includes('budget_exceeded')); assert.ok(result.degradedReasons.includes('timeout'));
  assert.equal(result.coverage.interrupted, true); assert.equal(f.minuteCalls.length, 0);
});

test('concurrency is bounded across all phases', async () => {
  let running = 0, peak = 0;
  const f = fake({ async reply() { running++; peak = Math.max(peak, running); await new Promise(resolve => setTimeout(resolve, 2)); running--; } });
  await runCouncil(fixture({ execution: { concurrency: 2 } }), f.deps);
  assert.equal(peak, 2);
});

test('all failed briefs yield error/none with no ballot or minutes calls', async () => {
  const f = fake({ reply() { return { ok: false }; } });
  const { result } = await runCouncil(fixture(), f.deps);
  assert.equal(result.digest.status, 'error'); assert.equal(result.digest.verdict, 'none');
  assert.equal(result.ballots.length, 0); assert.equal(f.minuteCalls.length, 0);
});

test('increasing disputes prevents first-round stability even without changed positions', async () => {
  const f = fake({ reply(kind, ref, round) {
    if (kind === 'discussion') return wire({ ...discussion(ref, round), disagreesWith: [{ seatRef: ref === 'A' ? 'B' : 'A', reason: 'Evidence contested' }] });
  } });
  const { result } = await runCouncil(fixture(), f.deps);
  assert.equal(result.discussion.length, 2); assert.equal(result.discussion[0].termination.ended, false);
  assert.equal(result.discussion[0].termination.reason, 'positions_unstable');
  assert.equal(result.discussion[1].termination.reason, 'positions_stable');
});

test('token budget and reported cost stop subsequent calls without claiming a timeout', async () => {
  const f = fake(), input = fixture(); input.config.execution.maxInputTokens = 1;
  const token = await runCouncil(input, f.deps);
  assert.equal(f.calls.length, 0); assert.ok(token.degradedReasons.includes('budget_exceeded'));
  assert.ok(!token.degradedReasons.includes('timeout'));
  const g = fake({ reply(kind, ref) { if (kind === 'brief') return wire(brief(ref), { usage: { estimatedCostUsd: 1 } }); } });
  const cost = await runCouncil(fixture({ execution: { concurrency: 1 } }), g.deps);
  assert.equal(g.calls.length, 1); assert.equal(cost.result.digest.verdict, 'insufficient');
  assert.ok(cost.degradedReasons.includes('budget_exceeded'));
});

test('secrets returned by a brief are redacted before discussion and minutes', async () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwx';
  const f = fake({ reply(kind, ref) { if (kind === 'brief') return wire({ ...brief(ref), summary: secret }); } });
  const { result } = await runCouncil(fixture(), f.deps);
  assert.ok(result.redaction.count >= 3);
  assert.doesNotMatch(JSON.stringify(f.calls), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(f.minuteCalls), new RegExp(secret));
});

test('real llm-json invalid-output code selects minutes_invalid', async () => {
  const f = fake(); f.deps.callLlmJsonValidated = async () => ({ ok: false, error: { code: 'LLM_OUTPUT_INVALID' } });
  const { result } = await runCouncil(fixture(), f.deps);
  assert.ok(result.digest.degradedReasons.includes('minutes_invalid')); assert.equal(result.digest.verdict, 'approve');
});

test('real minutes validation failures retain only bounded schema diagnostics and raw length', async () => {
  for (const raw of [JSON.stringify({ ...minutes(), seatSummaries: Array.from({ length: 100 }, () => ({
    seatId: 'private-seat-identity', label: 'private-model-identity', view: 42,
  })), recommendation: 'private raw output' }), 'private raw output: {']) {
    const f = fake(), input = fixture(); delete f.deps.callLlmJsonValidated;
    input.ctx = { get: name => name === 'llm' ? { async *stream() { yield { type: 'text-delta', text: raw }; } } : {} };
    const { result } = await runCouncil(input, f.deps);
    const error = result.errors.find(e => e.code === 'MINUTES_INVALID');
    assert.equal(typeof error.cause, 'string'); assert.ok(error.cause.length <= 1000);
    const diagnostic = JSON.parse(error.cause);
    assert.equal(diagnostic.rawLength, raw.length); assert.ok(diagnostic.errors.length > 0);
    assert.doesNotMatch(error.cause, /private-seat|private-model|private raw/);
    if (raw.startsWith('{')) assert.match(diagnostic.errors.join(';'), /view: expected string/);
    assert.match(result.minutes.summary, /3 seats/); assert.equal(result.minutes.minutesStatus, 'invalid');
    assert.equal(result.decision.verdict, 'approve');
  }
});

test('fixed evidence violations explain the minutes fallback without leaking identities', async () => {
  const f = fake(), value = minutes(); value.seatSummaries[0].seatId = 'private-seat-identity';
  f.deps.callLlmJsonValidated = async () => ({ ok: true, value, raw: JSON.stringify(value) });
  const { result } = await runCouncil(fixture(), f.deps);
  const diagnostic = JSON.parse(result.errors.find(e => e.code === 'MINUTES_INVALID').cause);
  assert.deepEqual(diagnostic.errors, ['seatSummaries: must contain each revealed seat exactly once']);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private-seat/); assert.equal(result.minutes.minutesStatus, 'invalid');
});

test('normalized minutes with absent labels and status succeed without fallback', async () => {
  const f = fake(), value = minutes(); delete value.minutesStatus;
  for (const seat of value.seatSummaries) delete seat.label;
  f.deps.callLlmJsonValidated = async () => ({ ok: true, value });
  const { result } = await runCouncil(fixture(), f.deps);
  assert.equal(result.minutes.summary, value.summary); assert.equal(result.minutes.minutesStatus, 'ok');
  assert.deepEqual(result.minutes.seatSummaries.map(s => s.label), ['architect', 'engineer', 'adversary']);
  assert.deepEqual(result.errors, []);
});

test('invalid text retries once with a compact prompt and repaired minutes clear related degradation', async () => {
  for (const first of ['short invalid text', 'Long nonobject response. '.repeat(30)]) {
    const f = fake(), input = fixture(), requests = [];
    delete f.deps.callLlmJsonValidated;
    input.degradedReasons = ['minutes_invalid', 'minutes_failed'];
    const value = { summary: 'Recovered minutes', seatSummaries: minutes().seatSummaries.map(({ seatId }) => ({ seatId })), evidenceStrength: 'moderate' };
    input.ctx = { get: name => name === 'llm' ? { async *stream(request) {
      requests.push(request);
      yield { type: 'text-delta', text: requests.length === 1 ? first : JSON.stringify(value) };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } } : {} };
    const { result } = await runCouncil(input, f.deps);
    assert.equal(requests.length, 2); assert.deepEqual(requests.map(r => r.maxTokens), [6000, 4000]);
    const prompts = requests.map(r => r.messages[0].content[0].text);
    assert.ok(prompts.every(p => p.length <= 24000)); assert.ok(prompts[1].length < prompts[0].length);
    assert.match(prompts[0], /discussion-and-vote-changes/); assert.doesNotMatch(prompts[1], /discussion-and-vote-changes/);
    assert.equal(result.minutes.summary, value.summary); assert.equal(result.minutes.minutesStatus, 'ok');
    assert.ok(result.minutes.seatSummaries.every(s => s.view === ''));
    assert.deepEqual(result.degradedReasons, []); assert.deepEqual(result.errors, []);
    assert.equal(result.digest.status, 'completed'); assert.equal(result.digest.trust, 'trustworthy');
    assert.deepEqual(input.degradedReasons, ['minutes_invalid', 'minutes_failed']);
    assert.equal(result.metadata.usage.inputTokens, 20); assert.equal(result.metadata.usage.outputTokens, 10);
    const expectedInput = f.calls.reduce((sum, c) => sum + Math.ceil(c.prompt.length / 3), 0)
      + requests.reduce((sum, r) => sum + Math.ceil(`${r.system}\n\n${r.messages[0].content[0].text}`.length / 3), 0);
    assert.equal(result.metadata.usage.estimatedInputTokens, expectedInput);
  }
});

test('two short invalid responses use template minutes and bounded diagnostics with attempts=2', async () => {
  const f = fake(), input = fixture(); delete f.deps.callLlmJsonValidated;
  let calls = 0;
  const raw = 'private invalid response';
  input.ctx = { get: name => name === 'llm' ? { async *stream() {
    calls++;
    yield { type: 'text-delta', text: raw };
    yield { type: 'finish', reason: { kind: calls === 1 ? 'stop' : 'max-tokens', message: 'private provider details' } };
  } } : {} };
  const { result } = await runCouncil(input, f.deps);
  assert.equal(calls, 2); assert.equal(result.minutes.minutesStatus, 'invalid'); assert.match(result.minutes.summary, /3 seats/);
  assert.equal(result.decision.verdict, 'approve');
  assert.deepEqual(result.errors.filter(e => e.stage === 'minutes').map(e => e.code), ['MINUTES_INVALID']);
  const cause = result.errors.find(e => e.code === 'MINUTES_INVALID').cause;
  assert.ok(cause.length <= 1000); assert.doesNotMatch(cause, /private/);
  assert.deepEqual(JSON.parse(cause), { errors: ['Expected an object'], rawLength: raw.length, finishReason: 'max-tokens', attempts: 2 });
  assert.equal(result.degradedReasons.filter(r => r === 'minutes_invalid').length, 1);
});

test('short validation errors retry, but transport errors and long schema violations do not', async () => {
  for (const kind of ['short-schema', 'transport', 'long-schema']) {
    const f = fake(), input = fixture(); delete f.deps.callLlmJsonValidated;
    let calls = 0;
    input.ctx = { get: name => name === 'llm' ? { async *stream() {
      calls++;
      yield { type: 'text-delta', text: kind === 'short-schema' ? '{}' : JSON.stringify({ ...minutes(), recommendation: 'Forbidden' }) };
      yield { type: 'finish', reason: { kind: kind === 'transport' ? 'error' : 'stop' } };
    } } : {} };
    const { result } = await runCouncil(input, f.deps);
    assert.equal(calls, kind === 'short-schema' ? 2 : 1);
    assert.equal(result.errors.at(-1).code, kind === 'transport' ? 'MINUTES_FAILED' : 'MINUTES_INVALID');
  }
});

test('compact retries still enforce fixed vote changes and dissent after defaulting absent arrays', async () => {
  const f = fake({ reply(kind, ref) {
    if (kind === 'ballot' && ref === 'C') return wire({ ...ballot(ref), finalVerdict: 'request_changes', changedFromBrief: true, changeReason: 'Minority evidence' });
  } });
  let calls = 0;
  f.deps.callLlmJsonValidated = async () => ++calls === 1
    ? { ok: false, raw: 'invalid', error: { code: 'LLM_OUTPUT_INVALID' } }
    : { ok: true, value: { summary: 'No disagreement', seatSummaries: minutes().seatSummaries, evidenceStrength: 'moderate' } };
  const { result } = await runCouncil(fixture(), f.deps);
  assert.equal(calls, 2); assert.equal(result.minutes.minutesStatus, 'invalid');
  assert.equal(result.minutes.dissent[0].reason, 'Minority evidence'); assert.equal(result.minutes.voteChanges.length, 1);
  const diagnostic = JSON.parse(result.errors.at(-1).cause);
  assert.equal(diagnostic.attempts, 2);
  assert.ok(diagnostic.errors.some(e => e.startsWith('voteChanges:'))); assert.ok(diagnostic.errors.some(e => e.startsWith('dissent:')));
});

test('minutes retries respect the shared cost budget', async () => {
  const f = fake(), input = fixture({ execution: { maxCostUsd: 1 } });
  let calls = 0;
  f.deps.callLlmJsonValidated = async () => {
    calls++;
    return { ok: false, raw: 'invalid', attempts: 1, usage: { estimatedCostUsd: 1 }, error: { code: 'LLM_OUTPUT_INVALID' } };
  };
  const { result } = await runCouncil(input, f.deps);
  assert.equal(calls, 1); assert.ok(result.degradedReasons.includes('budget_exceeded'));
  assert.equal(JSON.parse(result.errors.at(-1).cause).attempts, 1); assert.match(result.minutes.summary, /3 seats/);
});

test('usage estimates include every seat reply and retry while retaining reported token totals', async () => {
  let outputEstimate = 0, attempts = 0;
  const f = fake({ reply(kind, ref, round) {
    const text = kind === 'brief' && ref === 'A' && ++attempts === 1 ? 'invalid JSON'
      : JSON.stringify(kind === 'brief' ? brief(ref) : kind === 'ballot' ? ballot(ref) : discussion(ref, round));
    outputEstimate += Math.ceil(text.length / 3);
    return { ok: true, text, usage: { inputTokens: 7, outputTokens: 5 } };
  } });
  const { result } = await runCouncil(fixture(), f.deps), usage = result.metadata.usage;
  const inputEstimate = f.calls.reduce((sum, c) => sum + Math.ceil(c.prompt.length / 3), 0)
    + f.minuteCalls.reduce((sum, c) => sum + Math.ceil(`${c.request.system}\n\n${c.request.user}`.length / 3), 0);
  assert.equal(f.calls.length, 10); assert.equal(usage.estimatedInputTokens, inputEstimate);
  assert.equal(result.metadata.estimatedInputTokens, inputEstimate); assert.equal(usage.estimatedOutputTokens, outputEstimate);
  assert.equal(usage.inputTokens, 70); assert.equal(usage.outputTokens, 50);
  assert.equal(usage.seatsUsed, 3); assert.equal(usage.rounds, 1);
});

test('usage remains populated without provider usage and records inherited budget overruns', async () => {
  const f = fake(), { result } = await runCouncil(fixture(), f.deps);
  assert.ok(result.metadata.usage.estimatedInputTokens > 0); assert.ok(result.metadata.usage.estimatedOutputTokens > 0);
  assert.equal(result.metadata.usage.seatsUsed, 3); assert.equal(result.metadata.usage.rounds, 1);
  const input = fixture(); input.config.execution.maxInputTokens = 10; input.usage = { estimatedInputTokens: 11 };
  const g = fake(), exceeded = await runCouncil(input, g.deps);
  assert.equal(g.calls.length, 0); assert.ok(exceeded.degradedReasons.includes('budget_exceeded'));
  assert.deepEqual(exceeded.result.metadata.usage, { estimatedInputTokens: 11, estimatedOutputTokens: 0, seatsUsed: 0, rounds: 0 });
  assert.equal(exceeded.result.metadata.estimatedInputTokens, 11);
});
