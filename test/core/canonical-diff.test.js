import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff, canonicalizeDiff, hashDiff, sliceDiffToPaths, renderPatch } from '../../lib/core/canonical-diff.js';
import { frozen } from '../fixtures/core-fixtures.js';

const patches = {
  added: 'diff --git a/new.js b/new.js\nnew file mode 100644\nindex 0000000..123abcd\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,2 @@\n+first\n+second\n',
  modified: 'diff --git a/a.js b/a.js\nindex aaaaaaa..bbbbbbb 100644\n--- a/a.js\n+++ b/a.js\n@@ -3,2 +3,2 @@ function\n context\n-old\n+new\n',
  deleted: 'diff --git a/gone b/gone\ndeleted file mode 100755\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n',
  renamed: 'diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n',
  binary: 'diff --git a/image.png b/image.png\nindex aaaa..bbbb 100644\nBinary files a/image.png and b/image.png differ\n',
};
for (const [status, patch] of Object.entries(patches)) it(`parses ${status} patch`, () => {
  const parsed = parseUnifiedDiff(patch); assert.equal(parsed.stats.files, 1); assert.equal(parsed.files[0].status, status);
  const roundtrip = parseUnifiedDiff(renderPatch(parsed)); assert.deepEqual(roundtrip, parsed);
});
it('counts only hunk additions/deletions and preserves hunk coordinates', () => {
  const { files, stats } = parseUnifiedDiff(patches.modified);
  assert.deepEqual(stats, { files: 1, additions: 1, deletions: 1 });
  assert.deepEqual(files[0].hunks[0], { oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [' context', '-old', '+new'] });
});
it('handles multiple files and empty diffs', () => {
  assert.deepEqual(parseUnifiedDiff('').stats, { files: 0, additions: 0, deletions: 0 });
  const parsed = parseUnifiedDiff(Object.values(patches).join(''));
  assert.deepEqual(parsed.stats, { files: 5, additions: 3, deletions: 2 }); assert.equal(parsed.files[3].oldPath, 'old');
});
it('keeps no-newline markers on each side of a changed line', () => {
  const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n';
  const parsed = parseUnifiedDiff(patch); assert.equal(parsed.files[0].noNewline, true);
  assert.equal(parsed.files[0].hunks[0].lines.length, 4); assert.deepEqual(parseUnifiedDiff(renderPatch(parsed)), parsed);
});
it('hunk lines resembling file headers are counted as content', () => {
  const parsed = parseUnifiedDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n--- old content\n+++ new content\n');
  assert.equal(parsed.files.length, 1); assert.deepEqual(parsed.stats, { files: 1, additions: 1, deletions: 1 });
});
it('supports multiple hunks, omitted counts and a plain unified patch', () => {
  const parsed = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -5,0 +6,2 @@\n+c\n+d\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-x\n+y\n');
  assert.equal(parsed.files.length, 2); assert.equal(parsed.files[0].hunks.length, 2);
  assert.deepEqual(parsed.stats, { files: 2, additions: 4, deletions: 2 });
});
it('canonical hashes ignore transport newlines and index metadata', () => {
  const changed = patches.modified.replace('aaaaaaa..bbbbbbb', 'ccccccc..ddddddd').replaceAll('\n', '\r\n');
  assert.equal(hashDiff(changed), hashDiff(patches.modified));
  assert.ok(!canonicalizeDiff(changed).includes('index ')); assert.equal(canonicalizeDiff(''), '');
  assert.equal(canonicalizeDiff(canonicalizeDiff(changed)), canonicalizeDiff(changed));
  assert.notEqual(hashDiff(patches.modified), hashDiff(patches.modified.replace('+new', '+different')));
});
it('canonicalization preserves file order and whitespace inside lines', () => {
  assert.notEqual(hashDiff(patches.added + patches.modified), hashDiff(patches.modified + patches.added));
  assert.equal(canonicalizeDiff('+value  \r\n context\r'), '+value  \n context\n');
});
it('slices both old and new exact paths without mutating the input', () => {
  const parsed = frozen(parseUnifiedDiff(patches.renamed + patches.modified));
  assert.deepEqual(sliceDiffToPaths(parsed, ['old']), sliceDiffToPaths(parsed, ['new']));
  assert.equal(sliceDiffToPaths(parsed, ['new', 'old']).length, 1); assert.deepEqual(sliceDiffToPaths(parsed, ['ne']), []);
  assert.deepEqual(sliceDiffToPaths(parsed, []), []); assert.notEqual(sliceDiffToPaths(parsed, ['new'])[0], parsed.files[0]);
});
it('renders externally constructed turn hunks', () => {
  const files = [{ path: 'x', status: 'added', additions: 1, deletions: 0, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+hello'] }], noNewline: true }];
  const text = renderPatch(files); assert.match(text, /--- \/dev\/null/); assert.match(text, /No newline/); assert.equal(parseUnifiedDiff(text).stats.additions, 1);
});
it('preserves mode-only changes', () => {
  const parsed = parseUnifiedDiff('diff --git a/run b/run\nold mode 100644\nnew mode 100755\n');
  assert.deepEqual(parseUnifiedDiff(renderPatch(parsed)), parsed); assert.equal(parsed.stats.additions, 0);
});
it('decodes quoted C/octal UTF-8 paths and handles spaces', () => {
  const parsed = parseUnifiedDiff('diff --git "a/\\344\\270\\255.txt" "b/\\344\\270\\255.txt"\nold mode 100644\nnew mode 100755\n');
  assert.equal(parsed.files[0].path, '中.txt');
  const spaced = parseUnifiedDiff('diff --git a/some file b/some file\n--- a/some file\n+++ b/some file\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(spaced.files[0].path, 'some file'); assert.deepEqual(parseUnifiedDiff(renderPatch(spaced)), spaced);
});
it('retains git binary patch payloads', () => {
  const parsed = parseUnifiedDiff('diff --git a/image b/image\nGIT binary patch\nliteral 3\nAbc123\n');
  assert.equal(parsed.files[0].status, 'binary'); assert.deepEqual(parseUnifiedDiff(renderPatch(parsed)), parsed);
});
it('preserves added and deleted binary metadata and null sides', () => {
  for (const patch of [
    'diff --git a/image b/image\nnew file mode 100644\nBinary files /dev/null and b/image differ\n',
    'diff --git a/image b/image\ndeleted file mode 100644\nBinary files a/image and /dev/null differ\n',
  ]) {
    const parsed = parseUnifiedDiff(patch); assert.deepEqual(parseUnifiedDiff(renderPatch(parsed)), parsed);
  }
});
