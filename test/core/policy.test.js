import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockingFinding, applyBlockingStatus, expectedQuorum, decideMajority, decideUnanimous, decide } from '../../lib/core/policy.js';
import { finding, decisionInput, frozen } from '../fixtures/core-fixtures.js';

const names = { A: 'approve', R: 'request_changes', I: 'insufficient', N: 'none' };
// Rows are approve counts; columns are request counts. Remaining seats failed.
const majorityTables = {
  3: ['NIRR', 'IRR', 'AA', 'A'],
  5: ['NIIRRR', 'IRIRR', 'IIRR', 'AAA', 'AA', 'A'],
  7: ['NIIIRRRR', 'IRIIRRR', 'IIRIRR', 'IIIRR', 'AAAA', 'AAA', 'AA', 'A'],
};
const critical = finding({ severity: 'critical', confidence: 'low', sourceSeatRefs: ['A'], sourceFindingIds: ['x'] });

describe('complete vote matrices', () => {
  for (const n of [3, 5, 7]) {
    it(`n=${n}: every one of ${3 ** n} approve/request/error permutations, both policies and coverage`, () => {
      for (let code = 0; code < 3 ** n; code++) {
        let digits = code;
        const votes = Array.from({ length: n }, () => { const vote = ['A', 'R', 'E'][digits % 3]; digits = Math.floor(digits / 3); return vote; });
        const a = votes.filter(v => v === 'A').length, r = votes.filter(v => v === 'R').length;
        const input = decisionInput(votes), label = votes.join('');
        const actual = decideMajority(input);
        assert.equal(actual.verdict, names[majorityTables[n][a][r]], label);
        assert.equal(actual.approveVotes, a, label); assert.equal(actual.requestVotes, r, label);
        assert.equal(actual.status, a + r === 0 ? 'error' : a + r === n ? 'completed' : 'degraded', label);
        assert.equal(actual.trust, a + r === 0 ? 'untrustworthy' : a + r < n || actual.verdict === 'insufficient' ? 'needs_review' : 'trustworthy', label);
        assert.equal(decideUnanimous(input).verdict, a + r === 0 ? 'none' : r ? 'request_changes' : a === n ? 'approve' : 'insufficient', label);
        for (const evaluate of [decideMajority, decideUnanimous]) {
          assert.equal(evaluate({ ...input, coverage: { partial: true } }).verdict, a + r === 0 ? 'none'
            : evaluate === decideUnanimous && r > 0 ? 'request_changes' : 'insufficient', label);
          assert.equal(evaluate({ ...input, findings: [critical], coverage: { partial: true } }).verdict, a + r === 0 ? 'none' : 'request_changes', label);
        }
        const degraded = decideMajority({ ...input, degradedReasons: ['CLERK_FALLBACK'] });
        assert.equal(degraded.verdict, actual.verdict, label);
        if (degraded.verdict === 'approve') { assert.ok(a >= Math.floor(n / 2) + 1, label); assert.ok(a > r, label); }
      }
    });
  }
});

