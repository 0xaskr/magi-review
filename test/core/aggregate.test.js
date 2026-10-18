import { it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateFindings, summarizeSeats } from '../../lib/core/aggregate.js';
import { finding, brief, frozen } from '../fixtures/core-fixtures.js';

it('merges fingerprints, preserves all provenance and takes conservative maxima', () => {
  const inputs = frozen([
    brief('B', { findings: [finding({ id: 'b1', severity: 'critical', confidence: 'low', mustFix: true, introducedByChange: false })] }),
    brief('A', { findings: [finding({ id: 'a1', severity: 'low', confidence: 'high' }), finding({ id: 'a2' })] }),
  ]);
  const result = aggregateFindings(inputs), merged = result.findings[0];
  assert.equal(result.sourceCount, 3); assert.equal(result.mergedCount, 2); assert.equal(result.findings.length, 1);
  assert.deepEqual(merged.sourceSeatRefs, ['A', 'B']); assert.deepEqual(merged.sourceFindingIds, ['a1', 'a2', 'b1']);
  assert.equal(merged.severity, 'critical'); assert.equal(merged.confidence, 'high'); assert.equal(merged.mustFix, true);
  assert.equal(merged.introducedByChange, true); assert.equal(merged.status, 'non_blocking');
  assert.match(merged.mergeReason, /3 source findings from 2 seats; highest severity critical/); assert.deepEqual(result.warnings, []);
});

it('union-superset preserves every distinct completed finding ID exactly once', () => {
  const inputs = ['A', 'B', 'C'].map((seat, i) => brief(seat, { findings: Array.from({ length: 4 }, (_, j) => finding({ id: `${seat}${j}`, title: `Issue group ${j % 2}`, severity: i === 0 ? 'high' : 'medium' })) }));
  const result = aggregateFindings(inputs);
  const ids = result.findings.flatMap(f => f.sourceFindingIds);
  assert.equal(ids.length, 12); assert.equal(new Set(ids).size, 12);
  assert.deepEqual([...ids].sort(), inputs.flatMap(b => b.findings.map(f => f.id)).sort());
});

it('missing and duplicate IDs warn while keeping nonempty, traceable provenance', () => {
  const result = aggregateFindings([
    brief('A', { findings: [finding({ id: 'same', fingerprint: 'first' }), finding({ id: 'same', fingerprint: 'first' }), finding({ id: '', fingerprint: 'missing' })] }),
    brief('B', { findings: [finding({ id: 'same', fingerprint: 'second' })] }),
  ]);
  const ids = result.findings.flatMap(f => f.sourceFindingIds);
  assert.equal(ids.filter(id => id === 'same').length, 1);
  assert.ok(result.findings.every(f => f.sourceFindingIds.length && f.sourceFindingIds.every(Boolean)));
  assert.equal(new Set(ids).size, ids.length); assert.match(result.warnings.join(' '), /missing finding.id/);
  assert.match(result.warnings.join(' '), /duplicate finding.id/); assert.match(result.warnings.join(' '), /provenance alias/);
});

it('does not collide synthetic IDs with valid IDs', () => {
  const result = aggregateFindings([brief('A', { findings: [finding({ id: '', fingerprint: 'a' }), finding({ id: 'A:missing:1', fingerprint: 'b' })] })]);
  const ids = result.findings.flatMap(f => f.sourceFindingIds); assert.equal(new Set(ids).size, 2); assert.ok(ids.includes('A:missing:1'));
});

it('error findings never participate and produce a warning', () => {
  const result = aggregateFindings([brief('A', { status: 'error', findings: [finding({ severity: 'critical' })] })]);
  assert.deepEqual(result.findings, []); assert.equal(result.sourceCount, 0); assert.match(result.warnings[0], /Seat A: error/);
});

it('orders severity, path, line and fingerprint deterministically', () => {
  const specs = [
    ['low', 'a', 1, 'z'], ['critical', 'z', 10, 'x'], ['high', 'b', 2, 'd'],
    ['high', 'a', 3, 'c'], ['high', 'a', 2, 'b'], ['high', 'a', 2, 'a'],
  ];
  const input = brief('A', { findings: specs.map(([severity, path, line, fingerprint]) => finding({ id: fingerprint, severity, location: { path, line }, fingerprint })) });
  assert.deepEqual(aggregateFindings([input]).findings.map(f => f.fingerprint), ['x', 'a', 'b', 'c', 'd', 'z']);
});

it('representative content, source ordering and warnings survive input reordering', () => {
  const a = brief('A', { findings: [finding({ id: 'a', rationale: 'A reason', suggestion: 'A suggestion' })] });
  const b = brief('B', { findings: [finding({ id: 'b', rationale: 'B reason', title: 'Bug: Missing boundary check!' })] });
  assert.deepEqual(aggregateFindings([a, b]), aggregateFindings([b, a]));
});

it('summarizes status independently of stale error verdicts', () => {
  assert.deepEqual(summarizeSeats([brief(), brief('B', { verdict: 'request_changes' }), brief('C', { status: 'error', verdict: 'approve' })]),
    { completed: 2, failed: 1, byVerdict: { approve: 1, request_changes: 1, error: 1 } });
  assert.deepEqual(aggregateFindings([]), { findings: [], sourceCount: 0, mergedCount: 0, warnings: [] });
});
