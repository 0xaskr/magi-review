import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, unlink, rmdir, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runGit, detectRepo, snapshotReview, statusFingerprint, listChangedPaths } from '../../lib/host/git.js';
import { hashDiff } from '../../lib/core/canonical-diff.js';
import { git, repository, temporary } from './helpers.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('working tree snapshots include text/binary untracked, deletions, paths and stable hashes', async t => {
  const root = await repository(t); if (!root) return;
  assert.equal((await snapshotReview({ cwd: root, target: 'working-tree' })).empty, true);
  const repo = await detectRepo(root);
  assert.equal(repo.root.toLowerCase(), root.toLowerCase());
  assert.match(repo.headOid, /^[0-9a-f]{40,64}$/);
  await writeFile(path.join(root, 'tracked.txt'), 'after\nextra\n', 'utf8');
  await unlink(path.join(root, 'delete.txt'));
  await writeFile(path.join(root, '新增 file.txt'), 'new text', 'utf8');
  await writeFile(path.join(root, 'empty.txt'), '', 'utf8');
  await writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
  const result = await snapshotReview({ cwd: root, target: 'working-tree' });
  assert.equal(result.error, undefined);
  assert.equal(result.dirty, true);
  assert.equal(result.baseOid, repo.headOid);
  assert.equal(result.headOid, repo.headOid);
  assert.equal(result.files.length, 5);
  assert.equal(result.stats.additions, 3);
  assert.equal(result.stats.deletions, 2);
  assert.equal(result.files.find(f => f.path === 'delete.txt').status, 'deleted');
  assert.equal(result.files.find(f => f.path === 'binary.dat').binary, true);
  assert.equal(result.untracked.find(f => f.path === 'binary.dat').size, 3);
  assert.match(result.canonicalPatch, /new file mode/);
  assert.match(result.canonicalPatch, /Binary files .* differ/);
  assert.match(result.canonicalPatch, /No newline at end of file/);
  const entries = Object.entries(result.untrackedDigests).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  assert.equal(result.patchHash, sha256(result.canonicalPatch + '\0' + JSON.stringify(entries)));
  assert.equal(result.untrackedDigests['binary.dat'], sha256(Buffer.from([0, 1, 2])));
  assert.equal((await snapshotReview({ cwd: root, target: 'working-tree' })).patchHash, result.patchHash);
  const filtered = await snapshotReview({ cwd: root, target: 'working-tree', paths: ['新增 file.txt'] });
  assert.deepEqual(listChangedPaths(filtered), ['新增 file.txt']);
  assert.deepEqual(filtered.coverage, { totalFiles: 5, reviewedFiles: 1, partial: true, paths: ['新增 file.txt'] });
  assert.equal((await snapshotReview({ cwd: root, target: 'working-tree', paths: [] })).empty, true);
});

test('staged and base-ref use frozen OIDs and distinguish staged from working content', async t => {
  const root = await repository(t); if (!root) return;
  const base = await git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'tracked.txt'), 'staged\n', 'utf8');
  await git(root, 'add', 'tracked.txt');
  await writeFile(path.join(root, 'tracked.txt'), 'unstaged\n', 'utf8');
  const staged = await snapshotReview({ cwd: root, target: 'staged' });
  assert.match(staged.canonicalPatch, /\+staged/);
  assert.doesNotMatch(staged.canonicalPatch, /\+unstaged/);
  assert.equal(staged.baseOid, base);
  await git(root, 'commit', '-qm', 'second');
  const compared = await snapshotReview({ cwd: root, target: 'base-ref', base });
  assert.equal(compared.baseOid, base);
  assert.notEqual(compared.headOid, base);
  assert.match(compared.canonicalPatch, /-before\n\+unstaged/);
  assert.equal((await snapshotReview({ cwd: root, target: 'base-ref', base: '--output=bad' })).error.code, 'GIT_ERROR');
  const rename = 'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n';
  assert.deepEqual(listChangedPaths(await snapshotReview({ cwd: root, target: 'patch', patchText: rename, paths: ['old.txt'] })), ['new.txt']);
});

