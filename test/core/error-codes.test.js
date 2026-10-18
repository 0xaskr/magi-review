import { it } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_STAGES, ERROR_CODES, discussionMissingCode, ballotMissingCode, makeError, isKnownCode } from '../../lib/core/error-codes.js';

it('registers all specified stages and fixed codes', () => {
  assert.deepEqual(ERROR_STAGES, ['input', 'config', 'clerk', 'reviewer', 'discussion', 'aggregate', 'policy', 'minutes', 'reporter']);
  assert.equal(Object.keys(ERROR_CODES).length, 12); for (const code of Object.values(ERROR_CODES)) assert.equal(isKnownCode(code), true);
  assert.equal(Object.isFrozen(ERROR_CODES), true); assert.equal(Object.isFrozen(ERROR_STAGES), true);
});
it('recognizes seat-specific missing discussion and ballot factories', () => {
  assert.equal(discussionMissingCode('A'), 'DISCUSSION_MISSING:A'); assert.equal(ballotMissingCode('BC'), 'BALLOT_MISSING:BC');
  assert.equal(isKnownCode(discussionMissingCode('A')), true); assert.equal(isKnownCode(ballotMissingCode('BC')), true);
  for (const code of ['UNKNOWN', 'DISCUSSION_MISSING:', 'BALLOT_MISSING:a', '__proto__', null]) assert.equal(isKnownCode(code), false);
});
it('constructs structured errors preserving extra metadata', () => {
  assert.deepEqual(makeError('reviewer', ERROR_CODES.REVIEWER_TIMEOUT, 'Deadline exceeded', { seatId: 'a', attempts: 2, retryable: true }),
    { stage: 'reviewer', code: 'REVIEWER_TIMEOUT', message: 'Deadline exceeded', seatId: 'a', attempts: 2, retryable: true });
});
