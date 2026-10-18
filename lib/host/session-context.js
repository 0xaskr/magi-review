/** Walk backwards in bounded batches, returning chronological events.
 * DSH seq is a log length; snapshotEvents uses an exclusive upper bound.
 * Callers can stop as soon as their required context has been found.
 */
export function readRecentEvents(session, maxEvents = 1200, enough = completeContext) {
  const events = [];
  try {
    const end = session?.seq;
    if (!Number.isSafeInteger(end) || end < 0) return [];
    const limit = Number.isSafeInteger(maxEvents) && maxEvents >= 0 ? maxEvents : 1200;
    const start = Math.max(0, end - limit);
    for (let to = end; to > start;) {
      const from = Math.max(start, to - 200);
      let batch;
      try { batch = session.snapshotEvents?.(from, to); } catch { /* eventAt compatibility fallback */ }
      if (!Array.isArray(batch) && typeof session.eventAt === 'function') {
        batch = Array.from({ length: to - from }, (_, i) => session.eventAt(from + i));
      }
      if (!Array.isArray(batch)) break;
      events.unshift(...batch.filter(Boolean));
      // Inspect the complete batch, including a boundary before a user message.
      if (enough(events)) break;
      to = from;
    }
  } catch { /* preserve context from batches already read */ }
  return events;
}

function textOf(message) {
  const content = message?.content ?? message?.text ?? message;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
}
function userText(message) {
  const source = message?.source?.kind ?? message?.source;
  if (typeof source === 'string' && /command|runtime|reminder|tool|subagent|context/i.test(source)) return '';
  const text = textOf(message).replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, '').trim();
  if (/^(?:<system-reminder\b|Current runtime context\b|Time sampled\b|\[?(?:command (?:receipt|result|output)|命令(?:回执|结果))(?=\s|[:：\]]|$)|<local-command-(?:stdout|stderr|caveat)>)/i.test(text)) return '';
  return text;
}
const eventText = event => textOf(event?.data?.message ?? event?.data);
const eventUser = event => userText(event?.data?.message ?? event?.data);
function turnOf(events) {
  return events.findLast(e => ['turn/start', 'turn/end'].includes(e.type) && Number.isFinite(e.data?.turn))?.data.turn ?? 0;
}
function derived(session) {
  try { const messages = session?.deriveMessages?.(); return Array.isArray(messages) ? messages : []; }
  catch { return []; }
}
function userOf(events) { return events.filter(e => e.type === 'user/message').map(eventUser).findLast(Boolean) ?? ''; }
function assistantOf(events) { return events.filter(e => e.type === 'assistant/message').map(eventText).findLast(Boolean) ?? ''; }
const hasTurn = events => events.some(e => ['turn/start', 'turn/end'].includes(e.type) && Number.isFinite(e.data?.turn));
const hasChanges = events => events.some(e => e.type === 'workspace/changes');
function completeContext(events) {
  return Boolean(userOf(events) && assistantOf(events) && hasTurn(events) && hasChanges(events));
}

// A busy turn may contain more than 1200 tool events. Walk back to its boundary
// in bounded batches instead of treating the recent-event limit as a turn limit.
const turnEvents = (session, enough) => readRecentEvents(session, session?.seq, enough);
function inferredTurn(events, messages) {
  if (hasTurn(events)) return turnOf(events);
  if (hasTurn(messages)) return turnOf(messages);
  // Compacted/missing logs have no authoritative turn number. Count real user
  // messages as an estimate, excluding command receipts and injected reminders.
  const count = messages.filter(m => m.role === 'user' && userText(m)).length || events.filter(e => e.type === 'user/message' && eventUser(e)).length;
  return count || (messages.some(m => m.role === 'assistant' && textOf(m)) ? 1 : 0);
}
export function currentTurn(session) {
  const events = turnEvents(session, hasTurn);
  return inferredTurn(events, hasTurn(events) ? [] : derived(session));
}
export function latestUserRequest(session) {
  return userOf(readRecentEvents(session, 1200, userOf))
    || derived(session).filter(m => m.role === 'user').map(userText).findLast(Boolean) || '';
}
export function latestAssistantText(session) {
  return assistantOf(readRecentEvents(session, 1200, assistantOf))
    || derived(session).filter(m => m.role === 'assistant').map(textOf).findLast(Boolean) || '';
}
export function latestWorkspaceChangesSeq(session) {
  return readRecentEvents(session, 1200, hasChanges).findLast(e => e.type === 'workspace/changes')?.seq;
}

/** Keep the changes watermark in its own turn; never attach an older turn's changes. */
export function lastTurnWindow(session) {
  const events = turnEvents(session, events => userOf(events)
    && events.some(e => e.type === 'turn/start' && e.data?.turn === turnOf(events)));
  let messages;
  const fallback = () => messages ??= derived(session);
  const turn = inferredTurn(events, hasTurn(events) ? [] : fallback());
  const start = events.findLastIndex(e => e.type === 'turn/start' && e.data?.turn === turn);
  const window = start >= 0 ? events.slice(start) : events;
  const changes = window.findLast(e => e.type === 'workspace/changes' && (e.data?.turn === undefined || e.data.turn === turn));
  // A direct user prompt may be logged immediately before turn/start.
  return { turn, userText: userOf(window) || userOf(events.slice(0, Math.max(0, start)))
      || fallback().filter(m => m.role === 'user').map(userText).findLast(Boolean) || '',
    // With a known turn boundary, never import an older derived assistant reply.
    assistantText: assistantOf(window) || (start < 0 ? fallback().filter(m => m.role === 'assistant').map(textOf).findLast(Boolean) ?? '' : ''),
    ...(changes?.seq !== undefined ? { changesSeq: changes.seq } : {}) };
}
export function buildIntentContext(session) {
  const window = lastTurnWindow(session);
  return { task: window.userText, claims: window.assistantText.slice(0, 2000), turn: window.turn,
    ...(window.changesSeq !== undefined ? { workspaceChangesSeq: window.changesSeq } : {}) };
}
