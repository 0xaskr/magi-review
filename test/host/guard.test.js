import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureWorkspaceState, detectWorkspaceMutation } from '../../lib/host/guard.js';
import { repository, temporary } from './helpers.js';

test('guard detects tracked and already-untracked content mutation, but not stable state', async t => {
  const root = await repository(t); if (!root) return;
  const before = await captureWorkspaceState({ cwd: root });
  assert.ok(before.combined);
  assert.ok(Number.isFinite(Date.parse(before.at)));
  assert.deepEqual(detectWorkspaceMutation(before, await captureWorkspaceState({ cwd: root })), { mutated: false });
  await writeFile(path.join(root, 'tracked.txt'), 'changed\n', 'utf8');
  assert.equal(detectWorkspaceMutation(before, await captureWorkspaceState({ cwd: root })).mutated, true);
  await writeFile(path.join(root, 'new.txt'), 'one', 'utf8');
  const untracked = await captureWorkspaceState({ cwd: root });
  await writeFile(path.join(root, 'new.txt'), 'two', 'utf8');
  assert.equal(detectWorkspaceMutation(untracked, await captureWorkspaceState({ cwd: root })).mutated, true);
});

test('guard explicitly marks missing repository state as unavailable', async t => {
  const root = await temporary(t);
  const unavailable = await captureWorkspaceState({ cwd: root });
  assert.equal(unavailable.combined, null);
  assert.deepEqual(detectWorkspaceMutation(unavailable, { combined: 'x' }), { mutated: false, reason: 'unavailable' });
  assert.equal(detectWorkspaceMutation({ combined: 'x' }, null).mutated, false);
});