describe('blocking and immutable status', () => {
  const cases = [
    ['critical at low confidence', { severity: 'critical', confidence: 'low' }, {}, true],
    ['high at medium confidence', { severity: 'high' }, {}, true],
    ['high at low confidence', { severity: 'high', confidence: 'low' }, {}, false],
    ['medium by default', {}, {}, false],
    ['configured medium threshold', {}, { blockingSeverity: 'medium' }, true],
    ['configured critical threshold', { severity: 'high' }, { blockingSeverity: 'critical' }, false],
    ['pre-existing critical', { severity: 'critical', introducedByChange: false }, {}, false],
    ['introduction must be boolean true', { severity: 'critical', introducedByChange: 'true' }, {}, false],
    ['single-seat mustFix', { mustFix: true, sourceSeatRefs: ['A'] }, {}, false],
    ['repeated seat does not corroborate', { mustFix: true, sourceSeatRefs: ['A', 'A'] }, {}, false],
    ['two-seat mustFix even low confidence', { mustFix: true, confidence: 'low', sourceSeatRefs: ['B', 'A'] }, {}, true],
    ['two seats alone are insufficient', { sourceSeatRefs: ['A', 'B'] }, {}, false],
  ];
  for (const [name, changes, policy, expected] of cases) it(name, () => assert.equal(isBlockingFinding(finding(changes), policy), expected));
  it('combines distinct source seats only for the same fingerprint', () => {
    const a = finding({ fingerprint: 'one', mustFix: true, sourceSeatRefs: ['A'] });
    assert.equal(isBlockingFinding(a, {}, [finding({ fingerprint: 'one', sourceSeatRefs: ['B'] })]), true);
    assert.equal(isBlockingFinding(a, {}, [finding({ fingerprint: 'two', sourceSeatRefs: ['B'] })]), false);
  });
  it('replaces stale blocking flags without mutation', () => {
    const inputs = frozen([finding({ status: 'blocking' }), critical]);
    const outputs = applyBlockingStatus(inputs);
    assert.deepEqual(outputs.map(f => f.status), ['non_blocking', 'blocking']);
    assert.equal(inputs[0].status, 'blocking'); assert.notEqual(outputs[0].location, inputs[0].location);
  });
});

