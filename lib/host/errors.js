import { makeError } from '../core/error-codes.js';

/** Build the public ReviewError shape without copying arbitrary exception fields. */
export function toReviewError(error, { stage = 'reviewer', code, seatId } = {}) {
  const source = error?.error ?? error;
  const message = typeof source === 'string' ? source : String(source?.message ?? source?.code ?? 'Unknown error');
  const extra = {};
  for (const key of ['retryable', 'fatal', 'attempts', 'providerRequestId']) {
    if (source?.[key] !== undefined) extra[key] = source[key];
  }
  if (seatId !== undefined) extra.seatId = seatId;
  else if (typeof source?.seatId === 'string') extra.seatId = source.seatId;
  if (source?.cause !== undefined) extra.cause = String(source.cause?.message ?? source.cause);
  return makeError(stage, code ?? source?.code ?? 'REVIEWER_ERROR', message, extra);
}

export function fromStopReason(stopReason) {
  const kind = stopReason?.kind ?? stopReason;
  return kind === 'completed' ? null : kind === 'aborted' ? 'REVIEWER_ABORTED' : 'REVIEWER_ERROR';
}

/** Degraded reasons are strings in the core policy/digest contracts. */
export function degradedReason(code, extra) {
  const names = { WORKSPACE_MUTATED: 'workspace_mutated_during_review', REVIEWER_TIMEOUT: 'reviewer_error',
    REVIEWER_ABORTED: 'reviewer_error', REVIEWER_OUTPUT_INVALID: 'reviewer_error', INVALID_SEAT_OUTPUT: 'reviewer_error' };
  const [base, suffix] = String(code).split(':');
  const reason = names[base] ?? base.toLowerCase();
  const seat = suffix ?? (typeof extra === 'string' ? extra : extra?.seatRef ?? extra?.seatId);
  return ['DISCUSSION_MISSING', 'BALLOT_MISSING'].includes(base) && seat ? `${reason}:${seat}` : reason;
}
