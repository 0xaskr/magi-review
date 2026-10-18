import { sha256Hex } from './json.js';

/** @param {string} title @returns {string} */
export function normalizeTitle(title) {
  return String(title ?? '').normalize('NFKC').toLowerCase().trim()
    .replace(/^(?:(?:bug|issue|fix|problem)\s*:\s*)+/u, '')
    .replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** Location line/range is deliberately excluded. Context is caller-supplied.
 * @param {{location?: {path?: string}, path?: string, category?: string, title?: string}} finding
 * @param {string} [context] @returns {string}
 */
export function findingFingerprint(finding, context) {
  return sha256Hex([
    finding.location?.path ?? finding.path ?? '', finding.category ?? '',
    normalizeTitle(finding.title), context ?? '',
  ].join('\0')).slice(0, 16);
}

/** @param {string} fingerprint @returns {string} */
export function stableFindingId(fingerprint) {
  return 'F-' + fingerprint.slice(0, 8);
}
