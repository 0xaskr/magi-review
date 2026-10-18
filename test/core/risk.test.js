import { it } from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk } from '../../lib/core/risk.js';

const file = (path = 'src/view.js', options = {}) => ({ path, status: 'modified', additions: 2, deletions: 1, hunks: [], ...options });
it('ordinary and empty changes are low risk', () => {
  assert.equal(assessRisk({ files: [file()] }).level, 'low'); assert.deepEqual(assessRisk({ files: [] }), { level: 'low', score: 0, signals: [] });
});
for (const path of ['src/auth/user.js', 'login.js', 'credential.json', 'crypto/hash.js', 'migrations/001.sql', 'ci/test.yml', '.github/workflows/build.yml', 'deploy/run.sh', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'package.json']) {
  it(`sensitive path ${path} is high risk`, () => {
    const result = assessRisk({ files: [file(path)] }); assert.equal(result.level, 'high'); assert.equal(result.score, 3); assert.ok(result.signals[0].paths.includes(path));
  });
}
it('old rename paths and Windows separators are scanned', () => {
  assert.equal(assessRisk({ files: [file('safe.js', { oldPath: 'src\\auth\\login.js', status: 'renamed' })] }).level, 'high');
});
it('binary is a strong signal', () => assert.equal(assessRisk({ files: [file('a.png', { status: 'binary' })] }).level, 'high'));
it('deletion dominance is strict and handles zero additions', () => {
  assert.equal(assessRisk({ files: [file('x', { additions: 1, deletions: 2 })] }).level, 'low');
  assert.equal(assessRisk({ files: [file('x', { additions: 1, deletions: 3 })] }).level, 'high');
  assert.equal(assessRisk({ files: [file('x', { additions: 0, deletions: 1 })] }).level, 'high');
});
it('more than eight files is medium, exactly eight is low', () => {
  assert.equal(assessRisk({ files: Array.from({ length: 8 }, (_, i) => file(`f${i}`)) }).level, 'low');
  assert.equal(assessRisk({ files: Array.from({ length: 9 }, (_, i) => file(`f${i}`)) }).level, 'medium');
});
it('more than 1000 changed lines is medium, exactly 1000 is low', () => {
  assert.equal(assessRisk({ files: [file()], stats: { files: 1, additions: 999, deletions: 1 } }).level, 'low');
  assert.equal(assessRisk({ files: [file()], stats: { files: 1, additions: 1000, deletions: 1 } }).level, 'medium');
});
it('actual export changes are medium but index filenames alone are weak', () => {
  const exportChange = file('src/x.js', { hunks: [{ lines: ['-export function run() {}', '+export function run(v) {}'] }] });
  assert.equal(assessRisk({ files: [exportChange] }).level, 'medium');
  const hint = assessRisk({ files: [file('src/index.js')] }); assert.equal(hint.level, 'low'); assert.equal(hint.score, 1);
});
it('normal context exports and nonmatching path substrings are not strong signals', () => {
  const result = assessRisk({ files: [file('src/author.js', { hunks: [{ lines: [' export function run() {}', '+// comment'] }] })] });
  assert.equal(result.level, 'low'); assert.equal(result.score, 0);
  assert.equal(assessRisk({ files: [file('src/clock.js')] }).level, 'low');
});
it('risk output is deterministic and does not sum medium signals into high', () => {
  const input = { files: Array.from({ length: 9 }, (_, i) => file(`f${i}`)), stats: { files: 9, additions: 1000, deletions: 100 } };
  assert.deepEqual(assessRisk(input), assessRisk(input)); assert.equal(assessRisk(input).level, 'medium'); assert.equal(assessRisk(input).score, 4);
});
