// tests/jev-rank.test.mjs — jev-rank.mjs, the zero-token Jev pass over
// pending pipeline rows.
//
// Review focus 1 of the consolidation plan: a row with no JD anywhere must be
// left un-annotated and counted, never written as `jev: 0`. The scorer and the
// JD fetch are injected, so nothing here reaches the network or needs a key.
//
// Run: node --test tests/jev-rank.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJd } from '../lib/jd-store.mjs';
import { parseDotEnv } from '../lib/openrouter-key.mjs';
import {
  DEFAULT_LIMIT, JEV_LABEL, LIMIT_CEILING, appendJevAnnotation, applyJevAnnotations, countAnnotatedPending,
  jobFromEntry, main, parsePendingJev, selectJevBatch, summaryLine,
} from '../jev-rank.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'jev-rank.mjs');

const ROW_1 = '- [ ] https://x.test/1 | Acme | Backend Lead | Remote | posted: 2026-10-01 | rank: 4.0/5 — strong';
const ROW_2 = '- [ ] https://x.test/2 | Beta | Android Lead';
const ROW_3 = '- [ ] https://x.test/3 | Gamma | Data Lead | jev: 50 maybe — seniority match, location unclear, language none, unclear, stack agnostic';
const ROW_4 = '- [x] https://x.test/4 | Delta | Done Role';
const PIPELINE = ['# Pipeline', '', '## Pending', '', ROW_1, ROW_2, ROW_3, ROW_4, '', '## Processed', ''].join('\n');
const APPLY_SEGMENT = 'jev: 79 apply — seniority match, location yes, language none, product, stack agnostic';

const APPLY = {
  model: 'typesafe/jev-1.13', fit: 79, score: 4.2, verdict: 'apply',
  reasons: { seniority_match: 'match', location_ok: 'yes', language_blocker: 'none', team_type: 'product', stack_fit: 'stack_agnostic' },
  confidences: {}, probabilities: {}, blocking: [], fallback: false, error: null,
};
const NO_FIT = { ...APPLY, fit: null, score: null, verdict: 'maybe' };

function fixture({ pipeline = PIPELINE, jds = [] } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'jev-rank-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  writeFileSync(join(dataRoot, 'data', 'pipeline.md'), pipeline);
  for (const jd of jds) writeJd(jd, { dataRoot, today: '2026-10-24' });
  return dataRoot;
}

const JD_1 = { url: 'https://x.test/1', title: 'Backend Lead', company: 'Acme', description: 'Lead a product team.', source: 'linkedin', source_id: '1' };
const JD_2 = { url: 'https://x.test/2', title: 'Android Lead', company: 'Beta', description: 'Lead the Android team.', source: 'linkedin', source_id: '2' };

/** A scorer stub keyed by URL; a value that is an Error is thrown. */
function scorerFor(table) {
  const calls = [];
  const scorer = async (job) => {
    calls.push(job);
    const answer = table[job.url];
    if (answer instanceof Error) throw answer;
    if (!answer) throw new Error(`no stub answer for ${job.url}`);
    return answer;
  };
  return { scorer, calls };
}

const collect = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(String(l)), out: (l) => lines.push(String(l)) };
};

const readPipeline = (dataRoot) => readFileSync(join(dataRoot, 'data', 'pipeline.md'), 'utf-8');
const neverFetch = async (url) => { throw new Error(`fetch called for ${url}`); };

// ── pure functions ────────────────────────────────────────────────────────────

test('parsePendingJev skips rows that carry | jev: , not rows that carry | rank: ', () => {
  const pending = parsePendingJev(PIPELINE);
  assert.deepEqual(pending.map((e) => e.url), ['https://x.test/1', 'https://x.test/2']);
  assert.equal(pending[0].company, 'Acme');
  assert.equal(pending[0].title, 'Backend Lead');
  assert.equal(pending[0].location, 'Remote');
  assert.equal(pending[1].location, '');
  assert.equal(pending[0].index, 4);
  assert.equal(pending[0].raw, ROW_1);
  assert.equal(countAnnotatedPending(PIPELINE), 1);
  assert.equal(JEV_LABEL, '| jev: ');
});

test('a labeled segment in the location slot is not read as a location', () => {
  const [entry] = parsePendingJev('- [ ] https://x.test/9 | Co | Role | posted: 2026-01-01');
  assert.equal(entry.location, '');
});

