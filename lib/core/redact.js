// Scan the original string first so reported indices never shift after replacing.
const rules = [
  ['private_key', /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g],
  ['openai_key', /\bsk-[A-Za-z0-9_-]{16,}/g],
  ['aws_key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{20,}/g],
  ['slack_token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['credential_assignment', /\b(?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi],
  ['bearer', /\bBearer\s+[A-Za-z0-9._-]{16,}/gi],
  ['url_credentials', /:\/\/[^\s/:@]+:[^\s/@]+@/g],
  ['env_assignment', /^[ \t]*[+-]?(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]+)(?=\r?$)/gm],
];

/** Overlapping matches produce one redaction covering their union. Hits record
 * only a rule and an original UTF-16 offset, never the matched secret.
 * @param {string} text @returns {{text:string,count:number,hits:{rule:string,index:number}[]}}
 */
export function redactSecrets(text) {
  const matches = [];
  for (const [rule, pattern] of rules) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      // Only a value consisting entirely of a placeholder is already safe.
      if (/[:=]\s*["']?\[REDACTED:[a-z_]+\]["']?\s*$/.test(match[0])) continue;
      matches.push({ rule, index: match.index, end: match.index + match[0].length });
    }
  }
  matches.sort((a, b) => a.index - b.index || b.end - a.end);
  const ranges = [];
  for (const match of matches) {
    const previous = ranges.at(-1);
    if (previous && match.index < previous.end) previous.end = Math.max(previous.end, match.end);
    else ranges.push({ ...match });
  }
  let output = '', cursor = 0;
  for (const hit of ranges) {
    output += text.slice(cursor, hit.index) + `[REDACTED:${hit.rule}]`;
    cursor = hit.end;
  }
  output += text.slice(cursor);
  return { text: output, count: ranges.length, hits: ranges.map(({ rule, index }) => ({ rule, index })) };
}

/** Recursively redact JSON-like string values, leaving keys and input intact.
 * Shared references and cycles are preserved; no raw output is added.
 * @template T @param {T} value @returns {T}
 */
export function redactValue(value) {
  const seen = new WeakMap();
  function visit(item) {
    if (typeof item === 'string') return redactSecrets(item).text;
    if (item === null || typeof item !== 'object') return item;
    if (seen.has(item)) return seen.get(item);
    const result = Array.isArray(item) ? [] : {};
    seen.set(item, result);
    for (const [key, child] of Object.entries(item)) {
      Object.defineProperty(result, key, { value: visit(child), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  return visit(value);
}
