import { mkdir, readFile, readdir, rename, unlink, writeFile, link } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { toReviewError } from './errors.js';

let writeChain = Promise.resolve();
const caches = new Map();
const failure = (error, code = error?.code ?? 'STORE_ERROR') => ({ ok: false, code, error: toReviewError(error, { stage: 'reporter', code }) });
function queue(operation) {
  const result = writeChain.then(operation).catch(error => failure(error));
  writeChain = result.then(() => undefined, () => undefined);
  return result;
}
function safeName(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
    && !value.endsWith('.') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
function assertReview(result) {
  if (result?.schemaVersion !== '1.1') throw Object.assign(new Error('Expected schemaVersion 1.1'), { code: 'SCHEMA_VERSION_UNSUPPORTED' });
  if (!safeName(result?.digest?.reportId)) throw Object.assign(new Error('Invalid reportId'), { code: 'INVALID_REPORT_ID' });
  if (!['approve', 'request_changes', 'insufficient', 'none'].includes(result.digest.verdict)) throw Object.assign(new Error('Missing or invalid digest.verdict'), { code: 'INVALID_REVIEW' });
}

export function storeRoot(env = process.env) {
  return path.join(env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'storages', 'magi-review', env.DSH_PROFILE || 'default');
}

async function atomicWrite(filename, value, { immutable = false } = {}) {
  const data = JSON.stringify(value, null, 2) + '\n';
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = path.join(path.dirname(filename), `.tmp-${randomUUID()}`);
  try {
    await writeFile(temporary, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    // A hard link publishes complete bytes atomically and cannot replace a report,
    // even when another process has already published the same reportId.
    if (immutable) await link(temporary, filename);
    else await rename(temporary, filename);
  } finally { await unlink(temporary).catch(() => {}); }
}
async function readJson(filename) { return JSON.parse(await readFile(filename, 'utf8')); }
function indexItem(result) {
  const { digest } = result;
  const sessionId = result.sessionId ?? result.metadata?.sessionId;
  return { reportId: digest.reportId, verdict: digest.verdict, status: digest.status ?? result.status,
    createdAt: result.createdAt ?? result.metadata?.startedAt ?? result.metadata?.finishedAt ?? null,
    ...(sessionId !== undefined ? { sessionId } : {}), targetKind: digest.target?.kind ?? result.target?.kind ?? result.scope?.target?.kind };
}

/** root is the profile storage namespace: reviews/, reviewCache.json, reviewIndex.json.
 * No filesystem I/O happens until a returned method is called. Writes and reads
 * share a process-wide queue; cache state is shared across stores with one root.
 */
export function createStore({ root = storeRoot() } = {}) {
  const directory = path.resolve(root);
  const reviews = path.join(directory, 'reviews');
  const index = path.join(directory, 'reviewIndex.json');
  const cacheFile = path.join(directory, 'reviewCache.json');
  const reviewPath = reportId => {
    if (!safeName(reportId)) throw Object.assign(new Error('Invalid reportId'), { code: 'INVALID_REPORT_ID' });
    return path.join(reviews, reportId + '.json');
  };
  async function scan() {
    let entries;
    try { entries = await readdir(reviews, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return { items: [], warnings: [], skipped: 0 }; throw error; }
    const items = [], warnings = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const result = await readJson(path.join(reviews, entry.name));
        assertReview(result);
        if (entry.name !== `${result.digest.reportId}.json`) throw new Error('Report identity mismatch');
        items.push(indexItem(result));
      } catch (error) { warnings.push({ file: entry.name, error: toReviewError(error, { stage: 'reporter', code: 'INVALID_REVIEW' }) }); }
    }
    items.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || a.reportId.localeCompare(b.reportId));
    return { items, warnings, skipped: warnings.length };
  }
  async function rebuild() {
    const result = await scan();
    await atomicWrite(index, result.items);
    return { ok: true, ...result };
  }
  async function cache() {
    if (caches.has(directory)) return caches.get(directory);
    let value;
    try { value = await readJson(cacheFile); }
    catch (error) { if (error.code !== 'ENOENT') throw error; value = {}; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cache map');
    const state = Object.assign(Object.create(null), value);
    caches.set(directory, state);
    return state;
  }
  return {
    saveReview(result) {
      let snapshot;
      try { snapshot = JSON.parse(JSON.stringify(result)); assertReview(snapshot); }
      catch (error) { return Promise.resolve(failure(error)); }
      return queue(async () => {
        const reportId = snapshot.digest.reportId, filename = reviewPath(reportId);
        try { await atomicWrite(filename, snapshot, { immutable: true }); }
        catch (error) { if (error.code === 'EEXIST') return failure('Report already exists', 'REVIEW_EXISTS'); throw error; }
        const saved = { ok: true, path: filename, reportId };
        try { await rebuild(); } catch (error) { saved.warnings = [toReviewError(error, { stage: 'reporter', code: 'INDEX_WRITE_FAILED' })]; }
        return saved;
      });
    },
    getReview(reportId) {
      return queue(async () => {
        const result = await readJson(reviewPath(reportId));
        assertReview(result);
        if (result.digest.reportId !== reportId) throw new Error('Report identity mismatch');
        return { ok: true, result };
      });
    },
    listReviews(limit = 20) {
      return queue(async () => {
        // Reports are authoritative: even a valid JSON index can be incomplete
        // after a crash or another process publishing a report.
        const { items, warnings, skipped } = await scan();
        let indexed;
        try { indexed = await readJson(index); } catch { /* missing/corrupt index */ }
        if (JSON.stringify(indexed) !== JSON.stringify(items)) await atomicWrite(index, items);
        return { ok: true, items: items.slice(0, Number.isInteger(limit) && limit >= 0 ? limit : 20), skipped, ...(warnings.length ? { warnings } : {}) };
      });
    },
    rebuildIndex() { return queue(rebuild); },
    getCache(key) {
      return queue(async () => {
        const state = await cache();
        return { ok: true, entry: Object.hasOwn(state, key) ? structuredClone(state[key]) : null };
      });
    },
    putCache(key, entry) {
      let snapshot;
      try {
        if (typeof key !== 'string' || !key) throw new Error('Cache key must be a nonempty string');
        snapshot = JSON.parse(JSON.stringify(entry));
      } catch (error) { return Promise.resolve(failure(error, 'INVALID_CACHE_ENTRY')); }
      return queue(async () => {
        const current = await cache();
        const next = Object.assign(Object.create(null), current, { [key]: snapshot });
        await atomicWrite(cacheFile, next);
        caches.set(directory, next);
        return { ok: true };
      });
    },
  };
}
