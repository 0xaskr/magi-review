import { findingFingerprint } from './fingerprint.js';
import { buildDigest } from './digest.js';

/** Bound displayed text, including the ellipsis, without splitting a surrogate pair. */
export function clip(text, maxChars) {
  const value = String(text ?? '');
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return '';
  let end = maxChars - 1;
  if (/[\uD800-\uDBFF]/u.test(value[end - 1])) end--;
  return value.slice(0, end) + '…';
}

/** Deterministic fallback minutes contain observations only, never advice.
 * @param {import('./types.js').ReviewResult} result
 * @returns {import('./types.js').CouncilMinutes}
 */
export function buildTemplateMinutes(result) {
  const digest = buildDigest(result);
  const briefs = result.seatBriefs ?? [], ballots = result.ballots ?? [];
  const reveal = result.reveal?.seats ?? [];
  const identity = ref => reveal.find(s => s.seatRef === ref)?.seatId ?? briefs.find(b => b.seatRef === ref)?.seatId ?? ref;
  const label = ref => reveal.find(s => s.seatRef === ref)?.perspective ?? briefs.find(b => b.seatRef === ref)?.perspective ?? identity(ref);
  const finalVote = ref => ballots.find(b => b.seatRef === ref && b.status !== 'error')?.finalVerdict
    ?? reveal.find(s => s.seatRef === ref)?.finalVerdict ?? briefs.find(b => b.seatRef === ref && b.status === 'completed')?.verdict;
  const groups = new Map();
  function add(finding, refs) {
    const fingerprint = finding.fingerprint || findingFingerprint(finding);
    if (!groups.has(fingerprint)) groups.set(fingerprint, { title: finding.title, refs: new Set() });
    for (const ref of refs) groups.get(fingerprint).refs.add(ref);
  }
  for (const finding of result.findings ?? []) add(finding, finding.sourceSeatRefs ?? []);
  for (const brief of briefs.filter(b => b.status === 'completed')) for (const finding of brief.findings ?? []) add(finding, [brief.seatRef]);
  for (const ballot of ballots.filter(b => b.status !== 'error')) for (const finding of ballot.finalFindings ?? []) add(finding, [ballot.seatRef]);
  const consensus = [], disputes = [];
  for (const [fingerprint, group] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const refs = [...group.refs].sort();
    if (refs.length < 2) continue;
    consensus.push({ fingerprint, statement: clip(`${refs.length} seats reported: ${group.title}`, 400) });
    const initial = new Set(refs.map(ref => briefs.find(b => b.seatRef === ref)?.verdict).filter(Boolean));
    const final = new Set(refs.map(finalVote).filter(Boolean));
    if (initial.size > 1 || final.size > 1) disputes.push({ fingerprint, seats: refs.map(identity), point: clip(group.title, 400), resolved: final.size === 1 && refs.every(ref => finalVote(ref)) });
  }
  const responses = (result.discussion ?? []).flatMap(round => round.responses ?? []);
  const voteChanges = ballots.flatMap(ballot => {
    const brief = briefs.find(b => b.seatRef === ballot.seatRef && b.status === 'completed');
    if (!brief?.verdict || ballot.status === 'error' || brief.verdict === ballot.finalVerdict) return [];
    return [{ seatId: identity(ballot.seatRef), from: brief.verdict, to: ballot.finalVerdict,
      reason: clip(ballot.changeReason ?? responses.findLast(r => r.seatRef === ballot.seatRef && r.changeReason)?.changeReason ?? 'Final ballot differs from the brief.', 1200) }];
  });
  const unresolvedQuestions = responses.flatMap(response => (response.questions ?? []).map(question => ({
    from: identity(response.seatRef), ...(question.to ? { to: identity(question.to) } : {}), question: question.question,
  })));
  // DiscussionResponse has no answer/resolution field, so all recorded questions
  // remain unresolved in fallback minutes instead of inferring an answer.
  const uniqueQuestions = [...new Map(unresolvedQuestions.map(q => [JSON.stringify(q), q])).values()];
  const completed = briefs.filter(b => b.status === 'completed').length;
  const evidenceStrength = completed < 2 || digest.status === 'error' ? 'weak'
    : completed === briefs.length && completed >= 3 && digest.counts.blocking > 0 && digest.status === 'completed' ? 'strong' : 'moderate';
  return {
    summary: `${briefs.length} seats, ${digest.approveVotes} approve, ${digest.requestVotes} request_changes, ${digest.counts.blocking} blocking findings, ${digest.rounds} discussion rounds; ${digest.status === 'degraded' ? 'degraded' : digest.status}.`,
    seatSummaries: briefs.map(b => ({ seatId: identity(b.seatRef), label: label(b.seatRef), view: clip(b.summary, 1200) })),
    consensus, disputes, voteChanges, unresolvedQuestions: uniqueQuestions.map(q => ({ ...q, question: clip(q.question, 300) })), evidenceStrength,
    dissent: (result.decision?.dissent ?? ballots.filter(b => b.status !== 'error' && b.finalVerdict !== digest.verdict).map(b => ({
      seatRef: b.seatRef, verdict: b.finalVerdict, reason: b.reason ?? b.changeReason ?? b.finalFindings?.map(f => f.rationale).filter(Boolean).join('\n') ?? '',
    }))).map(d => ({ seatId: identity(d.seatRef), verdict: d.verdict, reason: clip(d.reason, 1200) })),
    minutesStatus: 'ok',
  };
}
