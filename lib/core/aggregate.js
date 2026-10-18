import { findingFingerprint, stableFindingId } from './fingerprint.js';
import { stableStringify } from './json.js';

const severityRank = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const confidenceRank = { low: 0, medium: 1, high: 2 };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const unique = values => [...new Set(values)].sort(compare);

/** Merge completed evidence without dropping original IDs. Invalid ID collisions
 * across fingerprints receive an additional qualified alias and a warning; the
 * original ID remains present exactly once. Missing IDs receive synthetic IDs.
 * sourceCount counts input findings; mergedCount counts eliminated duplicates.
 * @param {import('./types.js').SeatBrief[]} briefs
 * @returns {{findings:import('./types.js').AggregatedFinding[],sourceCount:number,mergedCount:number,warnings:string[]}}
 */
export function aggregateFindings(briefs) {
  const warnings = [], entries = [];
  for (const brief of briefs) {
    if (brief.status !== 'completed') {
      warnings.push(`Seat ${brief.seatRef}: ${brief.status}; findings excluded.`);
      continue;
    }
    for (const finding of brief.findings ?? []) {
      entries.push({ finding, seatRef: brief.seatRef, fingerprint: finding.fingerprint || findingFingerprint(finding) });
    }
  }
  entries.sort((a, b) => compare(a.fingerprint, b.fingerprint) || compare(a.seatRef, b.seatRef)
    || compare(stableStringify(a.finding), stableStringify(b.finding)));
  const reserved = new Set(entries.map(e => e.finding.id).filter(id => typeof id === 'string' && id.trim()));
  const owners = new Map(), groups = new Map();
  let serial = 0;
  for (const entry of entries) {
    const { finding, seatRef, fingerprint } = entry;
    let id = finding.id;
    const owner = owners.get(id);
    const missing = typeof id !== 'string' || !id.trim();
    if (missing || owner !== undefined) {
      warnings.push(`Seat ${seatRef}: ${missing ? 'missing finding.id' : `duplicate finding.id ${JSON.stringify(id)}`} (${fingerprint}).`);
    }
    if (missing || (owner !== undefined && owner !== fingerprint)) {
      const original = missing ? 'missing' : id;
      do { id = `${seatRef}:${original}:${++serial}`; } while (reserved.has(id));
      reserved.add(id);
      warnings.push(`Seat ${seatRef}: provenance alias ${JSON.stringify(id)} (${fingerprint}).`);
    }
    owners.set(id, fingerprint);
    if (!groups.has(fingerprint)) groups.set(fingerprint, []);
    groups.get(fingerprint).push({ ...entry, id });
  }
  const findings = [...groups].map(([fingerprint, sources]) => {
    const ordered = [...sources].sort((a, b) => severityRank[b.finding.severity] - severityRank[a.finding.severity]
      || confidenceRank[b.finding.confidence] - confidenceRank[a.finding.confidence]
      || compare(stableStringify(a.finding), stableStringify(b.finding)));
    const first = ordered[0].finding;
    const severity = first.severity;
    const confidence = ordered.reduce((best, s) => confidenceRank[s.finding.confidence] > confidenceRank[best] ? s.finding.confidence : best, first.confidence);
    const sourceSeatRefs = unique(sources.map(s => s.seatRef));
    const result = {
      id: stableFindingId(fingerprint), fingerprint,
      sourceSeatRefs, sourceFindingIds: unique(sources.map(s => s.id)),
      ...(first.location ? { location: structuredClone(first.location) } : first.path ? { location: { path: first.path } } : {}),
      severity, confidence, category: first.category, title: first.title,
      rationale: unique(sources.map(s => s.finding.rationale).filter(Boolean)).join('\n'),
      mustFix: sources.some(s => s.finding.mustFix === true),
      introducedByChange: sources.some(s => s.finding.introducedByChange === true),
      status: 'non_blocking',
      mergeReason: `${sources.length} source findings from ${sourceSeatRefs.length} seats; highest severity ${severity}.`,
    };
    const suggestions = unique(sources.map(s => s.finding.suggestion).filter(Boolean));
    if (suggestions.length) result.suggestion = suggestions.join('\n');
    return result;
  });
  findings.sort((a, b) => severityRank[b.severity] - severityRank[a.severity]
    || compare(a.location?.path ?? '', b.location?.path ?? '')
    || (a.location?.line ?? a.location?.range?.start ?? 0) - (b.location?.line ?? b.location?.range?.start ?? 0)
    || compare(a.fingerprint, b.fingerprint));
  return { findings, sourceCount: entries.length, mergedCount: entries.length - findings.length, warnings: unique(warnings) };
}

/** @param {import('./types.js').SeatBrief[]} briefs
 * @returns {{completed:number,failed:number,byVerdict:{approve:number,request_changes:number,error:number}}}
 */
export function summarizeSeats(briefs) {
  const result = { completed: 0, failed: 0, byVerdict: { approve: 0, request_changes: 0, error: 0 } };
  for (const brief of briefs) {
    if (brief.status === 'completed') {
      result.completed++;
      if (brief.verdict === 'approve' || brief.verdict === 'request_changes') result.byVerdict[brief.verdict]++;
    } else { result.failed++; result.byVerdict.error++; }
  }
  return result;
}
