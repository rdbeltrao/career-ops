import test from 'node:test';
import assert from 'node:assert/strict';
import workday from '../../providers/workday.mjs';

const entry = { name: 'Acme', careers_url: 'https://acme.wd5.myworkdayjobs.com/careers' };
const rows = (tag, count, dated = true) => Array.from({ length: count }, (_, i) => ({
  title: `Engineer ${tag} ${i}`, externalPath: `/job/Berlin/${tag}_R${i}`,
  ...(dated ? { postedOn: 'Posted Today' } : {}),
}));
const facet = (parameter, values) => ({ facetParameter: parameter,
  values: values.map(([id, count]) => ({ id, count })) });
const context = fetchJson => ({ fetchJson, sleep: async () => {}, syntheticEntries: true,
  includeUndated: true, titleWanted: () => false });

for (const missingAtFront of [true, false]) {
  test(`scoped counts recover a child partition; unclassified rows ${missingAtFront ? 'verified' : 'remain pending'}`, async () => {
    const missing = rows('missing', 3), a = rows('a', 1100), b = rows('b', 1100), c = rows('c', 200);
    const child = missingAtFront ? [...missing, ...a, ...b] : [...a, ...b, ...missing];
    const all = [...child, ...c];
    let broadChildRequests = 0;
    const jobs = await workday.fetch(entry, context(async (_url, opts) => {
      const { appliedFacets: f, offset } = JSON.parse(opts.body);
      if (!f.division) return { total: 2000, facets: [facet('division', [['large', 2203], ['small', 200]])], jobPostings: all.slice(offset, offset + 20) };
      if (f.division[0] === 'small') return { total: 200, jobPostings: c.slice(offset, offset + 20) };
      if (!f.team) {
        broadChildRequests++;
        return { total: 2000, facets: [facet('division', [['large', 2203], ['small', 200]]), facet('team', [['a', 1100], ['b', 1100]])], jobPostings: child.slice(offset, offset + 20) };
      }
      const page = f.team[0] === 'a' ? a : b;
      return { total: page.length, jobPostings: page.slice(offset, offset + 20) };
    }));
    assert.equal(broadChildRequests, 1, 'clamped children must not download the parent floor again');
    assert.equal(jobs.length, missingAtFront ? 2403 : 2400);
    assert.equal(jobs.workdayTruncated, missingAtFront ? undefined : 'structural', 'a count gap must never be presented as complete');
  });
}

test('full retrieval can descend four levels despite broader counts on selected facets', async () => {
  const all = rows('deep', 2400);
  let deepest = 0;
  const jobs = await workday.fetch(entry, context(async (_url, opts) => {
    const { appliedFacets: f, offset } = JSON.parse(opts.body);
    const depth = Object.keys(f).length;
    deepest = Math.max(deepest, depth);
    let page = all;
    let facets = [];
    for (let i = 0; i < depth; i++) {
      const bounds = [[2200, 200], [2100, 100], [2050, 50], [1025, 1025]][i];
      facets.push(facet(`f${i}`, [['x', bounds[0]], ['y', bounds[1]]]));
      page = f[`f${i}`][0] === 'x' ? page.slice(0, bounds[0]) : page.slice(bounds[0]);
    }
    if (page.length > 2000) {
      const bounds = [[2200, 200], [2100, 100], [2050, 50], [1025, 1025]][depth];
      facets.push(facet(`f${depth}`, [['x', bounds[0]], ['y', bounds[1]]]));
    }
    return { total: Math.min(page.length, 2000), facets, jobPostings: page.slice(offset, offset + 20) };
  }));
  assert.equal(deepest, 4);
  assert.equal(jobs.length, 2400);
  assert.equal(jobs.workdayTruncated, undefined);
});

test('an honest un-clamped total above 2000 is fully paginated', async () => {
  const all = rows('large', 2600);
  const jobs = await workday.fetch(entry, context(async (_url, opts) => {
    const { offset } = JSON.parse(opts.body);
    return { total: all.length, jobPostings: all.slice(offset, offset + 20) };
  }));
  assert.equal(jobs.length, 2600);
  assert.equal(jobs.workdayTruncated, undefined);
});

test('an explicit page limit stays visibly incomplete when postings remain', async () => {
  const all = rows('limited', 60);
  const jobs = await workday.fetch({ ...entry, max_pages: 2 }, context(async (_url, opts) => {
    const { offset } = JSON.parse(opts.body);
    return { total: all.length, jobPostings: all.slice(offset, offset + 20) };
  }));
  assert.equal(jobs.length, 40);
  assert.equal(jobs.workdayTruncated, 'structural');
});

for (const repeatsPastEnd of [false, true]) {
  test(`a facetless total of exactly 2000 ${repeatsPastEnd ? 'keeps an unresolved native cap visible' : 'is verified by an empty next page'}`, async () => {
    const all = rows('exact', 2000);
    let requests = 0;
    const jobs = await workday.fetch(entry, context(async (_url, opts) => {
      requests++;
      const { offset } = JSON.parse(opts.body);
      return { total: 2000, jobPostings: repeatsPastEnd && offset >= 2000 ? all.slice(0, 20) : all.slice(offset, offset + 20) };
    }));
    assert.equal(requests, 101);
    assert.equal(jobs.length, 2000);
    assert.equal(jobs.workdayTruncated, repeatsPastEnd ? 'structural' : undefined);
  });
}

test('undated pagination retains the other successful page when a parallel neighbour fails', async () => {
  const all = rows('parallel', 60, false);
  let active = 0, peak = 0;
  const jobs = await workday.fetch(entry, context(async (_url, opts) => {
    const { offset } = JSON.parse(opts.body);
    active++; peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 3));
      if (offset === 20) throw Object.assign(new Error('HTTP 403'), { status: 403 });
      return { total: all.length, jobPostings: all.slice(offset, offset + 20) };
    } finally { active--; }
  }));
  assert.equal(peak, 2);
  assert.equal(jobs.length, 40);
  assert.equal(jobs.workdayTruncated, 'transient');
});