describe('decision edge cases and audit fields', () => {
  for (const [n, q] of [[0, 1], [3, 2], [5, 3], [7, 4]]) it(`expected quorum ${n} -> ${q}`, () => assert.equal(expectedQuorum(n), q));
  it('blocking vetoes a unanimous approval', () => assert.equal(decide(decisionInput(undefined, { findings: [critical] })).verdict, 'request_changes'));
  it('one approval cannot satisfy the expected quorum', () => assert.equal(decide(decisionInput(['A', 'E', 'E'])).verdict, 'insufficient'));
  it('degraded quorum with no objection may approve', () => assert.equal(decide(decisionInput(['A', 'A', 'E'])).verdict, 'approve'));
  it('external degradation retains a quorum approval with dissent', () => assert.equal(decide(decisionInput(['A', 'A', 'R'], { degradedReasons: ['CLERK_FALLBACK'] })).verdict, 'approve'));
  it('five seats with three approvals, one objection and one failure approve with reduced trust', () => {
    const d = decide(decisionInput(['A', 'A', 'A', 'R', 'E']));
    assert.equal(d.verdict, 'approve'); assert.equal(d.status, 'degraded'); assert.equal(d.trust, 'needs_review');
    assert.equal(d.approveVotes, 3); assert.equal(d.requestVotes, 1); assert.equal(d.dissent[0].seatRef, 'D');
  });
  it('tie is request_changes', () => assert.equal(decide(decisionInput(['A', 'R', 'E'])).verdict, 'request_changes'));
  it('partial coverage overrides a request majority without blocking', () => assert.equal(decide(decisionInput(['R', 'R', 'R'], { coverage: { partial: true } })).verdict, 'insufficient'));
  it('unanimous partial coverage retains an explicit objection', () => assert.equal(decideUnanimous(decisionInput(['A', 'A', 'R'], { coverage: { partial: true } })).verdict, 'request_changes'));
  it('interruption has the same coverage guard', () => assert.equal(decide(decisionInput(undefined, { interrupted: true })).verdict, 'insufficient'));
  it('all failures produce none even if stale findings exist', () => {
    const d = decide(decisionInput(['E', 'E', 'E'], { findings: [critical] }));
    assert.equal(d.verdict, 'none'); assert.equal(d.overallImpact, 'unknown'); assert.equal(d.status, 'error');
  });
  it('missing completed ballot is a failure and explained', () => {
    const input = decisionInput(); input.ballots.pop();
    const d = decide(input); assert.equal(d.approveVotes, 2); assert.equal(d.status, 'degraded'); assert.match(d.rationale, /missing ballots: C/);
  });
  it('ignores ballots from failed and unknown seats', () => {
    const input = decisionInput(['A', 'E', 'E']); input.ballots.push({ seatRef: 'B', finalVerdict: 'approve' }, { seatRef: 'Z', finalVerdict: 'approve' });
    assert.equal(decide(input).approveVotes, 1);
  });
  it('duplicate or invalid ballots cannot inflate votes', () => {
    const input = decisionInput(); input.ballots.push(input.ballots[0]); input.ballots[1].finalVerdict = 'invented';
    assert.equal(decide(input).approveVotes, 1); assert.equal(decide(input).verdict, 'insufficient');
  });
  for (const singleBallot of [false, true]) it(`duplicate seat refs fail closed${singleBallot ? ' even with only one ballot' : ''}`, () => {
    const input = decisionInput(); input.seats[1].seatRef = 'A';
    if (singleBallot) input.ballots = [input.ballots[0]];
    for (const evaluate of [decideMajority, decideUnanimous, decide]) {
      const d = evaluate(frozen(input));
      assert.equal(d.status, 'error'); assert.equal(d.verdict, 'none'); assert.equal(d.trust, 'untrustworthy');
      assert.equal(d.approveVotes, 0); assert.equal(d.requestVotes, 0); assert.ok(d.approveVotes < d.expectedQuorum);
      assert.match(d.rationale, /invalid_seat_refs/);
    }
  });
  it('explicit refs cannot collide with automatically assigned refs', () => {
    const input = decisionInput(); input.seats[0].seatRef = 'B'; delete input.seats[1].seatRef;
    assert.match(decide(input).rationale, /invalid_seat_refs/);
  });
  it('multiple ballots invalidate only that seat instead of manufacturing a quorum', () => {
    const input = decisionInput(['A', 'A', 'E']); input.ballots.push({ ...input.ballots[0] });
    const d = decide(input);
    assert.equal(d.approveVotes, 1); assert.equal(d.verdict, 'insufficient'); assert.equal(d.status, 'degraded');
    assert.ok(d.approveVotes < d.expectedQuorum); assert.match(d.rationale, /failed or missing ballots: A, C/);
  });
  it('maps seats without seatRef in input order', () => {
    const input = decisionInput(); input.seats.forEach(s => delete s.seatRef); assert.equal(decide(input).approveVotes, 3);
  });
  it('preserves dissent text verbatim', () => {
    const input = decisionInput(['A', 'A', 'R']); input.ballots[2].changeReason = 'Exact dissent: unsafe boundary.';
    assert.deepEqual(decide(input).dissent, [{ seatRef: 'C', verdict: 'request_changes', reason: 'Exact dissent: unsafe boundary.' }]);
  });
  it('major impact requires the expected quorum', () => {
    const input = decisionInput(['A', 'A', 'E']); input.ballots[0].finalImpact = 'major';
    assert.equal(decide(input).overallImpact, 'normal'); input.ballots[1].finalImpact = 'major'; assert.equal(decide(input).overallImpact, 'major');
  });
  it('high risk escalates only when configured', () => {
    const input = decisionInput(['A', 'A', 'R'], { policy: { approval: 'majority', escalateOnRisk: true }, risk: { level: 'high' } });
    const d = decide(frozen(input)); assert.equal(d.effectivePolicy, 'unanimous'); assert.equal(d.declaredPolicy, 'majority'); assert.equal(d.escalatedBy, 'risk'); assert.equal(d.verdict, 'request_changes');
  });
  it('high risk alone does not change majority', () => assert.equal(decide(decisionInput(['A', 'A', 'R'], { risk: { level: 'high' } })).verdict, 'approve'));
  it('explicit unanimous records config provenance', () => {
    const d = decide(decisionInput(['A', 'A', 'E'], { policy: { approval: 'unanimous', escalatedBy: 'config' } }));
    assert.equal(d.verdict, 'insufficient'); assert.equal(d.escalatedBy, 'config');
  });
  it('rationale cites unique blocking fingerprints and counts', () => {
    const d = decide(decisionInput(undefined, { findings: [{ ...critical, fingerprint: 'x' }, { ...critical, fingerprint: 'x' }] }));
    assert.match(d.rationale, /1 blocking fingerprints/); assert.match(d.rationale, /3 approve, 0 request_changes, quorum 2\/3/);
  });
});
