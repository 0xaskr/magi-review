import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalizeDiff, hashDiff, parseUnifiedDiff, renderPatch, sliceDiffToPaths } from '../core/canonical-diff.js';
import { sha256Hex } from '../core/json.js';
import { toReviewError } from './errors.js';

const execFileAsync = promisify(execFile);

export async function runGit(cwd, args, { signal, timeoutMs = 30000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, signal, timeout: timeoutMs, maxBuffer, encoding: 'utf8',
      windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? (error.signal ? 128 : 1), stdout: String(error.stdout ?? ''), stderr: String(error.stderr || error.message) };
  }
}

export async function detectRepo(cwd, opts) {
  const root = await runGit(cwd, ['rev-parse', '--show-toplevel'], opts);
  if (root.code !== 0 || !root.stdout.trim()) return null;
  const head = await runGit(cwd, ['rev-parse', '--verify', 'HEAD'], opts);
  return { root: path.resolve(root.stdout.trim()), ...(head.code === 0 ? { headOid: head.stdout.trim() } : {}) };
}

async function requiredGit(cwd, args, signal) {
  const result = await runGit(cwd, args, { signal });
  if (result.code !== 0) throw Object.assign(new Error(result.stderr), { code: signal?.aborted ? 'SNAPSHOT_ABORTED' : 'GIT_ERROR' });
  return result.stdout;
}

const names = output => output.split('\0').filter(Boolean);
const statsOf = files => ({ files: files.length, additions: files.reduce((sum, f) => sum + f.additions, 0), deletions: files.reduce((sum, f) => sum + f.deletions, 0) });

/** Read links as links rather than following a repository path outside its root. */
async function readWorktreeFile(root, name, signal) {
  const filename = path.resolve(root, name);
  const relative = path.relative(root, filename);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Path escapes repository');
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(path.dirname(filename))]);
  const parentRelative = path.relative(realRoot, realParent);
  if (parentRelative === '..' || parentRelative.startsWith('..' + path.sep) || path.isAbsolute(parentRelative)) {
    throw new Error('Ancestor path escapes repository');
  }
  const info = await lstat(filename);
  const bytes = info.isSymbolicLink() ? Buffer.from(await readlink(filename), 'utf8') : await readFile(filename, { signal });
  let text, binary = bytes.includes(0);
  if (!binary) { try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { binary = true; } }
  return { bytes, text, binary, mode: info.isSymbolicLink() ? '120000' : info.mode & 0o111 ? '100755' : '100644' };
}

function newFile(name, content) {
  const file = { path: name, status: content.binary ? 'binary' : 'added', additions: 0, deletions: 0, hunks: [], newMode: content.mode };
  if (content.binary) return { ...file, binaryBefore: false };
  const text = content.text.replace(/\r\n?/g, '\n');
  const lines = text === '' ? [] : text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  file.additions = lines.length;
  if (lines.length) {
    file.hunks.push({ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map(line => '+' + line) });
    if (!text.endsWith('\n')) file.hunks[0].lines.push('\\ No newline at end of file');
  }
  return file;
}

