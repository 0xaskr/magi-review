import { it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplateMinutes, clip } from '../../lib/core/minutes-template.js';
import { finding, brief, ballot, reviewResult, frozen } from '../fixtures/core-fixtures.js';

it('fallback minutes have the full contract with no recommendation/advice', () => {
  const minutes = buildTemplateMinutes(frozen(reviewResult()));
  assert.deepEqual(Object.keys(minutes).sort(), ['summary', 'seatSummaries', 'consensus', 'disputes', 'voteChanges', 'unresolvedQuestions', 'evidenceStrength', 'dissent', 'minutesStatus'].sort());
  assert.equal(minutes.minutesStatus, 'ok'); assert.match(minutes.summary, /3 seats, 3 approve, 0 request_changes, 0 blocking findings, 0 discussion rounds; completed/);
  assert.ok(!JSON.stringify(minutes).includes('"recommendation"')); assert.ok(!JSON.stringify(minutes).includes('"advice"'));
});
it('same fingerprint from two seats creates consensus and opposing votes create dispute', () => {
  const input = reviewResult({ seatBriefs: [brief('A', { findings: [finding({ fingerprint: 'fp' })] }), brief('B', { verdict: 'request_changes', findings: [finding({ fingerprint: 'fp' })] })],
    ballots: [ballot('A'), ballot('B', { finalVerdict: 'request_changes' })] });
  const minutes = buildTemplateMinutes(input); assert.equal(minutes.consensus[0].fingerprint, 'fp');
  assert.deepEqual(minutes.disputes[0].seats, ['seat-0', 'seat-1']); assert.equal(minutes.disputes[0].resolved, false);
});
it('single-seat duplicate findings do not create consensus', () => {
  const minutes = buildTemplateMinutes(reviewResult({ seatBriefs: [brief('A', { findings: [finding(), finding()] })] }));
  assert.deepEqual(minutes.consensus, []);
});
it('records bidirectional vote changes and reasons in revealed identities', () => {
  const input = reviewResult({ seatBriefs: [brief('A'), brief('B', { verdict: 'request_changes' })], ballots: [ballot('A', { finalVerdict: 'request_changes', changeReason: 'Reproduced failure.' }), ballot('B', { changeReason: 'Test disproved concern.' })] });
  const changes = buildTemplateMinutes(input).voteChanges;
  assert.deepEqual(changes, [{ seatId: 'seat-0', from: 'approve', to: 'request_changes', reason: 'Reproduced failure.' }, { seatId: 'seat-1', from: 'request_changes', to: 'approve', reason: 'Test disproved concern.' }]);
});
it('resolved disputes remain in the record and missing change reason uses discussion', () => {
  const input = reviewResult({ seatBriefs: [brief('A', { findings: [finding()] }), brief('B', { verdict: 'request_changes', findings: [finding()] })],
    ballots: [ballot('A'), ballot('B')], discussion: [{ index: 1, responses: [{ seatRef: 'B', positionChanged: true, changeReason: 'Checked execution.', questions: [] }] }] });
  const minutes = buildTemplateMinutes(input); assert.equal(minutes.disputes[0].resolved, true); assert.equal(minutes.voteChanges[0].reason, 'Checked execution.');
});
it('keeps unresolved questions and exact dissent reasons', () => {
  const input = reviewResult({ discussion: [{ index: 1, responses: [{ seatRef: 'A', questions: [{ to: 'B', question: 'What proves the invariant?' }] }] }],
    decision: { approveVotes: 2, requestVotes: 1, dissent: [{ seatRef: 'C', verdict: 'request_changes', reason: 'Exact minority concern.' }] } });
  const minutes = buildTemplateMinutes(input);
  assert.deepEqual(minutes.unresolvedQuestions, [{ from: 'seat-0', to: 'seat-1', question: 'What proves the invariant?' }]);
  assert.deepEqual(minutes.dissent, [{ seatId: 'seat-2', verdict: 'request_changes', reason: 'Exact minority concern.' }]);
});
it('evidence strength uses completed seats and blocking; failures remain weak', () => {
  assert.equal(buildTemplateMinutes(reviewResult({ findings: [finding({ status: 'blocking' })] })).evidenceStrength, 'strong');
  assert.equal(buildTemplateMinutes(reviewResult()).evidenceStrength, 'moderate');
  assert.equal(buildTemplateMinutes(reviewResult({ seatBriefs: [brief('A')], status: 'degraded' })).evidenceStrength, 'weak');
  assert.equal(buildTemplateMinutes(reviewResult({ seatBriefs: [], status: 'error' })).evidenceStrength, 'weak');
});

it('clips long display fields without changing votes, resolution or question identities', () => {
  const text = '长问题😀'.repeat(1000);
  const input = reviewResult({ seatBriefs: [brief('A', { summary: text, findings: [finding({ title: text })] }),
    brief('B', { verdict: 'request_changes', findings: [finding({ title: text })] })],
    ballots: [ballot('A'), ballot('B', { changeReason: text })],
    discussion: [{ responses: [{ seatRef: 'A', questions: [{ to: 'B', question: text + 'one' }, { to: 'B', question: text + 'two' }] }] }],
    decision: { dissent: [{ seatRef: 'B', verdict: 'approve', reason: text }] } });
  const before = structuredClone(input), minutes = buildTemplateMinutes(input);
  for (const [value, limit] of [[minutes.seatSummaries[0].view, 1200], [minutes.consensus[0].statement, 400],
    [minutes.disputes[0].point, 400], [minutes.voteChanges[0].reason, 1200], [minutes.dissent[0].reason, 1200],
    [minutes.unresolvedQuestions[0].question, 300]]) {
    assert.ok(value.length <= limit); assert.ok(value.endsWith('…')); assert.ok(value.isWellFormed());
  }
  assert.equal(minutes.unresolvedQuestions.length, 2); assert.equal(minutes.unresolvedQuestions[0].from, 'seat-0');
  assert.equal(minutes.disputes[0].resolved, true);
  assert.equal(minutes.voteChanges[0].from, 'request_changes'); assert.equal(minutes.voteChanges[0].to, 'approve');
  assert.deepEqual(input, before);
  assert.equal(clip('ab😀x', 4), 'ab…'); assert.equal(clip('unchanged', 9), 'unchanged');
});
