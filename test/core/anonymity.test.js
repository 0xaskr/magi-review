import { it } from 'node:test';
import assert from 'node:assert/strict';
import { assignSeatRefs, buildDocket, scrubIdentityText, assertAnonymousDocket, tallyBallots, buildReveal } from '../../lib/core/anonymity.js';
import { brief, ballot, finding, frozen } from '../fixtures/core-fixtures.js';

it('assigns anonymous refs in input order, including beyond Z', () => {
  const refs = assignSeatRefs(Array.from({ length: 28 }, (_, i) => ({ seatId: `real-${i}` })));
  assert.deepEqual(refs[0], { seatId: 'real-0', seatRef: 'A' }); assert.equal(refs[25].seatRef, 'Z'); assert.equal(refs[27].seatRef, 'AB');
});
it('docket strips identities recursively and uses opaque local IDs', () => {
  const secrets = ['real-architect', 'builtin-secret-perspective', 'private-model-123', 'private-provider', 'child-session-private'];
  const inputs = frozen([brief('A', {
    seatId: secrets[0], perspective: secrets[1], model: { model: secrets[2], provider: secrets[3] }, childSessionId: secrets[4],
    findings: [finding({ id: secrets[0] + ':1', fingerprint: secrets[0], sourceSeatRefs: [secrets[0]], perspective: secrets[1],
      location: { path: 'x.js', side: 'new', line: 1, model: secrets[2], hunkId: secrets[4], range: { start: 1, end: 2, seatId: secrets[0] } },
      evidence: [{ kind: 'code', note: 'Boundary code', model: secrets[2] }] })],
  })]);
  const docket = buildDocket(inputs), serialized = JSON.stringify(docket);
  for (const secret of secrets) assert.ok(!serialized.includes(secret), secret);
  for (const key of ['model', 'perspective', 'seatId', 'childSessionId', 'fingerprint', 'sourceSeatRefs']) assert.ok(!serialized.includes(`"${key}"`), key);
  assert.equal(docket.seats[0].findings[0].id, 'A:1'); assert.equal(docket.seats[0].findings[0].title, inputs[0].findings[0].title);
  assert.notEqual(docket.seats[0].findings[0].location, inputs[0].findings[0].location);
});
it('same local source IDs cannot collide between seats', () => {
  const docket = buildDocket([brief('A', { findings: [finding()] }), brief('B', { findings: [finding()] })]);
  assert.notEqual(docket.seats[0].findings[0].id, docket.seats[1].findings[0].id);
  assert.equal(docket.seats[0].findings[0].id, 'A:local-1');
});
it('scrubs self-identification in all docket text, including nested evidence and extra tokens', () => {
  const tokens = ['real-seat-7', 'builtin:architect', 'architect', 'engineer', 'adversary', 'deepseek', 'deepseek-flash', 'Council Lead', 'private-child', 'extra-secret', '架构师', '工程师', '对抗'];
  const inputs = frozen([brief('A', {
    seatId: 'real-seat-7', perspective: 'builtin:architect', model: { provider: 'deepseek', model: 'deepseek-flash' },
    seat: { label: 'Council Lead' }, childSessionId: 'private-child',
    summary: 'As the Architect (model deepseek-flash), I reviewed this.',
    evidenceNote: 'The ENGINEER, adversary and Council Lead agree; 我是架构师，工程师检查对抗测试。',
    findings: [finding({ title: 'REAL-SEAT-7 found a bug', rationale: 'builtin:architect used DEEPSEEK.',
      suggestion: 'Ask extra-secret and private-child.', location: { path: 'src/real-seat-7.js', side: 'new', line: 1 },
      evidence: [{ kind: 'script', path: 'deepseek/check.js', command: 'check --seat real-seat-7', note: 'Council Lead ran it', outputDigest: 'extra-secret' }] })],
  })]);
  const docket = buildDocket(inputs, { extraTokens: ['extra-secret'] });
  assert.deepEqual(assertAnonymousDocket(docket, tokens), []);
  assert.equal(docket.seats[0].summary, 'As the [seat] (model [seat]), I reviewed this.');
  assert.equal(docket.seats[0].findings[0].title, '[seat] found a bug');
  assert.equal(docket.seats[0].findings[0].location.line, 1);
});
it('scrubs complete identity tokens without damaging ordinary words or interpreting regex syntax', () => {
  const tokens = ['architect', 'deepseek', 'deepseek-flash', 'model.v2+', 'seat'];
  assert.equal(scrubIdentityText('architecture architectural engineering ARCHITECT deepseek-flash model.v2+ modelXv2+', tokens),
    'architecture architectural engineering [seat] [seat] [seat] modelXv2+');
  assert.equal(scrubIdentityText('safe text', ['', null, undefined]), 'safe text');
});
it('anonymous docket assertions report leaks case insensitively without throwing', () => {
  assert.equal(assertAnonymousDocket({ summary: 'PRIVATE-MODEL' }, ['private-model']).length, 1);
  assert.deepEqual(assertAnonymousDocket({ summary: 'safe' }, ['private-model']), []);
});
it('tally uses vote content and changed flag without identities', () => {
  assert.deepEqual(tallyBallots([ballot('X'), ballot('Y', { finalVerdict: 'request_changes', changedFromBrief: true }), ballot('Z', { finalVerdict: 'invalid' }), ballot('W', { status: 'error' })]),
    { approve: 1, request: 1, changed: 1, total: 2 });
});
it('reveal maps explicit seat refs despite reordered briefs and records actual final changes', () => {
  const assignment = [{ seatId: 'engineer', seatRef: 'B', perspective: 'engineer-view', provider: 'p2', model: 'm2' },
    { seatId: 'architect', seatRef: 'A', perspective: 'architect-view', provider: 'p1', model: 'm1' }];
  const result = buildReveal(frozen(assignment), [brief('A'), brief('B', { verdict: 'request_changes' })], [ballot('B'), ballot('A', { changedFromBrief: true })], []);
  assert.equal(result.at, 'verdict'); assert.deepEqual(result.seats[0], { seatRef: 'B', seatId: 'engineer', perspective: 'engineer-view', provider: 'p2', model: 'm2', briefVerdict: 'request_changes', finalVerdict: 'approve', changed: true });
  assert.equal(result.seats[1].changed, false);
});
it('reveal does not invent final votes for failures', () => {
  const result = buildReveal([{ seatId: 'a', perspective: 'view', provider: 'p', model: 'm' }], [brief('A')], [], []);
  assert.equal(result.seats[0].finalVerdict, undefined); assert.equal(result.seats[0].changed, false);
});
