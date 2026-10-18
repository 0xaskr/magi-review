import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { createStore, storeRoot } from '../../lib/host/store.js';
import { temporary } from './helpers.js';

const report = (id = 'review-1', createdAt = '2026-10-18T12:00:00Z') => ({ schemaVersion: '1.1', sessionId: 's', createdAt,
  digest: { reportId: id, verdict: 'approve', status: 'completed', target: { kind: 'patch' } } });

test('storage roots honor DSH home and profile isolation', () => {
  assert.equal(storeRoot({ DSH_HOME: '/custom', DSH_PROFILE: 'dev' }), path.join('/custom', 'storages', 'magi-review', 'dev'));
  assert.equal(storeRoot({}), path.join(os.homedir(), '.dsh', 'storages', 'magi-review', 'default'));
});

test('save/get/list/rebuild preserve immutable reports and recover missing or broken indexes', async t => {
  const root = await temporary(t), store = createStore({ root });
  const saved = await store.saveReview(report());
  assert.equal(saved.ok, true);
  assert.equal(saved.path, path.join(root, 'reviews', 'review-1.json'));
  assert.deepEqual((await store.getReview('review-1')).result, report());
  const original = await readFile(saved.path, 'utf8');
  const duplicate = report(); duplicate.digest.verdict = 'request_changes';
  assert.equal((await store.saveReview(duplicate)).code, 'REVIEW_EXISTS');
  assert.equal(await readFile(saved.path, 'utf8'), original);
  assert.equal((await store.saveReview(report('review-2', '2026-10-19T00:00:00Z'))).ok, true);
  assert.deepEqual((await store.listReviews(1)).items.map(i => i.reportId), ['review-2']);
  assert.deepEqual((await store.listReviews()).items[1], { reportId: 'review-1', verdict: 'approve', status: 'completed',
    createdAt: '2026-10-18T12:00:00Z', sessionId: 's', targetKind: 'patch' });
  await unlink(path.join(root, 'reviewIndex.json'));
  assert.equal((await store.listReviews()).items.length, 2);
  await writeFile(path.join(root, 'reviewIndex.json'), 'broken', 'utf8');
  assert.equal((await store.listReviews()).items.length, 2);
  await writeFile(path.join(root, 'reviews', 'corrupt.json'), 'broken', 'utf8');
  const rebuilt = await store.rebuildIndex();
  assert.equal(rebuilt.items.length, 2);
  assert.equal(rebuilt.warnings.length, 1);
  assert.ok((await readdir(path.join(root, 'reviews'))).every(f => !f.startsWith('.tmp-')));
  assert.equal((await store.getReview('missing')).ok, false);
});

test('schema, required verdict, file identity and path validation fail structurally', async t => {
  const root = await temporary(t), store = createStore({ root });
  assert.equal((await store.saveReview({ ...report(), schemaVersion: '1.0' })).code, 'SCHEMA_VERSION_UNSUPPORTED');
  assert.equal((await store.saveReview({ schemaVersion: '1.1', digest: { reportId: 'x' } })).code, 'INVALID_REVIEW');
  for (const id of ['../escape', 'a/b', 'CON', '..', 'trailing.']) assert.equal((await store.saveReview(report(id))).code, 'INVALID_REPORT_ID');
  assert.equal((await store.getReview('../escape')).code, 'INVALID_REPORT_ID');
  await store.saveReview(report());
  await writeFile(path.join(root, 'reviews', 'review-1.json'), JSON.stringify({ ...report(), schemaVersion: '2.0' }), 'utf8');
  assert.equal((await store.getReview('review-1')).code, 'SCHEMA_VERSION_UNSUPPORTED');
});

test('shared write queue serializes immutable saves and cache maps across store instances', async t => {
  const root = await temporary(t), a = createStore({ root }), b = createStore({ root });
  const saves = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).saveReview(report('race'))));
  assert.equal(saves.filter(r => r.ok).length, 1);
  assert.equal(saves.filter(r => r.code === 'REVIEW_EXISTS').length, 7);
  const writes = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).putCache(`key${i}`, { reportId: `r${i}` })));
  assert.ok(writes.every(r => r.ok));
  assert.equal(Object.keys(JSON.parse(await readFile(path.join(root, 'reviewCache.json'), 'utf8'))).length, 20);
  assert.deepEqual((await b.getCache('key9')).entry, { reportId: 'r9' });
  const entry = (await a.getCache('key9')).entry; entry.reportId = 'mutated';
  assert.equal((await b.getCache('key9')).entry.reportId, 'r9');
  assert.equal((await a.getCache('unknown')).entry, null);
  assert.equal((await a.putCache('__proto__', { safe: true })).ok, true);
  assert.equal((await b.getCache('__proto__')).entry.safe, true);
  assert.equal({}.safe, undefined);
});

