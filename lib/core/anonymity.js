/** @param {{seatId?:string,id?:string}[]} seats @returns {{seatId:string,seatRef:string}[]} */
export function assignSeatRefs(seats) {
  return seats.map((seat, index) => {
    let n = index + 1, seatRef = '';
    while (n > 0) { n--; seatRef = String.fromCharCode(65 + n % 26) + seatRef; n = Math.floor(n / 26); }
    return { seatId: seat.seatId ?? seat.id, seatRef };
  });
}

// All docket objects use allowlists, including nested locations and evidence.
function pick(object, keys) {
  return Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, structuredClone(object[key])]));
}

const perspectiveTokens = ['architect', 'engineer', 'adversary', '架构师', '工程师', '对抗'];
function identityTokens(tokens = []) {
  return [...new Set(tokens.filter(token => typeof token === 'string' && token.trim()).map(token => token.toLowerCase()))]
    .sort((a, b) => b.length - a.length);
}

/** Literal, case-insensitive replacements; ASCII word boundaries preserve words
 * such as architecture, while Chinese identity words can occur within a sentence.
 * Longer overlapping tokens are consumed first, without re-scrubbing [seat].
 * @param {string} text @param {string[]} tokens @returns {string}
 */
export function scrubIdentityText(text, tokens = []) {
  const patterns = identityTokens(tokens).map(token => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return `${/^[a-z0-9_]/i.test(token) ? '(?<![a-z0-9_])' : ''}${escaped}${/[a-z0-9_]$/i.test(token) ? '(?![a-z0-9_])' : ''}`;
  });
  return patterns.length ? text.replace(new RegExp(patterns.join('|'), 'giu'), '[seat]') : text;
}

function scrubStrings(value, tokens) {
  if (typeof value === 'string') return scrubIdentityText(value, tokens);
  if (Array.isArray(value)) return value.map(item => scrubStrings(item, tokens));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubStrings(item, tokens)]));
  return value;
}

/** Strict serialized leak check for diagnostics; returns errors rather than throwing.
 * @param {object} docket @param {string[]} tokens @returns {string[]}
 */
export function assertAnonymousDocket(docket, tokens = []) {
  try {
    const serialized = JSON.stringify(docket).toLowerCase();
    return identityTokens(tokens).filter(token => serialized.includes(token)).map(token => `identity_token:${token}`);
  } catch { return ['invalid_docket']; }
}

/** @param {import('./types.js').SeatBrief[]} briefs
 * @param {{extraTokens?:string[]}} [options]
 * @returns {{seats:{seatRef:string,verdict?:string,impact?:string,findings:object[],summary:string,evidenceNote?:string}[]}}
 */
export function buildDocket(briefs, options = {}) {
  const identities = identityTokens([...perspectiveTokens, ...(options.extraTokens ?? []), ...briefs.flatMap(brief => [
    brief.seatId, brief.perspective, brief.perspective?.split(':').at(-1), brief.model?.provider, brief.model?.model,
    brief.seat?.label, brief.label, brief.childSessionId,
  ])]);
  const docket = { seats: briefs.map(brief => ({
    ...pick(brief, ['seatRef', 'verdict', 'impact', 'summary', 'evidenceNote']),
    findings: (brief.findings ?? []).map((finding, index) => {
      const item = pick(finding, ['severity', 'confidence', 'category', 'title', 'rationale', 'suggestion', 'mustFix', 'introducedByChange']);
      // Retain ordinary local IDs; hide IDs embedding a known real identity.
      const sourceId = typeof finding.id === 'string' && finding.id && !identities.some(secret => finding.id.toLowerCase().includes(secret)) ? finding.id : String(index + 1);
      item.id = `${brief.seatRef}:${sourceId}`;
      if (finding.location) {
        item.location = pick(finding.location, ['path', 'side', 'line']);
        if (finding.location.range) item.location.range = pick(finding.location.range, ['start', 'end']);
      }
      if (finding.evidence) item.evidence = finding.evidence.map(e => pick(e, ['kind', 'path', 'line', 'command', 'exitCode', 'outputDigest', 'note']));
      return item;
    }),
  })) };
  return scrubStrings(docket, identities);
}

/** @param {import('./types.js').Ballot[]} ballots
 * @returns {{approve:number,request:number,changed:number,total:number}}
 */
export function tallyBallots(ballots) {
  return ballots.reduce((tally, ballot) => {
    if (!['approve', 'request_changes'].includes(ballot.finalVerdict) || ballot.status === 'error') return tally;
    tally.total++;
    tally[ballot.finalVerdict === 'approve' ? 'approve' : 'request']++;
    if (ballot.changedFromBrief === true) tally.changed++;
    return tally;
  }, { approve: 0, request: 0, changed: 0, total: 0 });
}

/** Reveal only after the caller has finalized the rule decision. Changed means
 * the final vote differs from the brief, even if intermediate positions changed.
 * @param {import('./types.js').ModelAssignment[]} assignment
 * @param {import('./types.js').SeatBrief[]} briefs
 * @param {import('./types.js').Ballot[]} ballots
 * @param {import('./types.js').DiscussionRound[]} [discussion]
 * @returns {import('./types.js').RevealInfo}
 */
export function buildReveal(assignment, briefs, ballots, discussion = []) {
  const refs = assignSeatRefs(assignment);
  return { at: 'verdict', seats: assignment.map((seat, index) => {
    const seatRef = seat.seatRef ?? briefs.find(b => b.seatId === seat.seatId)?.seatRef ?? refs[index].seatRef;
    const brief = briefs.find(b => b.seatRef === seatRef);
    const ballot = ballots.find(b => b.seatRef === seatRef && b.status !== 'error');
    return {
      seatRef, seatId: seat.seatId, perspective: seat.perspective ?? brief?.perspective ?? '',
      provider: seat.provider ?? brief?.model?.provider ?? '', model: seat.model ?? brief?.model?.model ?? '',
      ...(brief?.verdict ? { briefVerdict: brief.verdict } : {}),
      ...(ballot?.finalVerdict ? { finalVerdict: ballot.finalVerdict } : {}),
      changed: Boolean(brief?.verdict && ballot?.finalVerdict && brief.verdict !== ballot.finalVerdict),
    };
  }) };
}
