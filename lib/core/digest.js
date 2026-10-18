import { stableStringify } from './json.js';
import { tallyBallots } from './anonymity.js';

/** Build all v1.1 digest fields from a full or in-progress result. The optional
 * vote counts and first ten findings are additive fields for the text renderer.
 * @param {import('./types.js').ReviewResult} result
 * @returns {import('./types.js').ReviewDigest}
 */
export function buildDigest(result = {}) {
  result ??= {};
  const previous = result.digest ?? {}, decision = result.decision ?? {};
  // Do not reuse narrative, findings or an old digest before this result's reveal.
  if (result.reveal?.at !== 'verdict') {
    return {
      reviewId: result.reviewId ?? previous.reviewId ?? result.reportId ?? previous.reportId ?? '',
      reportId: result.reportId ?? previous.reportId ?? result.reviewId ?? previous.reviewId ?? '',
      mode: result.mode === 'quick' || previous.mode === 'quick' ? 'quick' : 'council',
      revealed: false, status: 'error', verdict: 'none', trust: 'untrustworthy', overallImpact: 'unknown',
      summary: 'review not revealed', seats: [], counts: { findings: 0, blocking: 0 },
      target: { kind: 'patch', files: 0, partial: true }, homogeneous: false,
      rounds: 0, durationMs: 0, degradedReasons: [], findings: [],
    };
  }
  const briefs = result.seatBriefs ?? [], ballots = result.ballots ?? [];
  const tally = tallyBallots(ballots);
  const findings = result.findings ?? previous.findings ?? [];
  const coverage = result.coverage ?? {};
  const target = result.scope?.target ?? result.target ?? previous.target ?? { kind: 'patch' };
  const status = decision.status ?? result.status ?? previous.status ?? 'error';
  const verdict = decision.verdict ?? result.verdict ?? previous.verdict ?? 'none';
  const trust = status === 'error' || verdict === 'none' ? 'untrustworthy'
    : status === 'degraded' || verdict === 'insufficient' ? 'needs_review'
      : decision.trust ?? result.trust ?? previous.trust ?? 'trustworthy';
  const seats = (result.reveal.seats ?? []).map(seat => ({
      seatId: seat.seatId, label: seat.perspective || seat.seatId,
      ...(seat.finalVerdict ? { verdict: seat.finalVerdict } : {}), changed: seat.changed,
      status: briefs.find(b => b.seatRef === seat.seatRef)?.status ?? 'error',
    }));
  const elapsed = Date.parse(result.metadata?.finishedAt ?? '') - Date.parse(result.metadata?.startedAt ?? '');
  const durationMs = result.durationMs ?? result.metadata?.durationMs ?? (Number.isFinite(elapsed) ? Math.max(0, elapsed) : previous.durationMs ?? 0);
  const counts = result.findings ? { findings: findings.length, blocking: findings.filter(f => f.status === 'blocking').length }
    : previous.counts ?? { findings: findings.length, blocking: findings.filter(f => f.status === 'blocking').length };
  return {
    reviewId: result.reviewId ?? previous.reviewId ?? result.reportId ?? previous.reportId ?? '',
    mode: result.mode ?? previous.mode ?? 'council', revealed: true, status, trust, verdict,
    overallImpact: decision.overallImpact ?? result.overallImpact ?? previous.overallImpact ?? 'unknown',
    summary: decision.rationale ?? previous.summary ?? `${verdict}; ${counts.blocking} blocking findings.`,
    seats, counts,
    target: { kind: target.kind, ...(target.baseRef ? { baseRef: target.baseRef } : {}),
      files: result.scope?.files?.length ?? result.target?.files?.length ?? coverage.totalFiles ?? previous.target?.files ?? 0,
      partial: coverage.partial ?? previous.target?.partial ?? false },
    homogeneous: result.metadata?.homogeneous ?? result.homogeneous ?? previous.homogeneous ?? false,
    rounds: result.discussion?.length ?? previous.rounds ?? 0, durationMs,
    degradedReasons: [...(result.degradedReasons ?? previous.degradedReasons ?? [])],
    reportId: result.reportId ?? previous.reportId ?? result.reviewId ?? previous.reviewId ?? '',
    approveVotes: decision.approveVotes ?? (result.ballots ? tally.approve : previous.approveVotes ?? 0),
    requestVotes: decision.requestVotes ?? (result.ballots ? tally.request : previous.requestVotes ?? 0),
    findings: structuredClone(findings.slice(0, 10)),
  };
}

const bytes = text => new TextEncoder().encode(text).length;
function compact(value, limit) {
  const points = [...String(value ?? '').replace(/\s+/gu, ' ').trim()];
  return points.length <= limit ? points.join('') : points.slice(0, limit - 1).join('') + '…';
}

/** Plain text capped at both 4096 UTF-16 characters and 4096 UTF-8 bytes.
 * Whole finding lines are omitted when the limit is reached; reportId is reserved.
 * @param {import('./types.js').ReviewDigest} digest @returns {string}
 */
export function renderDigestText(digest) {
  const footer = `reportId: ${compact(digest.reportId, 256)}`;
  if (digest.revealed !== true) return `review not revealed\n${footer}`;
  const lines = [
    `${compact(digest.verdict, 32)} / ${compact(digest.status, 32)} / ${compact(digest.trust, 32)}`,
    `Votes: approve ${digest.approveVotes ?? digest.seats.filter(s => s.verdict === 'approve' && s.status === 'completed').length}, request_changes ${digest.requestVotes ?? digest.seats.filter(s => s.verdict === 'request_changes' && s.status === 'completed').length}; blocking ${digest.counts.blocking}; findings ${digest.counts.findings}.`,
  ];
  if (digest.verdict === 'insufficient') lines.push('INSUFFICIENT: evidence is insufficient; this is not approval.');
  if (digest.status === 'degraded' || digest.target.partial || digest.degradedReasons.length) {
    lines.push(`DEGRADED: coverage ${digest.target.partial ? 'partial' : 'full'}; ${compact(digest.degradedReasons.join(', ') || 'seat or execution failure', 200)}.`);
  }
  const optional = [
    `Seats: ${digest.seats.map(s => `${compact(s.label || s.seatId, 48)}=${compact(s.verdict ?? 'missing', 24)} (${compact(s.status, 16)}${s.changed ? ', changed' : ''})`).join('; ')}`,
    ...(digest.findings ?? []).slice(0, 10).map(f => `${compact(f.severity, 12)} ${compact(f.location?.path ?? f.path ?? '?', 160)}:${f.location?.line ?? f.location?.range?.start ?? '?'} ${compact(f.title, 240)}`),
  ];
  let omitted = (digest.findings?.length ?? 0) > 10 || digest.counts.findings > (digest.findings?.length ?? 0);
  for (const line of optional) {
    const candidate = [...lines, line, '…', footer].join('\n');
    if (candidate.length > 4096 || bytes(candidate) > 4096) { omitted = true; break; }
    lines.push(line);
  }
  if (omitted) lines.push('…');
  lines.push(footer);
  return lines.join('\n');
}

/** @param {*} value @returns {string|undefined} */
export function renderToolJson(value) { return stableStringify(value); }
