import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetSnapshot, diffBudgetText, buildBriefPrompt, buildDiscussionPrompt, buildMinutesPrompt } from '../../lib/host/prompts.js';
import { estimateTokens } from '../../lib/host/llm-json.js';
import { validateMinutes } from '../../lib/host/protocol.js';
import { buildTemplateMinutes } from '../../lib/core/minutes-template.js';

const block = path => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
const blocks = ['a.js', 'b.js', 'c.js'].map(block);
const snapshot = { canonicalPatch: blocks.join(''), files: ['a.js', 'b.js', 'c.js'].map(path => ({ path })) };

test('patch budgets include only complete file blocks in canonical order', () => {
  const budget = budgetSnapshot(snapshot, estimateTokens(blocks[0] + blocks[1]));
  assert.deepEqual(budget, { text: blocks[0] + blocks[1], includedPaths: ['a.js', 'b.js'], truncated: true });
  assert.deepEqual(budgetSnapshot(snapshot, estimateTokens(snapshot.canonicalPatch)),
    { text: snapshot.canonicalPatch, includedPaths: ['a.js', 'b.js', 'c.js'], truncated: false });
  assert.deepEqual(budgetSnapshot(snapshot, 0), { text: '', includedPaths: [], truncated: true });
  assert.deepEqual(budgetSnapshot(snapshot, estimateTokens(blocks[0]) - 1), { text: '', includedPaths: [], truncated: true });
  assert.equal(snapshot.promptPatch, undefined);
});

test('file paths come from parsed blocks including quoted renames and deletions', () => {
  const renamed = 'diff --git "a/old name" "b/new name"\nsimilarity index 100%\nrename from old name\nrename to new name\n';
  const deleted = 'diff --git a/gone b/gone\ndeleted file mode 100644\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n';
  const source = { files: [{ path: 'new name' }, { path: 'gone' }, { path: 'c.js' }], canonicalPatch: renamed + deleted + blocks[2] };
  assert.deepEqual(budgetSnapshot(source, estimateTokens(renamed + deleted)).includedPaths, ['new name', 'gone']);
});

test('frozen promptPatch wins even at a smaller budget and retains a partial marker', () => {
  const frozen = { ...snapshot, promptPatch: blocks[0] + blocks[1] };
  const text = diffBudgetText(frozen, 0);
  assert.ok(text.includes(frozen.promptPatch)); assert.ok(!text.includes(blocks[2]));
  assert.match(text, /TRUNCATED/); assert.match(text, /c\.js/);
  assert.match(diffBudgetText({ ...snapshot, promptPatch: '' }, 16000), /showing first 0 of/);
});

test('brief input budgets are independent of output limits and both stages bound tool exploration', () => {
  const options = { seatRef: 'A', snapshot, intent: {}, config: { execution: { maxTokens: 1, promptBudgetTokens: 16000 } } };
  const brief = buildBriefPrompt(options);
  assert.ok(brief.user.includes(snapshot.canonicalPatch)); assert.doesNotMatch(brief.user, /TRUNCATED/);
  assert.match(buildBriefPrompt({ ...options, config: { execution: { promptBudgetTokens: 1, maxTokens: 16000 } } }).user, /TRUNCATED/);
  const large = { ...snapshot, canonicalPatch: 'x'.repeat(45000) };
  assert.doesNotMatch(buildBriefPrompt({ ...options, snapshot: large, config: {} }).user, /TRUNCATED/);
  const discussion = buildDiscussionPrompt({ seatRef: 'A', round: 1, ownBrief: { seatRef: 'A', findings: [] }, docket: { seats: [] } });
  for (const prompt of [brief, discussion]) assert.ok(prompt.system.includes(
    'Start from the frozen patch. Use at most 6 read-only tool calls; do not enumerate the repository; answer JSON within 2 minutes.'));
});

