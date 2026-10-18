import { it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, findingFingerprint, stableFindingId } from '../../lib/core/fingerprint.js';
import { finding } from '../fixtures/core-fixtures.js';

it('normalizes case, punctuation, whitespace and repeated common prefixes', () => {
  assert.equal(normalizeTitle(' BUG: Issue: Fix: Problem: Missing—BOUNDARY  check! '), 'missing boundary check');
  assert.equal(normalizeTitle('问题：边界，检查！'), '问题 边界 检查');
});
it('cosmetic title rewrites have the same fingerprint', () => {
  assert.equal(findingFingerprint(finding()), findingFingerprint(finding({ title: 'Bug: MISSING boundary check!' })));
});
it('line and range drift never change the fingerprint', () => {
  assert.equal(findingFingerprint(finding()), findingFingerprint(finding({ location: { path: 'src/reader.js', side: 'old', line: 999, range: { start: 100, end: 200 } } })));
});
it('different paths or categories change the fingerprint', () => {
  assert.notEqual(findingFingerprint(finding()), findingFingerprint(finding({ location: { path: 'other.js' } })));
  assert.notEqual(findingFingerprint(finding()), findingFingerprint(finding({ category: 'security' })));
});
it('optional context is part of the fingerprint and empty context is stable', () => {
  assert.equal(findingFingerprint(finding()), findingFingerprint(finding(), ''));
  assert.notEqual(findingFingerprint(finding(), 'a'), findingFingerprint(finding(), 'b'));
});
it('IDs and hex fingerprints are stable and independent of local IDs', () => {
  const fp = findingFingerprint(finding()); assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(findingFingerprint(finding({ id: 'other' })), fp); assert.equal(stableFindingId(fp), `F-${fp.slice(0, 8)}`);
});
