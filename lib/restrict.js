/**
 * MAGI reviewer tool guard.
 *
 * Use only in an agent-scoped (preset) context. It is a deny-by-default guard:
 * every tool call from the reviewed child is rejected unless its wire name is in
 * `allow`. This runs after the `tools/pre-execute` waterfall and before dispatch,
 * so it needs no knowledge of the inherited tool set and stays correct when the
 * host composition adds tools later.
 *
 * Why not `ctx.tools.restrict(...)`? `restrict` validates every named tool against
 * the agent's *inherited* restrictable names, while the reviewer preset's own tool
 * rows are scoped registrations. Mixed allow/deny masks therefore either throw on
 * unknown names or leave host-level tools reachable. The guard API denies by name
 * at execution time and is the hard boundary used here.
 *
 * @param {object} ctx - Agent-scoped Cordis context with the tools service.
 * @param {{ allow?: string[] }} [config] - Wire tool names this seat may call.
 */
export function apply(ctx, config = {}) {
  const allow = new Set(Array.isArray(config.allow) ? config.allow : []);
  if (allow.size === 0) throw new Error('magi reviewer guard requires a non-empty allow list');
  ctx.effect(
    () => ctx.tools.guard((exec) => {
      const name = exec && typeof exec.name === 'string' ? exec.name : '';
      return allow.has(name) ? undefined : `tool "${name}" is not available to a MAGI reviewer seat`;
    }),
    'magi-reviewer-tool-guard',
  );
}

export const inject = ['tools'];
