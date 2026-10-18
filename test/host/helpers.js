import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGit } from '../../lib/host/git.js';

export async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magi-host-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}
export async function git(root, ...args) {
  const result = await runGit(root, ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}
export async function repository(t, commit = true) {
  const root = await temporary(t);
  const available = await runGit(root, ['--version']);
  if (available.code === 'ENOENT') { t.skip('Git executable is not installed'); return null; }
  assert.equal(available.code, 0, available.stderr);
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.name', 'Host Test');
  await git(root, 'config', 'user.email', 'host-test@example.invalid');
  await git(root, 'config', 'core.autocrlf', 'false');
  if (commit) {
    await writeFile(path.join(root, 'tracked.txt'), 'before\n', 'utf8');
    await writeFile(path.join(root, 'delete.txt'), 'delete me\n', 'utf8');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'fixture');
  }
  return root;
}
