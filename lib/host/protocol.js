import { extractJson } from '../core/json.js';
import { findingFingerprint, stableFindingId } from '../core/fingerprint.js';

const votes = ['approve', 'request_changes'];
const impacts = ['major', 'normal'];
const confidences = ['high', 'medium', 'low'];
const targets = ['turn', 'working-tree', 'staged', 'base-ref', 'patch'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Invalid objects still expose a normalized value for diagnostics, never acceptance.
function validate(raw, build) {
  const errors = [];
  if (!object(raw)) return { ok: false, errors: ['Expected an object'] };
  try {
    const value = build(raw, errors);
    return { ok: errors.length === 0, value, errors };
  } catch {
    return { ok: false, errors: [...errors, 'Unable to read protocol object'] };
  }
}

function string(raw, key, errors, { required = true, max = Infinity, truncate = false, nonempty = false, trim = true } = {}) {
  if (!required && raw[key] === undefined) return undefined;
  if (typeof raw[key] !== 'string') { errors.push(`${key}: expected string`); return ''; }
  const value = trim ? raw[key].trim() : raw[key];
  if (nonempty && !value.trim()) errors.push(`${key}: must not be empty`);
  if (!truncate && value.length > max) errors.push(`${key}: exceeds ${max} characters`);
  let end = Math.min(value.length, max);
  if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1])) end--;
  return value.slice(0, end);
}

function enumeration(raw, key, values, errors, lower = false) {
  const value = lower && typeof raw[key] === 'string' ? raw[key].trim().toLowerCase() : raw[key];
  if (!values.includes(value)) { errors.push(`${key}: expected ${values.join('|')}`); return undefined; }
  return value;
}

function boolean(raw, key, errors) {
  if (typeof raw[key] !== 'boolean') { errors.push(`${key}: expected boolean`); return false; }
  return raw[key];
}

function integer(raw, key, errors, min = 1) {
  if (!Number.isSafeInteger(raw[key]) || raw[key] < min) { errors.push(`${key}: expected integer >= ${min}`); return undefined; }
  return raw[key];
}

function array(raw, key, errors, check) {
  if (!Array.isArray(raw[key])) { errors.push(`${key}: expected array`); return []; }
  const values = [];
  for (const [index, item] of raw[key].entries()) {
    const result = check(item);
    if (result.ok) values.push(result.value);
    else errors.push(...result.errors.map(error => `${key}[${index}].${error}`));
  }
  return values;
}

const stringItem = value => typeof value === 'string'
  ? { ok: true, value, errors: [] } : { ok: false, errors: ['expected string'] };
function optionalString(out, raw, key, errors, options = {}) {
  if (raw[key] !== undefined) out[key] = string(raw, key, errors, options);
}

function bindSeat(raw, expected, allowed, errors) {
  if (typeof expected !== 'string' || !expected) errors.push('seatRef: missing request binding');
  if (raw.seatRef !== expected || typeof raw.seatRef !== 'string') errors.push('seatRef: does not match request');
  if (allowed && !allowed.includes(expected)) errors.push('seatRef: not an allowed seat');
  return expected;
}

function location(raw) {
  return validate(raw, (input, errors) => {
    const out = { path: string(input, 'path', errors, { nonempty: true, trim: false }).replace(/\\/g, '/'),
      side: enumeration(input, 'side', ['old', 'new'], errors) };
    if (input.line !== undefined) out.line = integer(input, 'line', errors);
    if (input.range !== undefined) {
      const range = validate(input.range, (r, e) => {
        const start = integer(r, 'start', e), end = integer(r, 'end', e);
        if (end < start) e.push('end: must be >= start');
        return { start, end };
      });
      errors.push(...range.errors.map(e => `range.${e}`));
      if (range.ok) out.range = range.value;
    }
    optionalString(out, input, 'hunkId', errors);
    return out;
  });
}

function evidence(raw) {
  return validate(raw, (input, errors) => {
    const out = { kind: enumeration(input, 'kind', ['code', 'test', 'script', 'document'], errors),
      note: string(input, 'note', errors) };
    for (const key of ['path', 'command', 'outputDigest']) optionalString(out, input, key, errors, { trim: false });
    if (input.line !== undefined) out.line = integer(input, 'line', errors);
    if (input.exitCode !== undefined) out.exitCode = integer(input, 'exitCode', errors, Number.MIN_SAFE_INTEGER);
    return out;
  });
}