test('unborn HEAD snapshots contain staged additions and current untracked bytes', async t => {
  const root = await repository(t, false); if (!root) return;
  await writeFile(path.join(root, 'new.txt'), 'index\n', 'utf8');
  await git(root, 'add', 'new.txt');
  await writeFile(path.join(root, 'new.txt'), 'worktree\n', 'utf8');
  await writeFile(path.join(root, 'untracked.txt'), 'extra\n', 'utf8');
  const working = await snapshotReview({ cwd: root, target: 'working-tree' });
  assert.equal(working.baseOid, undefined);
  assert.deepEqual(working.degradedReasons, ['unborn_head']);
  assert.deepEqual(listChangedPaths(working), ['new.txt', 'untracked.txt']);
  assert.match(working.canonicalPatch, /\+worktree/);
  const staged = await snapshotReview({ cwd: root, target: 'staged' });
  assert.match(staged.canonicalPatch, /\+index/);
  assert.deepEqual(listChangedPaths(staged), ['new.txt']);
});

test('same-path same-length untracked binary and text edits change the snapshot hash', async t => {
  const root = await repository(t); if (!root) return;
  await writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, 'text.txt'), 'first\n', 'utf8');
  const first = await snapshotReview({ cwd: root });
  await writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 2, 1]));
  const binary = await snapshotReview({ cwd: root });
  assert.equal(first.canonicalPatch, binary.canonicalPatch); assert.notEqual(first.patchHash, binary.patchHash);
  assert.notEqual(first.untrackedDigests['binary.dat'], binary.untrackedDigests['binary.dat']);
  await writeFile(path.join(root, 'text.txt'), 'other\n', 'utf8');
  const text = await snapshotReview({ cwd: root });
  assert.notEqual(binary.patchHash, text.patchHash); assert.notEqual(binary.untrackedDigests['text.txt'], text.untrackedDigests['text.txt']);
  assert.equal((await snapshotReview({ cwd: root })).patchHash, text.patchHash);
  // Byte hashing must also distinguish text whose normalized diffs are identical.
  await writeFile(path.join(root, 'text.txt'), 'other\r\n', 'utf8');
  const crlf = await snapshotReview({ cwd: root });
  assert.equal(crlf.canonicalPatch, text.canonicalPatch); assert.notEqual(crlf.patchHash, text.patchHash);
});