function finishSnapshot(snapshot, files, patch, paths, total = files.length) {
  const selected = paths === undefined ? files : sliceDiffToPaths(files, paths);
  const canonicalPatch = paths === undefined ? canonicalizeDiff(patch) : renderPatch(selected);
  const reviewedFiles = selected.filter(f => !f.oversized && !f.unavailable).length;
  const sortedEntries = Object.entries(snapshot.untrackedDigests ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const patchHash = snapshot.kind === 'working-tree'
    ? sha256Hex(canonicalPatch + '\0' + JSON.stringify(sortedEntries)) : hashDiff(canonicalPatch);
  return { ...snapshot, ...(snapshot.kind === 'working-tree' ? { untrackedDigests: Object.fromEntries(sortedEntries) } : {}), canonicalPatch, patchHash,
    files: selected.map(({ hunks, binaryPatch, ...file }) => ({ ...file, ...(file.status === 'binary' ? { binary: true } : {}) })),
    stats: statsOf(selected),
    coverage: { totalFiles: total, reviewedFiles, partial: reviewedFiles < total, ...(paths !== undefined ? { paths: [...paths] } : {}) },
    empty: files.length === 0 && canonicalPatch.trim() === '' || selected.length === 0 && paths !== undefined };
}

async function turnSnapshot({ cwd, paths, signal, workspaceChanges, sessionId, changesSeq }) {
  const unavailable = { kind: 'turn', empty: true, degradeReason: 'turn_unavailable' };
  if (!workspaceChanges || changesSeq === undefined || changesSeq === null) return unavailable;
  let summary;
  try { summary = await workspaceChanges.summary(sessionId, changesSeq); } catch { return unavailable; }
  if (!summary || !Array.isArray(summary.files)) return unavailable;
  const files = [], degradedReasons = [];
  const diffSignal = signal ?? new AbortController().signal;
  for (let i = 0; i < summary.files.length; i++) {
    if (signal?.aborted) throw Object.assign(new Error('Snapshot aborted'), { code: 'SNAPSHOT_ABORTED' });
    const entry = summary.files[i];
    let diff;
    try { diff = await workspaceChanges.diff(sessionId, changesSeq, i, diffSignal); } catch { /* retain missing coverage */ }
    const text = diff?.text ?? (diff?.kind === 'text' ? diff : undefined);
    const file = { path: String(diff?.path ?? entry.path).replace(/\\/g, '/'), status: 'modified', additions: 0, deletions: 0, hunks: [] };
    if (entry.oldPath) { file.oldPath = entry.oldPath.replace(/\\/g, '/'); file.status = 'renamed'; }
    if (text && Array.isArray(text.hunks)) {
      file.status = text.before === false ? 'added' : text.after === false ? 'deleted' : file.status;
      file.hunks = structuredClone(text.hunks);
      for (const hunk of file.hunks) for (const line of hunk.lines) {
        if (line.startsWith('+')) file.additions++;
        else if (line.startsWith('-')) file.deletions++;
      }
      if (text.coarse) file.coarse = true;
    } else if (diff?.kind === 'binary' || diff?.binary || entry.binary) {
      file.status = 'binary';
      file.binaryBefore = diff?.before;
      file.binaryAfter = diff?.after;
    } else {
      if (diff?.kind === 'oversized' || diff?.oversized || entry.oversized) file.oversized = true;
      else file.unavailable = true;
      degradedReasons.push(file.oversized ? 'turn_file_oversized' : 'turn_diff_unavailable');
    }
    files.push(file);
  }
  const total = Math.max(summary.total ?? files.length, files.length);
  if (total > files.length) degradedReasons.push('turn_summary_partial');
  const result = finishSnapshot({ kind: 'turn', cwd: cwd ?? summary.cwd, turn: summary.turn, untracked: [], dirty: files.length > 0,
    ...(degradedReasons.length ? { degradedReasons: [...new Set(degradedReasons)] } : {}) }, files, renderPatch(files), paths, total);
  if (total > 0 && files.length === 0 && paths === undefined) result.empty = false;
  return result;
}

/** Freeze all target inputs once. Failed git reads are errors, never a clean/no-changes result. */
export async function snapshotReview({ cwd, target = 'working-tree', base, paths, patchText, signal, workspaceChanges, sessionId, changesSeq }) {
  const kind = typeof target === 'object' ? target.kind : target;
  const initial = { kind, cwd, untracked: [], dirty: false };
  try {
    if (paths !== undefined && (!Array.isArray(paths) || paths.some(p => typeof p !== 'string'))) throw new Error('paths must be an array of strings');
    if (kind === 'turn') return await turnSnapshot({ cwd, paths, signal, workspaceChanges, sessionId, changesSeq });
    if (kind === 'patch') {
      if (typeof patchText !== 'string') throw new Error('patchText must be a string');
      return finishSnapshot({ ...initial, dirty: Boolean(patchText.trim()) }, parseUnifiedDiff(patchText).files, patchText, paths);
    }
    if (!['working-tree', 'staged', 'base-ref'].includes(kind)) throw new Error(`Unsupported target: ${kind}`);
    const repo = await detectRepo(cwd, { signal });
    if (!repo) throw Object.assign(new Error('No readable Git repository'), { code: 'REPO_UNAVAILABLE' });
    const root = repo.root, snapshot = { ...initial, repoRoot: root, ...(repo.headOid ? { headOid: repo.headOid, baseOid: repo.headOid } : { degradedReasons: ['unborn_head'] }) };
    const status = await requiredGit(root, ['status', '--porcelain=v1', '-z'], signal);
    snapshot.dirty = status.length > 0;
    let revision = repo.headOid;
    if (kind === 'base-ref') {
      if (typeof base !== 'string' || !base.trim()) throw new Error('base-ref requires base');
      revision = (await requiredGit(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], signal)).trim();
      snapshot.baseOid = revision;
    }
    const args = ['diff', ...(kind === 'staged' ? ['--cached'] : []), '--no-color', '--no-ext-diff', '--no-textconv', '--binary', ...(revision ? [revision] : []), '--'];
    let patch = await requiredGit(root, args, signal);
    let files = parseUnifiedDiff(patch).files;
    if (kind === 'working-tree') {
      const untracked = names(await requiredGit(root, ['ls-files', '--others', '--exclude-standard', '-z'], signal));
      // With no HEAD, staged additions also belong to the working tree. Compare
      // their current bytes with absence so staged+unstaged edits are not doubled.
      const tracked = !repo.headOid ? names(await requiredGit(root, ['ls-files', '-z'], signal)) : [];
      if (!repo.headOid) { files = []; patch = ''; }
      const added = [];
      const untrackedDigests = new Map();
      for (const name of new Set([...tracked, ...untracked])) {
        let content;
        try { content = await readWorktreeFile(root, name, signal); }
        catch (error) {
          if (signal?.aborted) throw error;
          if (error.code === 'ENOENT' && tracked.includes(name)) continue;
          added.push({ path: name, status: 'added', additions: 0, deletions: 0, hunks: [], unavailable: true });
          if (untracked.includes(name)) snapshot.untracked.push({ path: name, unavailable: true });
          snapshot.degradedReasons = [...new Set([...(snapshot.degradedReasons ?? []), 'worktree_file_unavailable'])];
          continue;
        }
        added.push(newFile(name, content));
        if (untracked.includes(name)) {
          snapshot.untracked.push({ path: name, size: content.bytes.length, binary: content.binary });
          untrackedDigests.set(name, sha256Hex(content.bytes));
        }
      }
      snapshot.untrackedDigests = Object.fromEntries(untrackedDigests);
      files.push(...added);
      patch += renderPatch(added);
    }
    return finishSnapshot(snapshot, files, patch, paths);
  } catch (error) {
    return { ...initial, empty: false, canonicalPatch: '', patchHash: hashDiff(''), files: [], stats: statsOf([]),
      coverage: { totalFiles: 0, reviewedFiles: 0, partial: true },
      error: toReviewError(error, { stage: 'input', code: signal?.aborted ? 'SNAPSHOT_ABORTED' : error.code ?? 'SNAPSHOT_ERROR' }) };
  }
}