/** Validate model-owned finding fields; identity and provenance are host-owned. */
export function validateSeatFinding(raw) {
  return validate(raw, (input, errors) => {
    const out = {
      title: string(input, 'title', errors, { nonempty: true, max: 300, truncate: true }),
      rationale: string(input, 'rationale', errors, { max: 4000, truncate: true }),
      severity: enumeration(input, 'severity', ['critical', 'high', 'medium', 'low', 'info'], errors, true),
      confidence: enumeration(input, 'confidence', confidences, errors, true),
      category: string(input, 'category', errors),
      mustFix: boolean(input, 'mustFix', errors), introducedByChange: boolean(input, 'introducedByChange', errors),
    };
    if (input.location !== undefined) {
      const checked = location(input.location);
      errors.push(...checked.errors.map(e => `location.${e}`));
      if (checked.ok) out.location = checked.value;
    }
    optionalString(out, input, 'suggestion', errors);
    if (input.evidence !== undefined) out.evidence = array(input, 'evidence', errors, evidence);
    out.fingerprint = input.fingerprint === undefined ? findingFingerprint(out) : string(input, 'fingerprint', errors, { nonempty: true });
    out.id = input.id === undefined ? stableFindingId(out.fingerprint) : string(input, 'id', errors, { nonempty: true });
    return out;
  });
}

export function validateSeatBrief(raw, { seatRef, allowedSeatRefs } = {}) {
  return validate(raw, (input, errors) => {
    const out = { seatRef: bindSeat(input, seatRef, allowedSeatRefs, errors),
      verdict: enumeration(input, 'verdict', votes, errors), impact: enumeration(input, 'impact', impacts, errors),
      findings: array(input, 'findings', errors, validateSeatFinding), summary: string(input, 'summary', errors, { max: 2000 }) };
    optionalString(out, input, 'evidenceNote', errors, { max: 4000 });
    if (out.verdict === 'approve' && out.findings.some(f => f.mustFix && ['critical', 'high'].includes(f.severity))) {
      errors.push('verdict: approve cannot include a mustFix high/critical finding');
    }
    return out;
  });
}

export function validateDiscussionResponse(raw, { seatRef, round, allowedSeatRefs = [] } = {}) {
  return validate(raw, (input, errors) => {
    const peer = (value, key, e) => {
      const ref = string(value, key, e, { nonempty: true });
      if (!allowedSeatRefs.includes(ref) || ref === seatRef) e.push(`${key}: expected another allowed seat`);
      return ref;
    };
    const response = item => validate(item, (v, e) => ({ seatRef: peer(v, 'seatRef', e), reason: string(v, 'reason', e) }));
    const out = { seatRef: bindSeat(input, seatRef, allowedSeatRefs, errors), round,
      agreesWith: array(input, 'agreesWith', errors, response), disagreesWith: array(input, 'disagreesWith', errors, response),
      positionChanged: boolean(input, 'positionChanged', errors), newFindings: array(input, 'newFindings', errors, validateSeatFinding),
      questions: array(input, 'questions', errors, item => validate(item, (v, e) => ({ to: peer(v, 'to', e), question: string(v, 'question', e) }))) };
    if (!Number.isSafeInteger(round) || round < 1) errors.push('round: invalid request binding');
    if (input.round !== round) errors.push('round: does not match request');
    if (out.positionChanged || input.changeReason !== undefined) out.changeReason = string(input, 'changeReason', errors, { max: 2000, nonempty: out.positionChanged });
    return out;
  });
}

export function validateBallot(raw, { seatRef } = {}) {
  return validate(raw, (input, errors) => {
    const out = { seatRef: bindSeat(input, seatRef, undefined, errors), finalVerdict: enumeration(input, 'finalVerdict', votes, errors),
      finalFindings: array(input, 'finalFindings', errors, validateSeatFinding), changedFromBrief: boolean(input, 'changedFromBrief', errors) };
    if (input.finalImpact !== undefined) out.finalImpact = enumeration(input, 'finalImpact', impacts, errors);
    if (out.changedFromBrief || input.changeReason !== undefined) out.changeReason = string(input, 'changeReason', errors, { max: 2000, nonempty: out.changedFromBrief });
    return out;
  });
}

// Accept the M2a catalog as well as a flat provider/model list for injected callers.
function availableRoutes(routes) {
  return Array.isArray(routes) ? routes.filter(r => r?.available !== false)
    : (routes?.providers ?? []).filter(p => p?.available !== false).flatMap(p => (p.models ?? [])
      .filter(m => m?.available !== false).map(m => ({ provider: p.id, model: m.id })));
}

/** Optional config supplies pin metadata absent from the seatIds-only contract.
 * runClerk validates the basic proposal first, then enforces pins deterministically.
 */
