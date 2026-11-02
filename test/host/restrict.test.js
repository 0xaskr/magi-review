import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewerAllowList, applyReviewerGuard } from '../../lib/restrict.js';

test('reviewer stages map to their wire tool allowlist', () => {
  assert.deepEqual(reviewerAllowList('magi-brief-A').sort(), ['glob', 'grep', 'lsp', 'read', 'structured_output']);
  assert.deepEqual(reviewerAllowList('magi-discussion-B', { allowScripts: false }).sort(),
    ['glob', 'grep', 'lsp', 'read', 'structured_output']);
  assert.deepEqual(reviewerAllowList('magi-discussion-B', { platform: 'win32' }).includes('pwsh'), true);
  assert.deepEqual(reviewerAllowList('magi-discussion-B', { platform: 'linux' }).includes('bash'), true);
  assert.deepEqual(reviewerAllowList('magi-ballot-C'), []);
  // Children this plugin did not start are outside the MAGI tool policy.
  assert.equal(reviewerAllowList('review-helper'), undefined);
  assert.equal(reviewerAllowList('magi-reviewer-readonly'), undefined);
  assert.equal(reviewerAllowList(undefined), undefined);
  assert.equal(reviewerAllowList(42), undefined);
});

test('the guard reads the label lazily, denies everything before binding and allows only listed tools', () => {
  const guards = [], effect = [], disposes = [];
  const ctx = { effect: fn => { const value = fn(); disposes.push(value); return value; },
    tools: { guard: fn => { guards.push(fn); return () => {}; } } };
  let label;
  applyReviewerGuard(ctx, () => label, { allowScripts: false });
  assert.equal(guards.length, 1);
  assert.match(guards[0]({ name: 'read' }), /not bound/);
  label = 'magi-brief-A';
  assert.equal(guards[0]({ name: 'read' }), undefined);
  assert.match(guards[0]({ name: 'write' }), /MAGI reviewer seat/);
  label = 'magi-ballot-A';
  assert.match(guards[0]({ name: 'read' }), /sealed balloting/);
  label = 'review-helper';
  assert.equal(guards[0]({ name: 'write' }), undefined);
  assert.equal(disposes.length, 1);
  assert.throws(() => applyReviewerGuard(ctx, null), /descriptor label reader/);
});