test('cache loads existing maps and handles malformed storage without poisoning the queue', async t => {
  const root = await temporary(t);
  await writeFile(path.join(root, 'reviewCache.json'), JSON.stringify({ old: { reportId: 'prior' } }), 'utf8');
  const store = createStore({ root });
  assert.deepEqual((await store.getCache('old')).entry, { reportId: 'prior' });
  const badRoot = await temporary(t);
  await writeFile(path.join(badRoot, 'reviewCache.json'), 'bad JSON', 'utf8');
  assert.equal((await createStore({ root: badRoot }).getCache('old')).ok, false);
  assert.equal((await store.putCache('next', { reportId: 'ok' })).ok, true);
  const cycle = {}; cycle.self = cycle;
  assert.equal((await store.putCache('cycle', cycle)).ok, false);
  assert.equal((await store.saveReview(cycle)).ok, false);
});

test('valid but incomplete, forged and stale indexes are reconciled against reports on every list', async t => {
  const root = await temporary(t), store = createStore({ root });
  await store.saveReview(report('one')); await store.saveReview(report('two'));
  const index = path.join(root, 'reviewIndex.json');
  const original = JSON.parse(await readFile(index, 'utf8'));
  for (const items of [[], original.slice(0, 1), [{ ...original[0], verdict: 'request_changes' }, { ...original[1], reportId: 'phantom' }]]) {
    await writeFile(index, JSON.stringify(items), 'utf8');
    const listed = await store.listReviews();
    assert.deepEqual(listed.items, original); assert.equal(listed.skipped, 0);
    assert.deepEqual(JSON.parse(await readFile(index, 'utf8')), original);
  }
  await writeFile(path.join(root, 'reviews', 'corrupt.json'), 'broken', 'utf8');
  await writeFile(path.join(root, 'reviews', 'one.json'), 'also broken', 'utf8');
  let listed = await store.listReviews();
  assert.deepEqual(listed.items.map(i => i.reportId), ['two']); assert.equal(listed.skipped, 2); assert.equal(listed.warnings.length, 2);
  await unlink(path.join(root, 'reviews', 'two.json'));
  listed = await store.listReviews(); assert.deepEqual(listed.items, []); assert.equal(listed.skipped, 2);
});

test('independent processes publish a report once without overwriting the winner', { timeout: 20000 }, async t => {
  const root = await temporary(t), first = report('process-race'), second = report('process-race');
  second.digest.verdict = 'request_changes';
  const writers = [first, second].map(value => {
    const child = fork(new URL('../fixtures/store-writer.js', import.meta.url), [root, JSON.stringify(value)], {
      execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const ready = new Promise((resolve, reject) => {
      child.once('message', message => message === 'ready' ? resolve() : reject(Error('Unexpected worker message')));
      child.once('error', reject);
      child.once('exit', code => { if (code !== 0) reject(Error(`Writer exited ${code}: ${stderr}`)); });
    });
    const result = new Promise((resolve, reject) => {
      let saved;
      child.on('message', message => { if (message !== 'ready') saved = message; });
      child.once('error', reject);
      child.once('exit', code => code === 0 && saved ? resolve(saved) : reject(Error(`Writer exited ${code}: ${stderr}`)));
    });
    return { child, ready, result, value };
  });
  const results = Promise.all(writers.map(w => w.result));
  await Promise.all(writers.map(w => w.ready)); writers.forEach(w => w.child.send('save'));
  const saved = await results;
  assert.equal(saved.filter(r => r.ok).length, 1); assert.equal(saved.filter(r => r.code === 'REVIEW_EXISTS').length, 1);
  assert.deepEqual((await createStore({ root }).getReview('process-race')).result, writers[saved.findIndex(r => r.ok)].value);
  assert.deepEqual(await readdir(path.join(root, 'reviews')), ['process-race.json']);
});