test('appendJevAnnotation rides last and is idempotent', () => {
  const once = appendJevAnnotation(ROW_1, APPLY_SEGMENT);
  assert.equal(once, `${ROW_1} | ${APPLY_SEGMENT}`);
  assert.equal(appendJevAnnotation(once, 'jev: 1 skip — x'), once);
  assert.equal(appendJevAnnotation(ROW_1, ''), ROW_1);
});

test('applyJevAnnotations annotates duplicates separately and skips annotated rows', () => {
  const dup = '- [ ] https://x.test/9 | Acme | Backend Lead';
  const text = ['## Pending', dup, dup].join('\n');
  const out = applyJevAnnotations(text, [
    { raw: dup, index: 1, segment: 'jev: 70 apply — first' },
    { raw: dup, index: 2, segment: 'jev: 30 skip — second' },
  ], text);
  assert.equal(out.written, 2);
  assert.ok(out.text.includes('— first') && out.text.includes('— second'));
  const already = applyJevAnnotations(`${dup} | jev: 10 skip — old`, [{ raw: dup, segment: 'jev: 99 apply — new' }]);
  assert.equal(already.written, 0);
  const stale = applyJevAnnotations('- [ ] https://other.test | X | Y', [{ raw: dup, segment: 'jev: 50 maybe — x' }]);
  assert.equal(stale.written, 0);
  // A rank: segment on the row is kept and the jev: segment rides after it.
  const ranked = applyJevAnnotations(ROW_1, [{ raw: ROW_1, index: 0, segment: APPLY_SEGMENT }], ROW_1);
  assert.equal(ranked.text, `${ROW_1} | ${APPLY_SEGMENT}`);
});

test('selectJevBatch honours the limit, the default and the ceiling', () => {
  const entries = Array.from({ length: 600 }, (_, i) => ({ i }));
  assert.equal(DEFAULT_LIMIT, 50);
  assert.equal(LIMIT_CEILING, 500);
  assert.equal(selectJevBatch(entries, 3).length, 3);
  assert.equal(selectJevBatch(entries, undefined).length, DEFAULT_LIMIT);
  assert.equal(selectJevBatch(entries, 9999).length, LIMIT_CEILING);
});

test('jobFromEntry builds the C1 job from a stored JD or a fetched text', () => {
  const entry = parsePendingJev(ROW_2)[0];
  const stored = jobFromEntry(entry, { ...JD_2, workplace: 'hybrid', seniority: 'Senior' });
  assert.equal(stored.url, 'https://x.test/2');
  assert.equal(stored.description, 'Lead the Android team.');
  assert.equal(stored.workplace, 'hybrid');
  const fetched = jobFromEntry(entry, { title: 'Android Lead (m/f/d)', text: 'Body text', ats: 'greenhouse' });
  assert.equal(fetched.title, 'Android Lead (m/f/d)');
  assert.equal(fetched.company, 'Beta');
  assert.equal(fetched.description, 'Body text');
  assert.equal(fetched.workplace, '');
  assert.equal(summaryLine({ scored: 1, noJd: 2, failed: 3, skipped: 4 }), 'jev-rank: 1 scored, 2 without JD, 3 failed, 4 already annotated');
});

// ── the pass itself (scorer and fetch injected) ───────────────────────────────

test('a row with a stored JD gets the segment after its rank: segment; no JD and --no-fetch leaves a row unchanged', async () => {
  const dataRoot = fixture({ jds: [JD_1] });
  const { scorer, calls } = scorerFor({ 'https://x.test/1': APPLY });
  const io = collect();
  const code = await main(['--no-fetch'], { dataRoot, scorer, fetchJd: neverFetch, ...io });
  assert.equal(code, 0, io.lines.join('\n'));
  const lines = readPipeline(dataRoot).split('\n');
  assert.equal(lines[4], `${ROW_1} | ${APPLY_SEGMENT}`);
  assert.equal(lines[5], ROW_2);
  assert.equal(lines[6], ROW_3);
  assert.equal(lines[7], ROW_4);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].description, 'Lead a product team.');
  assert.ok(io.lines.some((l) => l === 'jev-rank: 1 scored, 1 without JD, 0 failed, 1 already annotated'), io.lines.join('\n'));
  assert.ok(!readPipeline(dataRoot).includes('jev: 0'));
});

