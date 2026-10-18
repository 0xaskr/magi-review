/** @type {readonly string[]} */
export const ERROR_STAGES = Object.freeze(['input', 'config', 'clerk', 'reviewer', 'discussion', 'aggregate', 'policy', 'minutes', 'reporter']);

/** Versioned public error names. Seat-specific names use the factories below. */
export const ERROR_CODES = Object.freeze(Object.fromEntries([
  'CLERK_FALLBACK', 'REVIEWER_TIMEOUT', 'REVIEWER_OUTPUT_INVALID', 'INVALID_SEAT_OUTPUT',
  'MODEL_ROUTE_UNAVAILABLE', 'BUDGET_EXCEEDED', 'TOTAL_TIMEOUT', 'WORKSPACE_MUTATED',
  'MINUTES_FAILED', 'MINUTES_INVALID', 'HUMAN_CONFIRMATION_MISSING', 'NO_CHANGES',
].map(code => [code, code])));

/** @param {string} seatRef @returns {string} */
export function discussionMissingCode(seatRef) { return `DISCUSSION_MISSING:${seatRef}`; }

/** @param {string} seatRef @returns {string} */
export function ballotMissingCode(seatRef) { return `BALLOT_MISSING:${seatRef}`; }

/** @param {string} code @returns {boolean} */
export function isKnownCode(code) {
  return typeof code === 'string' && (Object.hasOwn(ERROR_CODES, code) || /^(?:DISCUSSION|BALLOT)_MISSING:[A-Z]+$/.test(code));
}

/** @param {string} stage @param {string} code @param {string} message
 * @param {{seatId?:string,retryable?:boolean,fatal?:boolean,attempts?:number,providerRequestId?:string,cause?:string}} [extra]
 * @returns {{stage:string,code:string,message:string,seatId?:string,retryable?:boolean,fatal?:boolean,attempts?:number,providerRequestId?:string,cause?:string}}
 */
export function makeError(stage, code, message, extra = {}) { return { stage, code, message, ...extra }; }
