/**
 * MAGI reviewer tool guard.
 *
 * Reviewer children inherit the caller's agent preset (mode) because this plugin
 * no longer registers presets of its own, so their inherited tool set can be the
 * caller's full one. This module is the boundary that keeps a reviewer to the
 * tools of its stage: a deny-by-default guard installed on the child's
 * agent-scoped context. It runs after the `tools/pre-execute` waterfall and
 * before dispatch, so it needs no knowledge of the inherited tool set and stays
 * correct when the host composition adds tools later.
 *
 * Why not `ctx.tools.restrict(...)`? `restrict` validates every named tool
 * against the agent's *inherited* restrictable names, while a preset's own tool
 * rows are scoped registrations. Mixed allow/deny masks therefore either throw
 * on unknown names or leave host-level tools reachable. The guard API denies by
 * name at execution time and is the hard boundary used here.
 *
 * The stage comes from the durable `subagent/descriptor` label that
 * `lib/host/seat.js` passes to `subagents.startActivation`:
 *
 * - `magi-brief-<seatRef>`: read-only file tools.
 * - `magi-discussion-<seatRef>`: read-only tools plus a shell when the review
 *   config allows verification scripts.
 * - `magi-ballot-<seatRef>`: no tools at all (sealed ballot).
 *
 * Any other label belongs to a child this plugin did not start, so it is left
 * alone. An unreadable label fails closed: the guard must never fall back to the
 * caller's tool set.
 */

const LABEL = /^magi-(brief|discussion|ballot)-[A-Z]+$/;
const READ_TOOLS = Object.freeze(['read', 'grep', 'glob', 'lsp', 'structured_output']);

/** Wire tool names one stage may call, or undefined for a child outside MAGI.
 * @param {unknown} label - Durable subagent descriptor label.
 * @param {{ allowScripts?: boolean, platform?: string }} [options]
 * @returns {string[] | undefined}
 */
export function reviewerAllowList(label, { allowScripts = true, platform = process.platform } = {}) {
  if (typeof label !== 'string') return undefined;
  const match = LABEL.exec(label);
  if (!match) return undefined;
  if (match[1] === 'ballot') return [];
  return match[1] === 'discussion' && allowScripts
    ? [...READ_TOOLS, platform === 'win32' ? 'pwsh' : 'bash']
    : [...READ_TOOLS];
}

/**
 * Install the deny-by-default guard on one reviewer child context.
 * @param {object} ctx - Agent-scoped Cordis context with the tools service.
 * @param {() => string | undefined} labelOf - Lazy descriptor-label reader; called
 *   once per dispatch until it resolves.
 * @param {{ allowScripts?: boolean, platform?: string }} [options]
 * @returns {() => void} The guard's effect disposer.
 */
export function applyReviewerGuard(ctx, labelOf, options = {}) {
  if (typeof labelOf !== 'function') throw new Error('magi reviewer guard requires a descriptor label reader');
  return ctx.effect(() => ctx.tools.guard(exec => {
    const label = labelOf();
    if (label === undefined) return 'Tools are unavailable: the reviewer stage is not bound yet';
    const allow = reviewerAllowList(label, options);
    if (allow === undefined) return undefined;
    const name = exec && typeof exec.name === 'string' ? exec.name : '';
    return allow.includes(name) ? undefined
      : label.startsWith('magi-ballot-') ? 'Tools are unavailable during sealed balloting'
      : `tool "${name}" is not available to a MAGI reviewer seat`;
  }));
}

export const inject = ['tools'];