test('a scorer failure leaves the row unchanged and is counted', async () => {
  const dataRoot = fixture({ jds: [JD_1, JD_2] });
  const { scorer } = scorerFor({ 'https://x.test/1': APPLY, 'https://x.test/2': new Error('HTTP 500 from Jev') });
  const io = collect();
  const code = await main(['--no-fetch'], { dataRoot, scorer, fetchJd: neverFetch, ...io });
  assert.equal(code, 0);
  const lines = readPipeline(dataRoot).split('\n');
  assert.equal(lines[4], `${ROW_1} | ${APPLY_SEGMENT}`);
  assert.equal(lines[5], ROW_2);
  assert.ok(io.lines.some((l) => l === 'jev-rank: 1 scored, 0 without JD, 1 failed, 1 already annotated'), io.lines.join('\n'));
  assert.ok(io.lines.some((l) => /HTTP 500/.test(l)));
});

test('a result without a usable fit is a failure, never a bare jev: on the row', async () => {
  const dataRoot = fixture({ jds: [JD_1] });
  const { scorer } = scorerFor({ 'https://x.test/1': NO_FIT });
  const io = collect();
  await main(['--no-fetch'], { dataRoot, scorer, fetchJd: neverFetch, ...io });
  assert.equal(readPipeline(dataRoot).split('\n')[4], ROW_1);
  assert.ok(io.lines.some((l) => l === 'jev-rank: 0 scored, 1 without JD, 1 failed, 1 already annotated'), io.lines.join('\n'));
});

test('--dry-run writes nothing and prints what it would write', async () => {
  const dataRoot = fixture({ jds: [JD_1] });
  const before = readPipeline(dataRoot);
  const { scorer } = scorerFor({ 'https://x.test/1': APPLY });
  const io = collect();
  const code = await main(['--dry-run', '--no-fetch'], { dataRoot, scorer, fetchJd: neverFetch, ...io });
  assert.equal(code, 0);
  assert.equal(readPipeline(dataRoot), before);
  assert.ok(io.lines.some((l) => l === `${ROW_1} | ${APPLY_SEGMENT}`), io.lines.join('\n'));
  assert.ok(io.lines.some((l) => /dry-run/.test(l)));
});

test('without --no-fetch a missing JD is fetched through the known ATS APIs', async () => {
  const dataRoot = fixture({ jds: [JD_1] });
  const fetched = [];
  const fetchJd = async (url) => {
    fetched.push(url);
    return url === 'https://x.test/2' ? { url, title: 'Android Lead', text: 'Fetched body.', ats: 'greenhouse' } : null;
  };
  const { scorer, calls } = scorerFor({ 'https://x.test/1': APPLY, 'https://x.test/2': { ...APPLY, fit: 61, score: 3.4, verdict: 'maybe' } });
  const io = collect();
  await main([], { dataRoot, scorer, fetchJd, ...io });
  assert.deepEqual(fetched, ['https://x.test/2']);
  assert.equal(calls.find((j) => j.url === 'https://x.test/2').description, 'Fetched body.');
  const lines = readPipeline(dataRoot).split('\n');
  assert.ok(lines[5].startsWith(`${ROW_2} | jev: 61 maybe — `), lines[5]);
  assert.ok(io.lines.some((l) => l === 'jev-rank: 2 scored, 0 without JD, 0 failed, 1 already annotated'), io.lines.join('\n'));
});

test('a fetch that fails or returns nothing counts as no JD', async () => {
  const dataRoot = fixture({ jds: [] });
  const fetchJd = async (url) => { if (url.endsWith('/1')) throw new Error('boom'); return null; };
  const { scorer, calls } = scorerFor({});
  const io = collect();
  const code = await main([], { dataRoot, scorer, fetchJd, ...io });
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  assert.equal(readPipeline(dataRoot), PIPELINE);
  assert.ok(io.lines.some((l) => l === 'jev-rank: 0 scored, 2 without JD, 0 failed, 1 already annotated'), io.lines.join('\n'));
});

test('--limit caps the rows scored this run and says how many are left', async () => {
  const dataRoot = fixture({ jds: [JD_1, JD_2] });
  const { scorer, calls } = scorerFor({ 'https://x.test/1': APPLY, 'https://x.test/2': APPLY });
  const io = collect();
  await main(['--limit', '1', '--no-fetch'], { dataRoot, scorer, fetchJd: neverFetch, ...io });
  assert.equal(calls.length, 1);
  const lines = readPipeline(dataRoot).split('\n');
  assert.equal(lines[4], `${ROW_1} | ${APPLY_SEGMENT}`);
  assert.equal(lines[5], ROW_2);
  assert.ok(io.lines.some((l) => /1 pending row\(s\) not scored this run/.test(l)), io.lines.join('\n'));
});

