import { sha256Hex } from './json.js';

/** @typedef {{oldStart:number, oldLines:number, newStart:number, newLines:number, lines:string[]}} Hunk */
/** @typedef {{path:string, oldPath?:string, status:'added'|'modified'|'deleted'|'renamed'|'binary', additions:number, deletions:number, hunks:Hunk[], noNewline?:boolean, oldMode?:string, newMode?:string, similarity?:number, binaryPatch?:string[], binaryBefore?:boolean, binaryAfter?:boolean}} File */
/** @typedef {{files:File[], stats:{files:number, additions:number, deletions:number}}} ParsedDiff */

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Git quotes paths using C escapes, including octal UTF-8 bytes.
function decodePath(path) {
  if (!path.startsWith('"')) return path;
  const bytes = [];
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const body = path.slice(1, -1);
  for (let i = 0; i < body.length;) {
    if (body[i] === '\\') {
      const octal = body.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
      if (octal) { bytes.push(parseInt(octal, 8)); i += octal.length + 1; }
      else { bytes.push(escapes[body[i + 1]] ?? body.charCodeAt(i + 1)); i += 2; }
    } else {
      const ch = String.fromCodePoint(body.codePointAt(i));
      bytes.push(...new TextEncoder().encode(ch)); i += ch.length;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function headerPath(value) {
  const token = value.startsWith('"') ? value.match(/^"(?:\\.|[^"\\])*"/)?.[0] : value.split('\t')[0];
  const path = decodePath(token ?? value);
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
}

function gitPaths(line) {
  const rest = line.slice(11);
  const quoted = rest.match(/^("(?:\\.|[^"\\])*") ("(?:\\.|[^"\\])*"|b\/.*)$/);
  if (quoted) return [headerPath(quoted[1]), headerPath(quoted[2])];
  const split = rest.lastIndexOf(' b/');
  if (split >= 0) return [headerPath(rest.slice(0, split)), headerPath(rest.slice(split + 1))];
  const mixed = rest.indexOf(' "b/');
  return mixed < 0 ? ['', ''] : [headerPath(rest.slice(0, mixed)), headerPath(rest.slice(mixed + 1))];
}

/** Parse git/unified patches without treating hunk content as file headers.
 * @param {string} text @returns {ParsedDiff}
 */
export function parseUnifiedDiff(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const files = [];
  let file, hunk, oldLeft = 0, newLeft = 0, binary = false;
  const begin = (path, oldPath) => {
    file = { path, status: 'modified', additions: 0, deletions: 0, hunks: [] };
    if (oldPath && oldPath !== path) { file.oldPath = oldPath; file.status = 'renamed'; }
    files.push(file); hunk = undefined; binary = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const [oldPath, path] = gitPaths(line); begin(path, oldPath); continue;
    }
    if (file && line === '\\ No newline at end of file') {
      file.noNewline = true; hunk?.lines.push(line); continue;
    }
    if (hunk && (oldLeft > 0 || newLeft > 0) && /^[ +\-]/.test(line)) {
      hunk.lines.push(line);
      if (line[0] !== '+') oldLeft--;
      if (line[0] !== '-') newLeft--;
      if (line[0] === '+') file.additions++;
      if (line[0] === '-') file.deletions++;
      continue;
    }
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const oldPath = headerPath(line.slice(4)), path = headerPath(lines[++i].slice(4));
      if (!file || file.hunks.length) begin(path ?? oldPath, oldPath);
      file.path = path ?? oldPath;
      if (oldPath === null) file.status = 'added';
      else if (path === null) file.status = 'deleted';
      else if (path !== oldPath) { file.oldPath = oldPath; file.status = 'renamed'; }
      continue;
    }
    if (!file) continue;
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (match) {
      hunk = { oldStart: +match[1], oldLines: +(match[2] ?? 1), newStart: +match[3], newLines: +(match[4] ?? 1), lines: [] };
      file.hunks.push(hunk); oldLeft = hunk.oldLines; newLeft = hunk.newLines; continue;
    }
    if (line.startsWith('new file mode ')) { file.status = 'added'; file.newMode = line.slice(14); }
    else if (line.startsWith('deleted file mode ')) { file.status = 'deleted'; file.oldMode = line.slice(18); }
    else if (line.startsWith('old mode ')) file.oldMode = line.slice(9);
    else if (line.startsWith('new mode ')) file.newMode = line.slice(9);
    else if (line.startsWith('rename from ')) { file.oldPath = decodePath(line.slice(12)); file.status = 'renamed'; }
    else if (line.startsWith('rename to ')) { file.path = decodePath(line.slice(10)); file.status = 'renamed'; }
    else if (line.startsWith('similarity index ')) file.similarity = parseInt(line.slice(17), 10);
    else if (/^Binary files .* differ$/.test(line)) {
      file.status = 'binary';
      if (line.startsWith('Binary files /dev/null and ')) file.binaryBefore = false;
      if (line.endsWith(' and /dev/null differ')) file.binaryAfter = false;
    }
    else if (line === 'GIT binary patch') { file.status = 'binary'; file.binaryPatch = []; binary = true; }
    else if (binary) file.binaryPatch.push(line);
  }
  return { files, stats: { files: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) } };
}

