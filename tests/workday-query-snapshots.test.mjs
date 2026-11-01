import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkdayQuerySnapshots } from '../lib/workday-query-snapshots.mjs';
import workday from '../providers/workday.mjs';

const board = 'https://acme.wd5.myworkdayjobs.com/careers';
const result = (stopReason = 'complete') => ({ jobs: [{ title: 'Engineer', url: `${board}/job/Berlin/Role_R1`, postedAt: 1234 },
  { title: 'Undated', url: `${board}/job/Berlin/Role_R2` }], total: 2, facets: [], clamped: false, stopReason });
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'workday-snapshots-'));

test('snapshots survive reopening without inventing or moving posting dates; policy, age and date windows are enforced', () => {
  const root = fixture(); let now = Date.now();
  try {
    const open = namespace => createWorkdayQuerySnapshots(root, namespace, { now: () => now, maxAgeMs: 1000 });
    open('cycle-a').board(board).set('all', result(), 100, false);
    const reopened = open('cycle-a');
    const saved = reopened.board(board).get('all', 200);
    assert.equal(saved.result.jobs[0].postedAt, 1234);
    assert.equal(saved.result.jobs[1].postedAt, undefined);
    assert.equal(reopened.stats.hits, 1);
    assert.equal(open('different-policy').board(board).get('all', 200), null);
    reopened.board(board).set('window', result('early-stop'), 100, false);
    assert.ok(reopened.board(board).get('window', 200));
    assert.equal(reopened.board(board).get('window', 50), null, 'a wider date window needs a new query');
    assert.equal(reopened.board(board).get('window', 200, true), null, 'date-window results cannot prove full counts');
    now += 1001;
    assert.equal(open('cycle-a').board(board).get('all', 200), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('partial reads, corrupt snapshots and cache I/O errors never stand in for native results', () => {
  const root = fixture();
  try {
    const cache = createWorkdayQuerySnapshots(root, 'cycle');
    const store = cache.board(board);
    for (const reason of ['cap', 'fetch-error']) { store.set(reason, result(reason), 100, false); assert.equal(store.get(reason, 100), null); }
    store.set('all', result(), 100, false);
    const namespace = fs.readdirSync(root)[0], folder = path.join(root, namespace, fs.readdirSync(path.join(root, namespace))[0]);
    fs.writeFileSync(path.join(folder, fs.readdirSync(folder)[0]), '{broken');
    assert.equal(store.get('all', 100), null);
    cache.clearCompleted(() => false);
    assert.equal(fs.existsSync(folder), true);
    cache.clearCompleted(() => true);
    assert.equal(fs.existsSync(folder), false);
    const blocked = path.join(root, 'file'); fs.writeFileSync(blocked, 'blocked');
    let warnings = 0;
    const unavailable = createWorkdayQuerySnapshots(blocked, 'cycle', { onError: () => warnings++ }).board(board);
    assert.doesNotThrow(() => unavailable.set('all', result(), 100, false));
    assert.equal(unavailable.get('all', 100), null);
    assert.equal(warnings, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an interrupted large board resumes completed queries and refetches its interrupted slice', async () => {
  const root = fixture();
  try {
    const all = Array.from({ length: 2400 }, (_, i) => ({ title: 'Engineer', externalPath: `/job/Berlin/Role_R${i}`, postedOn: 'Posted Today' }));
    const controller = new AbortController(), interrupted = new Error('normal board budget reached');
    const cache = createWorkdayQuerySnapshots(root, 'unchanged-coverage-cycle');
    const entry = { name: 'Acme', careers_url: board };
    let firstCalls = 0, resumedCalls = 0;
    const context = (stop, resumed) => ({ syntheticEntries: true, includeUndated: true, signal: stop.signal,
      sleep: async () => {}, titleWanted: () => false, workdayQueryCache: cache.board(board),
      fetchJson: async (_url, opts) => {
        if (resumed) resumedCalls++; else firstCalls++;
        const { appliedFacets, offset } = JSON.parse(opts.body);
        if (!appliedFacets.division) return { total: 2000, facets: [{ facetParameter: 'division', values: [{ id: 'a', count: 1200 }, { id: 'b', count: 1200 }] }], jobPostings: all.slice(offset, offset + 20) };
        if (appliedFacets.division[0] === 'b' && !resumed) { stop.abort(interrupted); throw interrupted; }
        const rows = appliedFacets.division[0] === 'a' ? all.slice(0, 1200) : all.slice(1200);
        return { total: rows.length, jobPostings: rows.slice(offset, offset + 20) };
      } });
    await assert.rejects(workday.fetch(entry, context(controller, false)), error => error === interrupted);
    assert.equal(firstCalls, 161);
    assert.equal(cache.stats.saved, 2, 'only the root and finished first slice are saved');
    const jobs = await workday.fetch(entry, context(new AbortController(), true));
    assert.equal(resumedCalls, 60, 'the successful 160 earlier requests are not repeated');
    assert.equal(jobs.length, 2400);
    assert.equal(new Set(jobs.map(job => job.url)).size, 2400);
    assert.equal(jobs.workdayTruncated, undefined);
    assert.equal(cache.stats.hits, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('completed snapshots do not consume the next pass slice budget or override a probe', async () => {
  const root = fixture();
  try {
    const all = Array.from({ length: 2400 }, (_, i) => ({ title: 'Engineer', externalPath: `/job/Berlin/Role_R${i}`, postedOn: 'Posted Today' }));
    const values = Array.from({ length: 600 }, (_, i) => ({ id: String(i), count: 4 }));
    const cache = createWorkdayQuerySnapshots(root, 'many-slices');
    let requests = 0;
    const ctx = { syntheticEntries: true, includeUndated: true, sleep: async () => {}, titleWanted: () => false,
      workdayQueryCache: cache.board(board), fetchJson: async (_url, opts) => {
        requests++;
        const { appliedFacets, offset } = JSON.parse(opts.body);
        if (!appliedFacets.division) return { total: 2000, facets: [{ facetParameter: 'division', values }], jobPostings: all.slice(offset, offset + 20) };
        const start = Number(appliedFacets.division[0]) * 4;
        return { total: 4, jobPostings: all.slice(start, start + 4) };
      } };
    const entry = { name: 'Acme', careers_url: board };
    await workday.fetch(entry, { ...ctx, maxPages: 1 });
    assert.equal(requests, 1);
    assert.equal(cache.stats.saved, 0, 'probes must not become completed-query snapshots');
    requests = 0;
    const first = await workday.fetch(entry, ctx);
    assert.equal(first.workdayTruncated, 'structural');
    assert.equal(requests, 612, 'first pass uses 100 root pages and its 512 new slices');
    requests = 0;
    const second = await workday.fetch(entry, ctx);
    assert.equal(requests, 88, 'completed query snapshots do not trap the next pass at the same 512-slice boundary');
    assert.equal(second.length, 2400);
    assert.equal(second.workdayTruncated, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