test('a second run is idempotent: annotated rows are skipped, nothing is rewritten', async () => {
  const dataRoot = fixture({ jds: [JD_1] });
  const { scorer, calls } = scorerFor({ 'https://x.test/1': APPLY });
  await main(['--no-fetch'], { dataRoot, scorer, fetchJd: neverFetch, ...collect() });
  const after = readPipeline(dataRoot);
  const io = collect();
  await main(['--no-fetch'], { dataRoot, scorer, fetchJd: neverFetch, ...io });
  assert.equal(readPipeline(dataRoot), after);
  assert.equal(calls.length, 1);
  assert.ok(io.lines.some((l) => l === 'jev-rank: 0 scored, 1 without JD, 0 failed, 2 already annotated'), io.lines.join('\n'));
});

test('a pipeline that moved under the run only annotates rows that are still there', async () => {
  const dataRoot = fixture({ jds: [JD_1, JD_2] });
  const { scorer } = scorerFor({
    'https://x.test/1': APPLY,
    'https://x.test/2': APPLY,
  });
  // The scorer for row 2 rewrites the file (as a concurrent scan would), so
  // row 1 is gone by the time annotations are applied.
  const racing = async (job) => {
    if (job.url === 'https://x.test/2') {
      writeFileSync(join(dataRoot, 'data', 'pipeline.md'), PIPELINE.replace(`${ROW_1}\n`, ''));
    }
    return scorer(job);
  };
  const io = collect();
  await main(['--no-fetch'], { dataRoot, scorer: racing, fetchJd: neverFetch, ...io });
  const text = readPipeline(dataRoot);
  assert.ok(!text.includes(ROW_1));
  assert.ok(text.includes(`${ROW_2} | ${APPLY_SEGMENT}`));
});

test('no pipeline file is not an error', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'jev-rank-empty-'));
  const io = collect();
  const code = await main([], { dataRoot, scorer: scorerFor({}).scorer, fetchJd: neverFetch, ...io });
  assert.equal(code, 0);
  assert.ok(io.lines.some((l) => /No data\/pipeline\.md/.test(l)));
  assert.ok(!existsSync(join(dataRoot, 'data')));
});

test('without a key the run stops with exit 2 before touching anything', async (t) => {
  const envPath = join(ROOT, '.env');
  if (existsSync(envPath)) {
    const vars = parseDotEnv(readFileSync(envPath, 'utf-8'));
    if (vars.OPENROUTER_API_KEY_JOB_SEARCH || vars.OPENROUTER_API_KEY) {
      t.skip('the checkout .env defines an OpenRouter key');
      return;
    }
  }
  const dataRoot = fixture({ jds: [JD_1] });
  const io = collect();
  const code = await main(['--no-fetch'], { dataRoot, env: { CAREER_OPS_SKIP_KEYCHAIN: '1' }, fetchJd: neverFetch, ...io });
  assert.equal(code, 2);
  assert.ok(io.lines.some((l) => /OPENROUTER_API_KEY/.test(l)), io.lines.join('\n'));
  assert.equal(readPipeline(dataRoot), PIPELINE);
});

// ── CLI surface ───────────────────────────────────────────────────────────────

const baseEnv = (extra = {}) => ({ PATH: process.env.PATH, CAREER_OPS_SKIP_KEYCHAIN: '1', ...extra });

function runCli(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8', env, timeout: 60_000 });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  return r;
}

test('CLI: --self-test exits 0 and --help prints usage', () => {
  const env = baseEnv({ CAREER_OPS_ROOT: mkdtempSync(join(tmpdir(), 'jev-rank-cli-')) });
  const st = runCli(['--self-test'], env);
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.match(st.stdout, /self-test/);
  const help = runCli(['--help'], env);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /jev-rank\.mjs \[--limit N\] \[--dry-run\] \[--no-fetch\]/);
  assert.equal(runCli(['--bogus'], env).status, 1);
  assert.equal(runCli(['--limit', '0'], env).status, 1);
});

test('CLI: no pipeline file exits 0 with a message', () => {
  const env = baseEnv({ CAREER_OPS_ROOT: mkdtempSync(join(tmpdir(), 'jev-rank-cli-')) });
  const r = runCli([], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /No data\/pipeline\.md/);
});
