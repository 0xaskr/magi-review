/** Small in-memory contract fixtures; no file access. */
export function finding(overrides = {}) {
  return { id: 'local-1', location: { path: 'src/reader.js', side: 'new', line: 10 }, severity: 'medium', confidence: 'medium',
    category: 'correctness', title: 'Missing boundary check', rationale: 'The last item exceeds the range.',
    mustFix: false, introducedByChange: true, ...overrides };
}

export function brief(seatRef = 'A', overrides = {}) {
  return { seatRef, status: 'completed', verdict: 'approve', impact: 'normal', findings: [], summary: 'Reviewed the boundary.', ...overrides };
}

export function ballot(seatRef = 'A', overrides = {}) {
  return { seatRef, finalVerdict: 'approve', finalImpact: 'normal', finalFindings: [], changedFromBrief: false, ...overrides };
}

export function decisionInput(votes = ['A', 'A', 'A'], overrides = {}) {
  return {
    seats: votes.map((vote, i) => ({ seatId: `seat-${i}`, seatRef: String.fromCharCode(65 + i), status: vote === 'E' ? 'error' : 'completed' })),
    ballots: votes.flatMap((vote, i) => vote === 'E' ? [] : [ballot(String.fromCharCode(65 + i), { finalVerdict: vote === 'A' ? 'approve' : 'request_changes' })]),
    findings: [], coverage: { partial: false }, degradedReasons: [], policy: { approval: 'majority' }, ...overrides,
  };
}

export function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}

export function reviewResult(overrides = {}) {
  return {
    reviewId: 'review-1', reportId: 'report-1', mode: 'council', status: 'completed', verdict: 'approve', trust: 'trustworthy',
    overallImpact: 'normal', scope: { target: { kind: 'base-ref', baseRef: 'main' }, files: ['src/reader.js'] },
    coverage: { partial: false, totalFiles: 1, reviewedFiles: 1 }, findings: [],
    seatBriefs: ['A', 'B', 'C'].map(ref => brief(ref)), ballots: ['A', 'B', 'C'].map(ref => ballot(ref)), discussion: [],
    reveal: { at: 'verdict', seats: ['A', 'B', 'C'].map((ref, i) => ({ seatRef: ref, seatId: `seat-${i}`, perspective: `view-${i}`,
      provider: 'provider', model: 'model', briefVerdict: 'approve', finalVerdict: 'approve', changed: false })) },
    decision: { approveVotes: 3, requestVotes: 0, expectedQuorum: 2, rationale: '3 approve, 0 request, 0 blocking.', dissent: [] },
    degradedReasons: [], metadata: { startedAt: '2026-10-18T00:00:00Z', finishedAt: '2026-10-18T00:00:02Z', homogeneous: true }, ...overrides,
  };
}
