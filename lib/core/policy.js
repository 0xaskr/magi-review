import { findingFingerprint } from './fingerprint.js';
import { assignSeatRefs } from './anonymity.js';

const rank = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const fingerprintOf = finding => finding.fingerprint || findingFingerprint(finding);

/** @param {import('./types.js').AggregatedFinding} finding
 * @param {import('./types.js').Policy} [policy]
 * @param {import('./types.js').AggregatedFinding[]} [findings] @returns {boolean}
 */
export function isBlockingFinding(finding, policy = {}, findings = []) {
  if (finding.introducedByChange !== true) return false;
  if (finding.severity === 'critical') return true;
  if (rank[finding.severity] >= (rank[policy.blockingSeverity] ?? rank.high) && finding.confidence !== 'low') return true;
  if (finding.mustFix !== true) return false;
  const fingerprint = fingerprintOf(finding);
  const refs = new Set(finding.sourceSeatRefs ?? []);
  for (const other of findings) {
    if (fingerprintOf(other) === fingerprint) for (const ref of other.sourceSeatRefs ?? []) refs.add(ref);
  }
  return refs.size >= 2;
}

/** @param {import('./types.js').AggregatedFinding[]} findings
 * @param {import('./types.js').Policy} [policy] @returns {import('./types.js').AggregatedFinding[]}
 */
export function applyBlockingStatus(findings, policy = {}) {
  return findings.map(f => ({ ...structuredClone(f), status: isBlockingFinding(f, policy, findings) ? 'blocking' : 'non_blocking' }));
}

/** @param {number} n @returns {number} */
export function expectedQuorum(n) { return Math.floor(n / 2) + 1; }

/** Count only one valid, successfully submitted ballot per expected completed
 * seat. Missing, invalid and duplicate ballots count as failures, never votes.
 * @param {import('./types.js').DecisionInput} input
 * @param {'majority'|'unanimous'} effectivePolicy
 * @returns {import('./types.js').Decision}
 */
function decideWithPolicy(input, effectivePolicy) {
  const { seats, ballots, findings = [], coverage = {}, degradedReasons = [], policy = {} } = input;
  const refs = assignSeatRefs(seats).map((seat, index) => seats[index].seatRef ?? seat.seatRef);
  const q = expectedQuorum(seats.length);
  if (new Set(refs).size !== refs.length || refs.some(ref => typeof ref !== 'string' || !ref.trim())) {
    return {
      verdict: 'none', status: 'error', trust: 'untrustworthy',
      declaredPolicy: policy.approval ?? effectivePolicy, effectivePolicy, escalatedBy: policy.escalatedBy ?? 'none',
      approveVotes: 0, requestVotes: 0, expectedQuorum: q, blockingFindings: [], dissent: [],
      rationale: 'invalid_seat_refs: expected unique, nonempty seat references; no ballots counted.', overallImpact: 'unknown',
    };
  }
  // A duplicate invalidates the entire seat, including an otherwise valid vote.
  const byRef = new Map();
  for (const ballot of ballots) byRef.set(ballot.seatRef, byRef.has(ballot.seatRef) ? null : ballot);
  const valid = [], failed = [];
  seats.forEach((seat, index) => {
    const seatRef = refs[index];
    const ballot = byRef.get(seatRef);
    if (seat.status !== 'completed' || ballot?.status === 'error'
      || !['approve', 'request_changes'].includes(ballot?.finalVerdict)) failed.push(seatRef);
    else valid.push(ballot);
  });
  const approveVotes = valid.filter(b => b.finalVerdict === 'approve').length;
  const requestVotes = valid.filter(b => b.finalVerdict === 'request_changes').length;
  const marked = applyBlockingStatus(findings, policy);
  const blockingFindings = marked.filter(f => f.status === 'blocking');
  const blockingCount = new Set(blockingFindings.map(fingerprintOf)).size;
  const partial = coverage.partial === true || coverage.interrupted === true || input.interrupted === true;
  const degraded = failed.length > 0 || degradedReasons.length > 0 || partial;
  const status = valid.length === 0 ? 'error' : degraded ? 'degraded' : 'completed';
  let verdict;
  if (!valid.length) verdict = 'none';
  else if (blockingCount) verdict = 'request_changes';
  else if (effectivePolicy === 'unanimous') {
    verdict = requestVotes > 0 ? 'request_changes' : !partial && approveVotes === seats.length ? 'approve' : 'insufficient';
  } else if (partial) verdict = 'insufficient';
  else if (requestVotes >= q && requestVotes > approveVotes) verdict = 'request_changes';
  else if (approveVotes >= q && approveVotes > requestVotes) verdict = 'approve';
  else if (approveVotes === requestVotes && approveVotes > 0) verdict = 'request_changes';
  else verdict = 'insufficient';
  const trust = status === 'error' || verdict === 'none' ? 'untrustworthy'
    : status === 'degraded' || verdict === 'insufficient' ? 'needs_review' : 'trustworthy';
  const dissent = valid.filter(b => b.finalVerdict !== verdict).map(b => ({
    seatRef: b.seatRef, verdict: b.finalVerdict,
    reason: b.reason ?? b.changeReason ?? b.summary ?? b.finalFindings?.map(f => f.rationale).filter(Boolean).join('\n') ?? '',
  }));
  const rationale = `${effectivePolicy}: ${approveVotes} approve, ${requestVotes} request_changes, quorum ${q}/${seats.length}, ${blockingCount} blocking fingerprints, coverage ${partial ? 'partial/interrupted' : 'full'}, ${degradedReasons.length} degradation reasons${failed.length ? `, failed or missing ballots: ${failed.join(', ')}` : ''}; verdict ${verdict}.`;
  return {
    verdict, status, trust, declaredPolicy: policy.approval ?? effectivePolicy, effectivePolicy,
    escalatedBy: policy.escalatedBy ?? 'none', approveVotes, requestVotes, expectedQuorum: q,
    blockingFindings, dissent, rationale,
    overallImpact: !valid.length ? 'unknown' : valid.filter(b => b.finalImpact === 'major').length >= q ? 'major' : 'normal',
  };
}

/** @param {import('./types.js').DecisionInput} input @returns {import('./types.js').Decision} */
export function decideMajority(input) { return decideWithPolicy(input, 'majority'); }

/** @param {import('./types.js').DecisionInput} input @returns {import('./types.js').Decision} */
export function decideUnanimous(input) { return decideWithPolicy(input, 'unanimous'); }

/** @param {import('./types.js').DecisionInput} input @returns {import('./types.js').Decision} */
export function decide(input) {
  const declaredPolicy = input.policy?.approval ?? 'majority';
  const escalated = declaredPolicy === 'majority' && input.policy?.escalateOnRisk === true && input.risk?.level === 'high';
  const decision = decideWithPolicy(input, escalated ? 'unanimous' : declaredPolicy);
  return { ...decision, declaredPolicy, escalatedBy: escalated ? 'risk' : decision.escalatedBy };
}