test('ancestor directory symlinks cannot read files outside an unborn repository', async t => {
  const root = await repository(t, false); if (!root) return;
  const outside = await temporary(t), nested = path.join(root, 'nested');
  await mkdir(nested);
  await writeFile(path.join(nested, 'secret.txt'), 'staged content\n', 'utf8');
  await git(root, 'add', 'nested/secret.txt');
  await unlink(path.join(nested, 'secret.txt')); await rmdir(nested);
  await writeFile(path.join(outside, 'secret.txt'), 'OUTSIDE-PRIVATE-CONTENT\n', 'utf8');
  try { await symlink(outside, nested, 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Directory symlink requires Developer Mode or administrator privileges'); return; } throw error; }
  const snapshot = await snapshotReview({ cwd: root });
  assert.equal(snapshot.empty, false); assert.equal(snapshot.coverage.partial, true);
  assert.equal(snapshot.files.find(f => f.path === 'nested/secret.txt')?.unavailable, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /OUTSIDE-PRIVATE-CONTENT/);
  assert.equal((await statusFingerprint(root)).available, false);
});

test('a final symlink records the link target without following it outside the repository', async t => {
  const root = await repository(t); if (!root) return;
  const outside = await temporary(t), target = path.join(outside, 'private.txt');
  await writeFile(target, 'OUTSIDE-PRIVATE-CONTENT\n', 'utf8');
  try { await symlink(target, path.join(root, 'link.txt'), 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('File symlink requires Developer Mode or administrator privileges'); return; } throw error; }
  const snapshot = await snapshotReview({ cwd: root });
  assert.equal(snapshot.error, undefined); assert.equal(snapshot.coverage.partial, false);
  assert.equal(snapshot.files.find(f => f.path === 'link.txt')?.newMode, '120000');
  assert.equal(snapshot.untrackedDigests['link.txt'], sha256(Buffer.from(target, 'utf8')));
  assert.doesNotMatch(JSON.stringify(snapshot), /OUTSIDE-PRIVATE-CONTENT/);
});

test('patch snapshots need no repository and failures never masquerade as no changes', async t => {
  const root = await temporary(t);
  const patchText = 'diff --git a/a b/a\nindex 1111111..2222222 100644\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n';
  const snapshot = await snapshotReview({ cwd: root, target: 'patch', patchText });
  assert.equal(snapshot.patchHash, hashDiff(patchText));
  assert.deepEqual(snapshot.stats, { files: 1, additions: 1, deletions: 1 });
  assert.equal((await snapshotReview({ cwd: root, target: 'patch', patchText: '' })).empty, true);
  const missing = await snapshotReview({ cwd: root, target: 'working-tree' });
  assert.equal(missing.error.code, 'REPO_UNAVAILABLE');
  assert.equal(missing.empty, false);
  assert.equal(await detectRepo(root), null);
  assert.equal((await statusFingerprint(root)).available, false);
  const controller = new AbortController(); controller.abort();
  const aborted = await runGit(root, ['status'], { signal: controller.signal });
  assert.notEqual(aborted.code, 0);
  assert.equal(typeof aborted.stderr, 'string');
});

test('snapshot from a subdirectory still collects repository-root-relative files', async t => {
  const root = await repository(t); if (!root) return;
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'tracked.txt'), 'changed\n', 'utf8');
  assert.deepEqual(listChangedPaths(await snapshotReview({ cwd: path.join(root, 'nested'), target: 'working-tree' })), ['tracked.txt']);
});

test('turn snapshots support actual DSH union shapes, nested text and coverage gaps', async () => {
  const entries = [
    { kind: 'text', path: 'new.txt', before: false, after: true, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new'] }] },
    { path: 'gone.txt', text: { before: true, after: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-old'] }] } },
    { kind: 'binary', path: 'binary.dat' }, { kind: 'oversized', path: 'large.txt' }, undefined,
  ];
  const calls = [];
  const workspaceChanges = {
    summary: (sessionId, seq) => { assert.equal(sessionId, 's'); assert.equal(seq, 0); return { turn: 6, total: 7, files: entries.map((e, i) => ({ path: e?.path ?? `missing${i}` })) }; },
    diff: async (sessionId, seq, index, signal) => { calls.push(index); assert.ok(signal instanceof AbortSignal); return entries[index]; },
  };
  const snapshot = await snapshotReview({ cwd: 'unused', target: 'turn', workspaceChanges, sessionId: 's', changesSeq: 0 });
  assert.deepEqual(calls, [0, 1, 2, 3, 4]);
  assert.equal(snapshot.turn, 6);
  assert.equal(snapshot.files[0].status, 'added');
  assert.equal(snapshot.files[1].status, 'deleted');
  assert.equal(snapshot.files[2].binary, true);
  assert.equal(snapshot.files[3].oversized, true);
  assert.equal(snapshot.files[4].unavailable, true);
  assert.deepEqual(snapshot.coverage, { totalFiles: 7, reviewedFiles: 3, partial: true });
  assert.equal(snapshot.empty, false);
  assert.match(snapshot.canonicalPatch, /\+new/);
  assert.doesNotMatch(snapshot.canonicalPatch, /\+\+new/);
  const filtered = await snapshotReview({ target: 'turn', workspaceChanges, sessionId: 's', changesSeq: 0, paths: [] });
  assert.equal(filtered.empty, true);
  assert.equal(filtered.coverage.partial, true);
  const unavailable = { kind: 'turn', empty: true, degradeReason: 'turn_unavailable' };
  assert.deepEqual(await snapshotReview({ target: 'turn' }), unavailable);
  assert.deepEqual(await snapshotReview({ target: 'turn', changesSeq: 1, workspaceChanges: { summary() { throw Error('gone'); } } }), unavailable);
});
