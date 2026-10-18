import { createHash } from 'node:crypto';

/** Extract the last JSON fenced object, or the last balanced object in prose.
 * @param {string} text @returns {object|null}
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const fences = [...text.matchAll(/```json\b\s*\r?\n?([\s\S]*?)```/gi)];
  let candidate = fences.at(-1)?.[1];
  if (candidate === undefined) {
    const starts = [];
    let quoted = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (starts.length === 0) {
        if (ch === '{') { starts.push(i); quoted = false; }
        continue;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === '{') starts.push(i);
      else if (ch === '}') candidate = text.slice(starts.pop(), i + 1);
    }
  }
  try {
    const value = JSON.parse(candidate);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/** JSON semantics with recursively sorted object keys; cycles/BigInt throw.
 * @param {*} value @returns {string|undefined}
 */
export function stableStringify(value) {
  const ancestors = new Set();
  function encode(item, key = '') {
    if (item && typeof item.toJSON === 'function') item = item.toJSON(key);
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (ancestors.has(item)) throw new TypeError('Cannot serialize a cyclic value');
    ancestors.add(item);
    const result = Array.isArray(item)
      ? '[' + Array.from(item, (v, i) => encode(v, String(i)) ?? 'null').join(',') + ']'
      : '{' + Object.keys(item).sort().flatMap(k => {
        const encoded = encode(item[k], k);
        return encoded === undefined ? [] : [JSON.stringify(k) + ':' + encoded];
      }).join(',') + '}';
    ancestors.delete(item);
    return result;
  }
  return encode(value);
}

/** @param {string} text @returns {string} Lowercase SHA-256 hex. */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
