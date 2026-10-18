import { it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest, renderDigestText, renderToolJson } from '../../lib/core/digest.js';
import { finding, reviewResult, frozen } from '../fixtures/core-fixtures.js';

it('builds every ReviewDigest field with reveal and target data', () => {
  const result = frozen(reviewResult()), digest = buildDigest(result);
  for (const key of ['reviewId', 'mode', 'status', 'trust', 'verdict', 'overallImpact', 'summary', 'seats', 'counts', 'target', 'homogeneous', 'rounds', 'durationMs', 'degradedReasons', 'reportId']) assert.ok(Object.hasOwn(digest, key), key);
  assert.deepEqual(digest.seats[0], { seatId: 'seat-0', label: 'view-0', verdict: 'approve', changed: false, status: 'completed' });
  assert.deepEqual(digest.target, { kind: 'base-ref', baseRef: 'main', files: 1, partial: false });
  assert.equal(digest.durationMs, 2000); assert.equal(digest.homogeneous, true); assert.equal(digest.reportId, 'report-1');
});
it('reads v1.1 verdict/status from an existing digest when decision only holds rule metadata', () => {
  const input = reviewResult(); input.digest = buildDigest(input); delete input.status; delete input.verdict; delete input.trust; delete input.reviewId;
  const digest = buildDigest(input); assert.equal(digest.status, 'completed'); assert.equal(digest.verdict, 'approve'); assert.equal(digest.reviewId, 'review-1');
});
it('degraded and insufficient force needs_review and counts come from findings', () => {
  const digest = buildDigest(reviewResult({ verdict: 'insufficient', status: 'degraded', findings: [finding({ status: 'blocking' })], degradedReasons: ['REVIEWER_TIMEOUT'], coverage: { partial: true } }));
  assert.equal(digest.trust, 'needs_review'); assert.deepEqual(digest.counts, { findings: 1, blocking: 1 });
  const text = renderDigestText(digest); assert.match(text, /INSUFFICIENT/); assert.match(text, /DEGRADED/); assert.match(text, /coverage partial/); assert.match(text, /report-1/);
});
it('empty/error and quick results have stable defaults', () => {
  const digest = buildDigest({ mode: 'quick' }); assert.equal(digest.status, 'error'); assert.equal(digest.trust, 'untrustworthy'); assert.equal(digest.rounds, 0); assert.equal(digest.durationMs, 0);
  assert.match(renderDigestText(digest), /review not revealed/);
});
for (const reveal of [undefined, null, { at: 'discussion', seats: [] }]) it(`withholds identities and votes until verdict reveal (${reveal?.at ?? String(reveal)})`, () => {
  const input = reviewResult(); input.digest = buildDigest(input); input.reveal = reveal;
  input.seatBriefs[0] = { ...input.seatBriefs[0], seatId: 'private-seat', perspective: 'private-view',
    model: { provider: 'private-provider', model: 'private-model' }, summary: 'private-seat approves' };
  input.findings = [finding({ title: 'private-seat from private-model approves' })];
  input.degradedReasons = ['private-seat failed'];
  const digest = buildDigest(frozen(input));
  assert.deepEqual(digest.seats, []); assert.equal(digest.summary, 'review not revealed'); assert.equal(digest.verdict, 'none');
  assert.equal(Object.hasOwn(digest, 'approveVotes'), false); assert.equal(Object.hasOwn(digest, 'requestVotes'), false);
  for (const serialized of [JSON.stringify(digest), renderDigestText(digest)]) {
    for (const token of ['private-seat', 'private-view', 'private-provider', 'private-model', 'seat-0', 'view-0', 'approve', 'Votes:', 'Seats:']) {
      assert.ok(!serialized.includes(token), token);
    }
  }
});
it('anonymous rendering cannot reuse stale seat and count fields', () => {
  const digest = { ...buildDigest(reviewResult()), revealed: false, summary: 'review not revealed' };
  assert.equal(renderDigestText(digest), 'review not revealed\nreportId: report-1');
  assert.doesNotThrow(() => buildDigest()); assert.doesNotThrow(() => buildDigest(null));
});
it('text includes vote counts, blocking, seat status and finding locations', () => {
  const digest = buildDigest(reviewResult({ findings: [finding({ severity: 'high', status: 'blocking' })] }));
  const text = renderDigestText(digest); assert.match(text, /approve 3, request_changes 0; blocking 1/);
  assert.match(text, /view-0=approve \(completed\)/); assert.match(text, /high src\/reader.js:10 Missing boundary check/);
});
it('huge unicode findings stay within 4096 characters and bytes with an omission marker', () => {
  const digest = buildDigest(reviewResult({ findings: Array.from({ length: 30 }, (_, i) => finding({ id: String(i), title: '超长标题🙂'.repeat(300), location: { path: '路径/'.repeat(200), line: i } })) }));
  assert.equal(digest.findings.length, 10);
  const text = renderDigestText(digest); assert.ok(text.length <= 4096); assert.ok(new TextEncoder().encode(text).length <= 4096);
  assert.ok(text.includes('…')); assert.match(text, /reportId: report-1$/); assert.ok(text.split('\n').filter(l => l.startsWith('medium ')).length <= 10);
});
it('untrusted field newlines cannot inject extra digest lines', () => {
  const digest = buildDigest(reviewResult({ findings: [finding({ title: 'line1\nline2\nline3' })] }));
  assert.match(renderDigestText(digest), /line1 line2 line3/);
});
it('JSON tool rendering is deterministic', () => assert.equal(renderToolJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}'));