export function validateClerkProposal(raw, { routes, seatIds = [], snapshot, config } = {}) {
  return validate(raw, (input, errors) => {
    const available = availableRoutes(routes), paths = new Set((snapshot?.files ?? []).map(f => f.path));
    const out = { targetKind: enumeration(input, 'targetKind', targets, errors), rationale: string(input, 'rationale', errors, { max: 2000 }),
      confidence: enumeration(input, 'confidence', confidences, errors, true),
      modelAssignment: array(input, 'modelAssignment', errors, item => validate(item, (v, e) => {
        const assignment = { seatId: string(v, 'seatId', e, { nonempty: true }), provider: string(v, 'provider', e, { nonempty: true }),
          model: string(v, 'model', e, { nonempty: true }), assignmentReason: string(v, 'assignmentReason', e) };
        if (!seatIds.includes(assignment.seatId)) e.push('seatId: not configured');
        if (!available.some(r => r.provider === assignment.provider && r.model === assignment.model)) e.push('provider/model: route unavailable');
        const pin = config?.seats?.find(s => s.id === assignment.seatId)?.model;
        if (pin && (assignment.provider !== pin.provider || assignment.model !== pin.model)) e.push('provider/model: differs from pinned route');
        return assignment;
      })) };
    for (const id of seatIds) {
      if (out.modelAssignment.filter(a => a.seatId === id).length !== 1) errors.push('modelAssignment: each configured seat must appear exactly once (' + id + ')');
    }
    if (input.files !== undefined) out.files = array(input, 'files', errors, path => {
      const checked = stringItem(path);
      return checked.ok && !paths.has(path) ? { ok: false, errors: ['path outside snapshot'] } : checked;
    });
    if (input.intent !== undefined) {
      const checked = validate(input.intent, (v, e) => {
        const intent = {};
        for (const key of ['task', 'claims', 'plan']) optionalString(intent, v, key, e, { max: 4000 });
        return intent;
      });
      errors.push(...checked.errors.map(e => `intent.${e}`));
      if (checked.ok) out.intent = checked.value;
    }
    if (input.focus !== undefined) out.focus = array(input, 'focus', errors, stringItem);
    return out;
  });
}

export function validateMinutes(raw) {
  return validate(raw, (input, errors) => {
    // Only absent arrays are repairable; explicitly malformed arrays still fail.
    const minutesArray = (v, key, e, check) => v[key] === undefined ? [] : array(v, key, e, check);
    for (const key of ['recommendation', 'advice', 'suggestion', 'verdict', 'approve', 'request_changes']) {
      if (Object.hasOwn(input, key)) errors.push(`${key}: forbidden top-level minutes field`);
    }
    if (input.minutesStatus !== undefined && input.minutesStatus !== 'ok') errors.push('minutesStatus: must be ok');
    const fields = (required, optional = []) => item => validate(item, (v, e) => {
      const out = {};
      for (const key of required) out[key] = string(v, key, e);
      for (const key of optional) optionalString(out, v, key, e);
      return out;
    });
    return { summary: string(input, 'summary', errors, { max: 4000 }),
      seatSummaries: minutesArray(input, 'seatSummaries', errors, item => validate(item, (v, e) => {
        const seatId = string(v, 'seatId', e, { nonempty: true });
        return { seatId, label: v.label === undefined ? seatId : string(v, 'label', e), view: v.view === undefined ? '' : string(v, 'view', e) };
      })),
      consensus: minutesArray(input, 'consensus', errors, fields(['statement'], ['fingerprint'])),
      disputes: minutesArray(input, 'disputes', errors, item => validate(item, (v, e) => {
        const out = { seats: minutesArray(v, 'seats', e, stringItem), point: string(v, 'point', e), resolved: boolean(v, 'resolved', e) };
        optionalString(out, v, 'fingerprint', e);
        return out;
      })),
      voteChanges: minutesArray(input, 'voteChanges', errors, fields(['seatId', 'from', 'to', 'reason'])),
      unresolvedQuestions: minutesArray(input, 'unresolvedQuestions', errors, item => validate(item, (v, e) => {
        const out = { from: v.from === undefined ? 'unknown' : string(v, 'from', e), question: string(v, 'question', e) };
        optionalString(out, v, 'to', e);
        return out;
      })),
      evidenceStrength: enumeration(input, 'evidenceStrength', ['strong', 'moderate', 'weak'], errors),
      dissent: minutesArray(input, 'dissent', errors, item => validate(item, (v, e) => ({
        seatId: string(v, 'seatId', e), verdict: string(v, 'verdict', e), reason: string(v, 'reason', e, { trim: false }),
      }))), minutesStatus: 'ok' };
  });
}

export function parseSeatResponse(result, { seatRef, kind, ...options } = {}) {
  const rawText = typeof result?.text === 'string' ? result.text : '';
  const usedStructured = result?.structured !== undefined && result?.structured !== null;
  const metadata = { rawText, usedStructured };
  if (result?.ok !== true || result.error || result.stopReason && result.stopReason !== 'completed') {
    return { ok: false, errors: ['Seat execution did not complete successfully'], ...metadata };
  }
  const validators = { brief: validateSeatBrief, discussion: validateDiscussionResponse, ballot: validateBallot };
  if (!Object.hasOwn(validators, kind)) return { ok: false, errors: ['Unknown response kind'], ...metadata };
  const raw = usedStructured ? result.structured : extractJson(rawText);
  const checked = validators[kind](raw, { ...options, seatRef });
  return { ...checked, ...metadata };
}

export function summarizeErrors(errors, max = 5) {
  const list = Array.isArray(errors) ? errors : errors == null ? [] : [errors];
  const count = Number.isSafeInteger(max) && max >= 0 ? max : 5;
  const messages = list.slice(0, count).map(e => typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : 'Unknown error');
  if (list.length > count) messages.push(`(+${list.length - count} more)`);
  return messages.join('; ');
}