test('minutes accepts empty arrays and optional fields, strips unknown fields, and preserves dissent verbatim', () => {
  const minimal = { summary: 'Recorded', seatSummaries: [{ seatId: 'architect', view: 'Checked', unknown: 'discard' }],
    consensus: [], disputes: [], voteChanges: [], unresolvedQuestions: [], evidenceStrength: 'moderate', dissent: [], unknown: 'discard' };
  const checked = validateMinutes(minimal);
  assert.equal(checked.ok, true); assert.equal(checked.value.minutesStatus, 'ok');
  assert.deepEqual(checked.value.seatSummaries, [{ seatId: 'architect', label: 'architect', view: 'Checked' }]);
  assert.equal(checked.value.unknown, undefined);
  const reason = '  Evidence differs.\n';
  const full = { ...minimal, minutesStatus: 'ok', consensus: [{ statement: 'Shared evidence' }],
    disputes: [{ seats: ['architect', 'engineer'], point: 'Scope', resolved: false }],
    voteChanges: [{ seatId: 'engineer', from: 'approve', to: 'request_changes', reason: 'Scope' }],
    unresolvedQuestions: [{ from: 'architect', question: 'Which scope?' }],
    dissent: [{ seatId: 'architect', verdict: 'request_changes', reason }] };
  const normalized = validateMinutes(full);
  assert.equal(normalized.ok, true); assert.equal(normalized.value.dissent[0].reason, reason);
  for (const field of ['recommendation', 'advice', 'verdict']) {
    assert.equal(validateMinutes({ ...minimal, [field]: null }).ok, false);
  }
});

test('minutes prompt spells out validator requirements and allows optional labels and status in its schema', () => {
  const prompt = buildMinutesPrompt({ result: {}, minutesTemplate: {} });
  assert.match(prompt.user, /必须满足/); assert.match(prompt.user, /只输出单个 JSON/);
  assert.match(prompt.user, /"strong" \| "moderate" \| "weak"/);
  assert.match(prompt.user, /recommendation, advice, suggestion, verdict, approve and request_changes/);
  assert.match(prompt.user, /Copy every template dissent entry and its reason verbatim/);
  const schema = JSON.parse(prompt.user.split('CouncilMinutes JSON schema:\n')[1].split('\n\nReturn only')[0]);
  assert.ok(!schema.required.includes('minutesStatus'));
  assert.deepEqual(schema.properties.seatSummaries.items.required, ['seatId']);
  for (const key of ['consensus', 'disputes', 'voteChanges', 'unresolvedQuestions', 'dissent']) {
    assert.ok(!schema.required.includes(key)); assert.equal(schema.properties[key].type, 'array');
  }
});

function largeMinutesResult(seatCount = 3, prose = '长文本'.repeat(2000)) {
  const findings = Array.from({ length: 30 }, (_, i) => ({ fingerprint: `fp-${i}`, severity: 'high',
    title: `Finding ${i}: ${prose}`, category: 'correctness', status: 'blocking', rationale: 'EXCLUDED_RATIONALE'.repeat(300),
    evidence: [{ note: 'EXCLUDED_EVIDENCE'.repeat(500) }], sourceSeatRefs: ['A', 'B'] }));
  const seats = Array.from({ length: seatCount }, (_, i) => ({ seatRef: String.fromCharCode(65 + i), seatId: `seat-${i}`,
    perspective: `perspective-${i}`, provider: 'provider', model: 'model', briefVerdict: 'approve', finalVerdict: 'request_changes', changed: true }));
  const responses = Array.from({ length: 9 }, (_, i) => ({ seatRef: seats[i % seatCount].seatRef,
    agreesWith: [{ seatRef: 'B', reason: 'EXCLUDED_RESPONSE'.repeat(1000) }],
    questions: Array.from({ length: i < 4 ? 5 : 4 }, (_, q) => ({ to: 'B', question: `${i}-${q}: ${prose}` })) }));
  return { reveal: { at: 'verdict', seats }, findings,
    seatBriefs: seats.map(s => ({ seatRef: s.seatRef, status: 'completed', verdict: 'approve', summary: prose, findings })),
    ballots: seats.map(s => ({ seatRef: s.seatRef, finalVerdict: 'request_changes', finalFindings: findings, changeReason: prose })),
    discussion: Array.from({ length: 3 }, (_, i) => ({ index: i + 1, responses: responses.slice(i * 3, i * 3 + 3) })),
    decision: { verdict: 'request_changes', status: 'completed', trust: 'trustworthy', declaredPolicy: 'majority', effectivePolicy: 'majority',
      approveVotes: 0, requestVotes: seatCount, expectedQuorum: Math.floor(seatCount / 2) + 1, rationale: 'Fixed policy rationale', blockingFindings: findings, dissent: [] },
    digest: { counts: { findings: 30, blocking: 30 } }, coverage: { totalFiles: 12, reviewedFiles: 8, partial: true, unreviewedPaths: ['EXCLUDED_PATH'] },
    risk: { level: 'high', score: 3, signals: [{ code: 'LARGE_DIFF', message: 'Many changes', paths: ['EXCLUDED_PATH'] }] } };
}