/** Normalize transport line endings and volatile index metadata, preserving order.
 * @param {string} text @returns {string}
 */
export function canonicalizeDiff(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(line => !/^index [0-9a-f]+\.\.[0-9a-f]+(?: \d+)?$/i.test(line));
  while (lines.at(-1) === '') lines.pop();
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** @param {string} text @returns {string} */
export function hashDiff(text) { return sha256Hex(canonicalizeDiff(text)); }

/** Match exact old or new paths; an empty selection selects no files.
 * @param {ParsedDiff|File[]} parsed @param {string[]} paths @returns {File[]}
 */
export function sliceDiffToPaths(parsed, paths) {
  const wanted = new Set(paths);
  return structuredClone((Array.isArray(parsed) ? parsed : parsed.files).filter(f => wanted.has(f.path) || wanted.has(f.oldPath)));
}

function quotePath(path) { return /[\s"\\]/.test(path) ? JSON.stringify(path) : path; }

/** Render parsed files or host-supplied turn hunks as canonical unified text.
 * Optional mode/similarity/binaryPatch fields retain git metadata.
 * @param {ParsedDiff|File[]} parsed @returns {string}
 */
export function renderPatch(parsed) {
  const lines = [];
  for (const file of Array.isArray(parsed) ? parsed : parsed.files) {
    const old = file.oldPath ?? file.path;
    const a = quotePath('a/' + old), b = quotePath('b/' + file.path);
    lines.push(`diff --git ${a} ${b}`);
    if (file.status === 'added' || (file.status === 'binary' && file.newMode && !file.oldMode)) lines.push(`new file mode ${file.newMode ?? '100644'}`);
    else if (file.status === 'deleted' || (file.status === 'binary' && file.oldMode && !file.newMode)) lines.push(`deleted file mode ${file.oldMode ?? '100644'}`);
    else if (file.oldMode && file.newMode && file.oldMode !== file.newMode) lines.push(`old mode ${file.oldMode}`, `new mode ${file.newMode}`);
    if (file.oldPath && compare(file.oldPath, file.path)) {
      if (file.similarity !== undefined) lines.push(`similarity index ${file.similarity}%`);
      lines.push(`rename from ${quotePath(old)}`, `rename to ${quotePath(file.path)}`);
    }
    if (file.status === 'binary') {
      if (file.binaryPatch) lines.push('GIT binary patch', ...file.binaryPatch);
      else lines.push(`Binary files ${file.binaryBefore === false ? '/dev/null' : a} and ${file.binaryAfter === false ? '/dev/null' : b} differ`);
      continue;
    }
    if (!file.hunks.length) continue;
    lines.push(`--- ${file.status === 'added' ? '/dev/null' : a}`, `+++ ${file.status === 'deleted' ? '/dev/null' : b}`);
    for (const hunk of file.hunks) {
      lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines);
    }
    if (file.noNewline && !file.hunks.some(h => h.lines.includes('\\ No newline at end of file'))) lines.push('\\ No newline at end of file');
  }
  return canonicalizeDiff(lines.join('\n'));
}
