import test from 'node:test';
import assert from 'node:assert/strict';
import { toReviewError, fromStopReason, degradedReason } from '../../lib/host/errors.js';

test('errors retain approved diagnostics and map core degradation names', () => {
  const error = Object.assign(new Error('failed'), { code: 'ORIGINAL', cause: Error('network'), retryable: true, arbitrary: 'excluded' });
  assert.deepEqual(toReviewError(error, { stage: 'minutes', code: 'MINUTES_FAILED', seatId: 'A' }), {
    stage: 'minutes', code: 'MINUTES_FAILED', message: 'failed', retryable: true, cause: 'network', seatId: 'A',
  });
  assert.equal(fromStopReason('completed'), null);
  assert.equal(fromStopReason('aborted'), 'REVIEWER_ABORTED');
  assert.equal(fromStopReason('max-tokens'), 'REVIEWER_ERROR');
  assert.equal(degradedReason('WORKSPACE_MUTATED'), 'workspace_mutated_during_review');
  assert.equal(degradedReason('DISCUSSION_MISSING', { seatRef: 'B' }), 'discussion_missing:B');
  assert.equal(degradedReason('BALLOT_MISSING:C'), 'ballot_missing:C');
});
