/** Assess patch features without reading paths. Strong signals score 3, medium
 * signals 2, weak filename hints 1. Only strong signals produce high risk.
 * @param {{files:import('./canonical-diff.js').File[],stats?:{files:number,additions:number,deletions:number}}} input
 * @returns {{level:'low'|'medium'|'high',score:number,signals:{code:string,message:string,paths?:string[]}[]}}
 */
export function assessRisk({ files, stats }) {
  const signals = [];
  let score = 0, strong = false, medium = false;
  const add = (code, message, weight, paths) => {
    signals.push({ code, message, ...(paths?.length ? { paths: [...new Set(paths)].sort() } : {}) });
    score += weight; strong ||= weight === 3; medium ||= weight === 2;
  };
  const sensitive = /(?:^|[\/._-])(?:auth(?:entication|orization)?|oauth|login|credentials?|crypto|migrations?|ci|deploy(?:ment)?|secrets?)(?:$|[\/._-])|(?:^|\/)\.github(?:\/|$)|(?:^|\/)(?:package\.json|[^/]+\.lockb?|(?:package|pnpm)-lock\.(?:json|yaml)|npm-shrinkwrap\.json|lockfile|go\.sum)(?:$)/i;
  const sensitivePaths = files.flatMap(f => [f.path, f.oldPath].filter(p => p && sensitive.test(p.replace(/\\/g, '/'))));
  if (sensitivePaths.length) add('SENSITIVE_PATH', 'Sensitive authentication, deployment, migration or dependency paths changed.', 3, sensitivePaths);
  const binaries = files.filter(f => f.status === 'binary' || f.binary).map(f => f.path);
  if (binaries.length) add('BINARY_FILE', 'Binary changes cannot be reviewed as text.', 3, binaries);
  const additions = stats?.additions ?? files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = stats?.deletions ?? files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  if (deletions > 2 * additions) add('DELETION_DOMINANT', `${deletions} deletions exceed twice ${additions} additions.`, 3);
  if ((stats?.files ?? files.length) > 8) add('MANY_FILES', 'More than eight files changed.', 2);
  if (additions + deletions > 1000) add('LARGE_DIFF', 'More than 1000 changed lines.', 2);
  const exports = files.filter(f => f.hunks?.some(h => h.lines.some(line => /^[+-](?![+-]{2})(?:\s*export\b|\s*(?:module\.exports|exports[.\[])\s*)/.test(line)))).map(f => f.path);
  if (exports.length) add('PUBLIC_API_CHANGE', 'Changed export declarations indicate a public API change.', 2, exports);
  const hints = files.filter(f => /(?:^|\/)(?:index|exports?)(?:\.[^/]+)?$/i.test(f.path.replace(/\\/g, '/')) && !exports.includes(f.path)).map(f => f.path);
  if (hints.length) add('API_FILENAME_HINT', 'An index/export filename changed; no export declaration change was detected.', 1, hints);
  return { level: strong ? 'high' : medium ? 'medium' : 'low', score, signals };
}