/** Fingerprint status plus tracked diff, and content of already-untracked files.
 * The latter catches edits whose porcelain status remains the same '??' entry.
 */
export async function statusFingerprint(cwd, { signal } = {}) {
  const status = await runGit(cwd, ['status', '--porcelain=v1', '-z'], { signal });
  const statusHash = sha256Hex(status.stdout);
  const repo = await detectRepo(cwd, { signal });
  if (!repo || status.code !== 0) return { statusHash, diffHash: sha256Hex(''), combined: sha256Hex(status.stdout), available: false };
  try {
    const diff = await requiredGit(repo.root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--binary', ...(repo.headOid ? [repo.headOid] : []), '--'], signal);
    const diffHash = sha256Hex(diff);
    const untracked = names(await requiredGit(repo.root, ['ls-files', '--others', '--exclude-standard', '-z'], signal));
    const tracked = !repo.headOid ? names(await requiredGit(repo.root, ['ls-files', '-z'], signal)) : [];
    const contents = [];
    for (const name of [...new Set([...tracked, ...untracked])].sort()) {
      try {
        const content = await readWorktreeFile(repo.root, name, signal);
        contents.push([name, hashDiff(content.bytes.toString('base64'))]);
      } catch (error) { if (error.code !== 'ENOENT') throw error; contents.push([name, null]); }
    }
    return { statusHash, diffHash, combined: sha256Hex(JSON.stringify([statusHash, diffHash, contents])), available: true };
  } catch { return { statusHash, diffHash: sha256Hex(''), combined: sha256Hex(status.stdout), available: false }; }
}

export function listChangedPaths(snapshot) { return [...new Set((snapshot?.files ?? []).map(f => f.path))]; }
