import test from 'node:test';
import assert from 'node:assert/strict';
import { runQuick } from '../../lib/host/quick.js';
import { normalizeConfig } from '../../lib/host/config.js';

function setup(reply) {
  const calls = [];
  return { calls, input: { ctx: { get: () => ({}) }, config: normalizeConfig(), snapshot: { kind: 'patch',
    canonicalPatch: '', patchHash: 'hash', files: [{ path: 'a.js' }], coverage: { partial: false, totalFiles: 1, reviewedFiles: 1 } } },
  deps: { async runSeatTurn(_service, request) {
    calls.push(request);
    const [, kind, seatRef] = request.label.split('-');
    const special = await reply?.(kind, seatRef, request);
    return special ?? { ok: true, text: JSON.stringify(kind === 'brief' ? { seatRef, verdict: 'approve', impact: 'normal', findings: [], summary: `PRIVATE_${seatRef}` }
      : { seatRef, finalVerdict: 'approve', finalFindings: [], changedFromBrief: false }) };
  }, callLlmJsonValidated() { assert.fail('quick must not call minutes'); }, askHuman() { assert.fail('quick must not ask human'); } } };
}

test('quick runs only independent readonly brief + ballot, without minutes/discussion', async () => {
  const f = setup(), { result } = await runQuick(f.input, f.deps);
  assert.equal(f.calls.length, 6); assert.deepEqual(result.discussion, []); assert.equal(result.minutes, null);
  assert.equal(result.digest.mode, 'quick'); assert.equal(result.digest.verdict, 'approve');
  for (const request of f.calls) assert.equal(request.preset, 'magi-reviewer-readonly');
  const aBallot = f.calls.find(c => c.label === 'magi-ballot-A');
  assert.match(aBallot.prompt, /PRIVATE_A/); assert.doesNotMatch(aBallot.prompt, /PRIVATE_B|PRIVATE_C/);
});

test('quick ballot failure retries and falls back to the brief', async () => {
  const f = setup((kind, ref) => kind === 'ballot' && ref === 'C' ? { ok: true, text: 'not JSON' } : undefined);
  const { result } = await runQuick(f.input, f.deps);
  assert.equal(f.calls.filter(c => c.label === 'magi-ballot-C').length, 2);
  assert.ok(result.digest.degradedReasons.includes('ballot_missing:C')); assert.equal(result.digest.status, 'degraded');
  assert.equal(result.ballots.find(b => b.seatRef === 'C').finalVerdict, 'approve');
});

test('quick aggregates final findings and reveals changed votes', async () => {
  const finding = { id: 'issue', title: 'Unsafe input', rationale: 'Input is executed', severity: 'critical', confidence: 'high',
    category: 'security', mustFix: true, introducedByChange: true, location: { path: 'a.js', side: 'new', line: 1 } };
  const f = setup((kind, ref) => kind === 'ballot' && ref === 'A' ? { ok: true, structured: { seatRef: ref, finalVerdict: 'request_changes',
    finalFindings: [finding], changedFromBrief: true, changeReason: 'Found unsafe input' } } : undefined);
  const { result } = await runQuick(f.input, f.deps);
  assert.equal(result.findings[0].status, 'blocking'); assert.equal(result.digest.verdict, 'request_changes');
  assert.equal(result.reveal.seats[0].changed, true); assert.equal(result.findings[0].sourceSeatRefs[0], 'A');
});

test('partial coverage and cancellation cannot approve', async () => {
  const f = setup(); f.input.snapshot.coverage.partial = true;
  const first = await runQuick(f.input, f.deps);
  assert.equal(first.result.digest.verdict, 'insufficient');
  const g = setup(), controller = new AbortController(); controller.abort(); g.input.signal = controller.signal;
  const second = await runQuick(g.input, g.deps);
  assert.equal(g.calls.length, 0); assert.equal(second.result.digest.status, 'error');
  assert.ok(second.result.digest.degradedReasons.includes('cancelled'));
});

test('a changed verdict without an explanation is retried and falls back', async () => {
  const f = setup((kind, ref) => kind === 'ballot' && ref === 'A' ? { ok: true, structured: { seatRef: ref,
    finalVerdict: 'request_changes', finalFindings: [], changedFromBrief: false } } : undefined);
  const { result } = await runQuick(f.input, f.deps);
  assert.equal(f.calls.filter(c => c.label === 'magi-ballot-A').length, 2);
  assert.ok(result.digest.degradedReasons.includes('ballot_missing:A'));
});