function minutesFrame(prompt, label) {
  return JSON.parse(prompt.user.split(`<untrusted-test label="${label}">\n`)[1].split('\n</untrusted-test>')[0]);
}

test('minutes bounds three seats, three rounds, thirty findings and forty questions to 24000 characters', t => {
  const result = largeMinutesResult(), before = structuredClone(result), template = buildTemplateMinutes(result);
  const prompt = buildMinutesPrompt({ result, minutesTemplate: template, nonce: 'test' });
  assert.equal(result.discussion.flatMap(r => r.responses).flatMap(r => r.questions).length, 40);
  assert.ok(prompt.user.length <= 24000, String(prompt.user.length));
  assert.doesNotMatch(prompt.user, /EXCLUDED_|"responses"|"evidence"/);
  const fixed = minutesFrame(prompt, 'fixed-rule-decision');
  assert.equal(fixed.verdict, result.decision.verdict); assert.equal(fixed.requestVotes, 3);
  assert.equal(fixed.effectivePolicy, 'majority'); assert.deepEqual(fixed.counts, { findings: 30, blocking: 30 });
  assert.equal(fixed.coverage.partial, true); assert.equal(fixed.risk.level, 'high');
  assert.ok(fixed.blockingFindings.length > 0 && fixed.blockingFindings.length <= 20);
  for (const f of fixed.blockingFindings) assert.deepEqual(Object.keys(f).sort(), ['fingerprint', 'severity', 'status', 'title']);
  const seats = minutesFrame(prompt, 'revealed-seats-and-findings');
  assert.equal(seats.length, 3);
  for (const seat of seats) {
    assert.ok(seat.brief.summary.length <= 1200); assert.ok(seat.brief.summary.endsWith('…'));
    assert.ok(seat.ballot.finalFindings.length > 0 && seat.ballot.finalFindings.length <= 15);
    for (const f of seat.ballot.finalFindings) assert.deepEqual(Object.keys(f).sort(), ['category', 'fingerprint', 'severity', 'status', 'title']);
  }
  const discussion = minutesFrame(prompt, 'discussion-and-vote-changes');
  assert.deepEqual(Object.keys(discussion).sort(), ['disputes', 'rounds', 'unresolvedQuestions', 'voteChanges']);
  assert.equal(discussion.rounds, 3); assert.equal(discussion.voteChanges.length, 3);
  assert.ok(discussion.disputes.length <= 15 && discussion.unresolvedQuestions.length <= 8);
  assert.ok(discussion.disputes.every(d => d.point.length <= 400));
  assert.ok(discussion.unresolvedQuestions.every(q => q.question.length <= 300));
  const compact = buildMinutesPrompt({ result, minutesTemplate: template, nonce: 'test' }, { compact: true });
  assert.ok(compact.user.length < prompt.user.length); assert.doesNotMatch(compact.user, /discussion-and-vote-changes|"responses"/);
  assert.match(compact.user, /minimum structure/);
  assert.deepEqual(result, before);
  t.diagnostic(`synthetic minutes user: ${prompt.user.length} chars; compact: ${compact.user.length} chars`);
});

test('minutes measures escaped JSON and preserves all dissent within the budget for seven seats', () => {
  const result = largeMinutesResult(7, '"\\\n😀'.repeat(1000));
  result.decision.dissent = result.reveal.seats.map(s => ({ seatRef: s.seatRef, verdict: 'approve', reason: '  Minority concern.\n'.repeat(100) }));
  const template = buildTemplateMinutes(result);
  for (const compact of [false, true]) {
    const prompt = buildMinutesPrompt({ result, minutesTemplate: template, nonce: 'test' }, { compact });
    assert.ok(prompt.user.length <= 24000);
    assert.deepEqual(minutesFrame(prompt, 'minutes-structure-reference').dissent, template.dissent);
    assert.equal(minutesFrame(prompt, 'revealed-seats-and-findings').length, 7);
  }
});
