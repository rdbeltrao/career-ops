#!/usr/bin/env node
/**
 * jev-rank.mjs — a zero-token Jev pass over the pending rows of
 * `data/pipeline.md`.
 *
 * For every `- [ ] ` row that does not yet carry a `| jev: ` segment, the
 * script finds the job description (the feeder's JD store first, then the
 * posting's own ATS API through `fetchJdViaKnownApi`, never a browser), asks
 * Jev through `jev-score.mjs`, and appends
 *
 *   | jev: {fit} {verdict} — seniority {v}, location {v}, language {v}, {team_type}, stack {v}
 *
 * as the row's last labeled segment, after `rank:` when that one is present
 * (modes/pipeline.md). Like `rank-pipeline.mjs` it ANNOTATES and never
 * filters, reorders or deletes a row; a row the pass cannot score is left
 * exactly as it was and counted in the summary, never written as `jev: 0`.
 *
 * It costs no agent tokens: one OpenRouter decisions call per row (or the
 * chat-completions fallback, see jev-score.mjs), bounded by `--limit`
 * (default 50, ceiling 500). Writes go through `pipeline-lock.mjs` and the
 * file is re-read inside the lock, so a concurrent scan cannot lose rows.
 *
 * Usage:
 *   node jev-rank.mjs [--limit N] [--dry-run] [--no-fetch] [--self-test]
 *
 * Summary line: `jev-rank: {scored} scored, {noJd} without JD, {failed} failed,
 * {skipped} already annotated`. Exit 0 after a run, 2 without an OpenRouter
 * key (nothing touched), 1 on bad flags.
 *
 * The local `parsePendingJev` / `applyJevAnnotations` mirror
 * `rank-pipeline.mjs`'s `parsePendingEntries` / `applyAnnotations` with the
 * `jev` label: those two are keyed on `| rank: ` and leave a ranked row alone,
 * which is the opposite of what this pass needs (a ranked row is still a
 * candidate for a Jev segment).
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagValue, hasFlag, safeIntFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot, getProfilePath } from './path-resolver.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { acquireDirLock, releaseOrWarn, tryAcquireDirLockSync } from './lib/dir-lock.mjs';
import { jevLockDir, jevRerunMarker } from './lib/jev-auto.mjs';
import { resolveOpenRouterKey } from './lib/openrouter-key.mjs';
import { loadCriteria } from './lib/jev-criteria.mjs';
import { readJdForUrl } from './lib/jd-store.mjs';
import { JEV_MODEL, formatJevSegment, loadContextText, resolveChatModel, scoreJob } from './jev-score.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));

export const JEV_LABEL = '| jev: ';
export const DEFAULT_LIMIT = 50;
// A ceiling the flag cannot raise: one network call per row, run by hand.
export const LIMIT_CEILING = 500;
const FETCH_TEXT_CAP = 20_000;
const FETCH_TIMEOUT_MS = 15_000;
const LABELED_SEGMENT = /^[a-z_]+:(\s|$)/i;

const USAGE = `
  jev-rank.mjs — zero-token Jev pass over pending pipeline rows (annotates, never filters)

  node jev-rank.mjs [--limit N] [--dry-run] [--no-fetch] [--auto]

    --limit N     max rows to score this run (default ${DEFAULT_LIMIT}, ceiling ${LIMIT_CEILING})
    --auto        the background pass ingestion starts (lib/jev-auto.mjs): if
                  another pass is running, ask it to go again and exit; else
                  score up to ${LIMIT_CEILING} rows and repeat while rows keep arriving
    --dry-run     print the annotations, write nothing
    --no-fetch    only rows with a stored JD (jds/feeder/); never call an ATS API
    --self-test   run the in-memory suite (no network)

  JD per row: the feeder store (data/jd-index.tsv), then the posting's ATS API
  (fetchJdViaKnownApi) unless --no-fetch, else the row is left unchanged and
  counted as "without JD". Key: OPENROUTER_API_KEY_JOB_SEARCH or
  OPENROUTER_API_KEY (env, .env, macOS Keychain); exit 2 without one.
`;
const KNOWN_FLAGS = ['--limit', '--dry-run', '--no-fetch', '--auto', '--self-test', '--help', '-h'];
// An --auto pass that keeps being asked to go again stops after this many, so a
// writer stuck in a loop cannot keep it alive forever; the next write restarts it.
const MAX_AUTO_PASSES = 10;
// A manual run waits this long for a running pass before giving up.
const MANUAL_LOCK_WAIT_MS = 30 * 60 * 1000;
const LOCK_STALE_MS = 60 * 60 * 1000;
const VALUE_FLAGS = ['--limit'];

// ── row parsing ───────────────────────────────────────────────────────────────

/**
 * Pending rows without a `| jev: ` segment, in file order. `- [x]` rows are
 * excluded structurally; a row that already carries the segment is skipped so
 * re-runs are idempotent without a state file. A `| rank: ` segment does not
 * exclude a row.
 */
export function parsePendingJev(text) {
  const out = [];
  String(text ?? '').split('\n').forEach((raw, index) => {
    if (!raw.startsWith('- [ ] ')) return;
    if (raw.includes(JEV_LABEL)) return;
    const cells = raw.slice(6).split('|').map((c) => c.trim());
    const location = cells[3] && !LABELED_SEGMENT.test(cells[3]) ? cells[3] : '';
    out.push({ index, raw, url: cells[0] ?? '', company: cells[1] ?? '', title: cells[2] ?? '', location });
  });
  return out;
}

/** Pending rows that already carry a `| jev: ` segment. */
export function countAnnotatedPending(text) {
  return String(text ?? '').split('\n').filter((l) => l.startsWith('- [ ] ') && l.includes(JEV_LABEL)).length;
}

/** Append the segment to a row, byte-for-byte otherwise; idempotent. */
export function appendJevAnnotation(rawLine, segment) {
  if (typeof rawLine !== 'string' || rawLine.includes(JEV_LABEL)) return rawLine;
  const clean = String(segment ?? '').trim();
  if (!clean) return rawLine;
  return `${rawLine} | ${clean}`;
}

/**
 * Apply annotations to the pipeline text, each exactly once, bound to the
 * original occurrence of its row (pipeline.md does not enforce line
 * uniqueness). A row that gained a `| jev: ` segment meanwhile is skipped; a
 * duplicate group whose occurrence count changed is ambiguous and skipped.
 *
 * @param {string} text - current pipeline.md contents.
 * @param {{raw: string, segment: string, index?: number}[]} pending
 * @param {string} [originalText] - the snapshot whose indices were scored.
 * @returns {{ text: string, written: number }}
 */
export function applyJevAnnotations(text, pending, originalText = text) {
  const queue = pending.map((a) => ({ ...a, used: false }));
  const lines = String(text ?? '').split('\n');
  const occurrences = (source) => {
    const groups = new Map();
    String(source ?? '').split('\n').forEach((line, index) => {
      const raw = line.split(` ${JEV_LABEL}`)[0].replace(/^- \[x\] /, '- [ ] ');
      if (!groups.has(raw)) groups.set(raw, []);
      groups.get(raw).push(index);
    });
    return groups;
  };
  const original = occurrences(originalText);
  const current = occurrences(text);
  let written = 0;
  const out = lines.map((line, index) => {
    if (line.includes(JEV_LABEL)) return line;
    const hit = queue.find((a) => {
      if (a.used || a.raw !== line) return false;
      if (a.index === undefined) return true;
      const before = original.get(a.raw) ?? [];
      const now = current.get(a.raw) ?? [];
      return before.length === now.length && before.indexOf(a.index) === now.indexOf(index);
    });
    if (!hit) return line;
    hit.used = true;
    written += 1;
    return appendJevAnnotation(line, hit.segment);
  }).join('\n');
  return { text: out, written };
}

/** Respects --limit and the ceiling the flag cannot raise. File order. */
export function selectJevBatch(entries, limit) {
  const n = Number(limit);
  const effective = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), LIMIT_CEILING) : DEFAULT_LIMIT;
  return entries.slice(0, effective);
}

/**
 * The C1 job for a row: a stored JD (the feeder's object) or a fetched one
 * (`{ title, text }` from fetchJdViaKnownApi). The row's own cells fill what
 * the JD does not carry.
 */
export function jobFromEntry(entry, jd) {
  const s = (v) => (v == null ? '' : String(v));
  const fetched = jd && typeof jd === 'object' && 'text' in jd && !('description' in jd);
  return {
    url: s(jd?.url) || entry.url,
    title: s(jd?.title) || entry.title,
    company: s(jd?.company) || entry.company,
    location: s(jd?.location) || entry.location,
    workplace: s(jd?.workplace),
    seniority: s(jd?.seniority),
    description: fetched ? s(jd.text) : s(jd?.description),
    salary: s(jd?.salary),
    posted_date: s(jd?.posted_date),
  };
}

export function summaryLine({ scored, noJd, failed, skipped }) {
  return `jev-rank: ${scored} scored, ${noJd} without JD, ${failed} failed, ${skipped} already annotated`;
}

// ── JD resolution ─────────────────────────────────────────────────────────────

/** The default fetcher: the posting's ATS API, loaded only when needed. */
async function defaultFetchJd(url) {
  const { fetchJdViaKnownApi } = await import('./browser-extract.mjs');
  return fetchJdViaKnownApi(url, FETCH_TEXT_CAP, FETCH_TIMEOUT_MS);
}

/**
 * Store first, then the ATS API unless `noFetch`. Null when neither has a
 * description; a fetch that throws counts the same as a fetch that misses.
 */
export async function resolveJd(entry, { dataRoot, fetchJd = defaultFetchJd, noFetch = false, log = () => {} } = {}) {
  const stored = readJdForUrl(entry.url, { dataRoot });
  if (stored && String(stored.description ?? '').trim()) return { job: jobFromEntry(entry, stored), from: 'store' };
  if (noFetch || !entry.url) return null;
  let fetched = null;
  try {
    fetched = await fetchJd(entry.url);
  } catch (err) {
    log(`  ${entry.url}: JD fetch failed (${err?.message ?? err})`);
    return null;
  }
  if (!fetched || !String(fetched.text ?? '').trim()) return null;
  return { job: jobFromEntry(entry, fetched), from: 'fetch' };
}

// ── the pass ──────────────────────────────────────────────────────────────────

/**
 * Score the selected rows. Pure apart from the injected `scorer` and `fetchJd`;
 * nothing is written here.
 *
 * @returns {Promise<{ annotations: {raw: string, index: number, segment: string}[], counts: {scored: number, noJd: number, failed: number, skipped: number} }>}
 */
export async function scorePending(selected, { dataRoot, scorer, fetchJd, noFetch, skipped = 0, log = () => {} }) {
  const annotations = [];
  const counts = { scored: 0, noJd: 0, failed: 0, skipped };
  for (const entry of selected) {
    const resolved = await resolveJd(entry, { dataRoot, fetchJd, noFetch, log });
    if (!resolved) {
      counts.noJd += 1;
      log(`  ${entry.url || entry.raw}: no JD (${noFetch ? 'not in the store, --no-fetch' : 'not in the store, no API answer'}), left unchanged`);
      continue;
    }
    let result;
    try {
      result = await scorer(resolved.job);
    } catch (err) {
      counts.failed += 1;
      log(`  ${entry.url}: Jev failed (${err?.message ?? err}), left unchanged`);
      continue;
    }
    const segment = formatJevSegment(result);
    if (!segment) {
      counts.failed += 1;
      log(`  ${entry.url}: Jev gave no usable fit${result?.error ? ` (${result.error})` : ''}, left unchanged`);
      continue;
    }
    counts.scored += 1;
    annotations.push({ raw: entry.raw, index: entry.index, segment });
  }
  return { annotations, counts };
}

/** The real scorer: criteria, context and key resolved once for the run. */
function buildScorer({ dataRoot, env, log }) {
  const { key } = resolveOpenRouterKey({ env, codeRoot: CAREER_OPS, dataRoot });
  if (!key) {
    log('jev-rank: no OpenRouter key found. Set OPENROUTER_API_KEY_JOB_SEARCH or OPENROUTER_API_KEY in the environment or .env, or store it in the macOS Keychain.');
    return null;
  }
  const criteria = loadCriteria({ dataRoot, codeRoot: CAREER_OPS });
  const context = loadContextText({ dataRoot, profilePath: getProfilePath() });
  if (context.notice) log(context.notice.replace(/^jev-score:/, 'jev-rank:'));
  if (!context.text.trim()) throw new Error('no candidate context found (modes/_context.md, cv.md or config/profile.yml in the data root)');
  const chatModel = resolveChatModel(env);
  let noticed = false;
  return (job) => scoreJob({
    profileText: context.text, job, criteria, apiKey: key, model: JEV_MODEL, chatModel,
    onNotice: (line) => { if (!noticed) { noticed = true; log(line.replace(/^jev-score:/, 'jev-rank:')); } },
  });
}

/**
 * The CLI body. `deps` is for tests and for callers that already hold a
 * scorer: `dataRoot`, `scorer(job)`, `fetchJd(url)`, `env`, `log` (stderr
 * lines) and `out` (stdout lines).
 *
 * @returns {Promise<number>} exit code
 */
export async function main(args, deps = {}) {
  const log = deps.log ?? ((line) => console.error(line));
  const out = deps.out ?? ((line) => console.log(line));
  const dataRoot = deps.dataRoot ?? getCareerOpsRoot();
  const auto = hasFlag(args, '--auto');
  const dryRun = hasFlag(args, '--dry-run');
  // A dry run writes nothing, and a data root with no pipeline has nothing to
  // score: neither needs the lock (nor a data/ directory created for it).
  if (dryRun || !existsSync(join(dataRoot, 'data', 'pipeline.md'))) return runPass(args, { ...deps, log, out, dataRoot });

  // One pass at a time per data root: two concurrent passes would pay for the
  // same rows twice. Ingestion starts an --auto pass after every write, so the
  // lock is routinely contended.
  const lockDir = jevLockDir(dataRoot);
  const marker = jevRerunMarker(dataRoot);
  const lockOptions = { staleMs: LOCK_STALE_MS, owner: { script: 'jev-rank' }, createParent: true };
  let lock;
  if (auto) {
    lock = tryAcquireDirLockSync(lockDir, lockOptions);
    if (!lock) {
      writeFileSync(marker, '');
      out('jev-rank: another pass is running; it will score the new rows when it finishes.');
      return 0;
    }
  } else {
    lock = await acquireDirLock(lockDir, { ...lockOptions, timeoutMs: MANUAL_LOCK_WAIT_MS, retryMs: 250 });
  }

  try {
    if (!auto) return await runPass(args, { ...deps, log, out, dataRoot });
    const passArgs = hasFlag(args, '--limit') ? args : [...args, '--limit', String(LIMIT_CEILING)];
    let code = 0;
    for (let pass = 1; pass <= MAX_AUTO_PASSES; pass += 1) {
      rmSync(marker, { force: true });
      out(`jev-rank --auto: pass ${pass} at ${new Date().toISOString()}`);
      code = await runPass(passArgs, { ...deps, log, out, dataRoot });
      if (code !== 0 || !existsSync(marker)) break;
    }
    return code;
  } finally {
    releaseOrWarn(lock);
  }
}

/** One scoring pass over the pending rows; see main() for the locking around it. */
async function runPass(args, deps) {
  const { log, out, dataRoot } = deps;
  const env = deps.env ?? process.env;

  const dryRun = hasFlag(args, '--dry-run');
  const noFetch = hasFlag(args, '--no-fetch');
  const rawLimit = flagValue(args, '--limit');
  const limit = safeIntFlag(rawLimit, hasFlag(args, '--limit') ? 0 : DEFAULT_LIMIT);
  if (limit <= 0 || (rawLimit !== undefined && rawLimit.trim() !== rawLimit)) {
    log('--limit must be a positive integer.');
    return 1;
  }

  const pipelinePath = join(dataRoot, 'data', 'pipeline.md');
  if (!existsSync(pipelinePath)) {
    out('No data/pipeline.md yet — run a scan or the feeder first. Nothing to score.');
    return 0;
  }

  const original = readFileSync(pipelinePath, 'utf-8');
  const pending = parsePendingJev(original);
  const skipped = countAnnotatedPending(original);
  if (!pending.length) {
    out(`No pending rows without a jev: segment. ${summaryLine({ scored: 0, noJd: 0, failed: 0, skipped })}`);
    return 0;
  }
  const selected = selectJevBatch(pending, limit);

  let scorer = deps.scorer;
  if (!scorer) {
    try {
      scorer = buildScorer({ dataRoot, env, log });
    } catch (err) {
      log(`jev-rank: ${err?.message ?? err}`);
      return 1;
    }
    if (!scorer) return 2;
  }

  const started = Date.now();
  const { annotations, counts } = await scorePending(selected, {
    dataRoot, scorer, fetchJd: deps.fetchJd ?? defaultFetchJd, noFetch, skipped, log,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (dryRun) {
    for (const { raw, segment } of annotations) out(appendJevAnnotation(raw, segment));
    out(`\n  [dry-run] would annotate ${annotations.length} of ${selected.length} selected row(s) in ${elapsed}s.`);
    out(summaryLine(counts));
    return 0;
  }

  let written = 0;
  if (annotations.length) {
    // Re-read inside the lock: scan.mjs, the feeder and a concurrent run of
    // this script all write data/pipeline.md.
    await withPipelineLock(pipelinePath, () => {
      const current = readFileSync(pipelinePath, 'utf-8');
      const result = applyJevAnnotations(current, annotations, original);
      written = result.written;
      if (written) writeFileSync(pipelinePath, result.text);
    });
    if (written < annotations.length) {
      log(`  ${annotations.length - written} scored row(s) moved before the write and were left unchanged; re-run to retry them.`);
    }
  }

  out(summaryLine({ ...counts, scored: written }));
  if (pending.length > selected.length) {
    out(`  ${pending.length - selected.length} pending row(s) not scored this run (--limit ${selected.length}). Re-run to continue.`);
  }
  out(`  Elapsed: ${elapsed}s`);
  return 0;
}

// ── self-test ─────────────────────────────────────────────────────────────────
// Pure-function coverage plus one in-memory pass with a stub scorer. Touches
// no real pipeline and no network.
async function selfTest() {
  let pass = 0;
  let fail = 0;
  const check = (name, cond) => {
    if (cond) pass += 1;
    else { fail += 1; console.log(`  FAIL: ${name}`); }
  };
  const ranked = '- [ ] https://x.test/1 | Acme | Backend Lead | Remote | rank: 4.0/5 — strong';
  const plain = '- [ ] https://x.test/2 | Beta | Android Lead';
  const done = '- [x] https://x.test/3 | Gamma | Done';
  const annotated = '- [ ] https://x.test/4 | Delta | Ranked | jev: 50 maybe — x';
  const text = ['## Pending', ranked, plain, done, annotated].join('\n');

  const pending = parsePendingJev(text);
  check('finds the two candidates', pending.length === 2);
  check('a rank: row is still a candidate', pending[0].raw === ranked);
  check('a jev: row is skipped', !pending.some((e) => e.raw === annotated));
  check('a processed row is skipped', !pending.some((e) => e.raw === done));
  check('location parsed', pending[0].location === 'Remote' && pending[1].location === '');
  check('annotated rows counted', countAnnotatedPending(text) === 1);

  const seg = 'jev: 79 apply — seniority match, location yes, language none, product, stack agnostic';
  const once = appendJevAnnotation(ranked, seg);
  check('segment rides last, after rank:', once === `${ranked} | ${seg}`);
  check('append is idempotent', appendJevAnnotation(once, 'jev: 1 skip — y') === once);
  check('empty segment leaves the row alone', appendJevAnnotation(ranked, '') === ranked);

  const applied = applyJevAnnotations(text, [{ raw: ranked, index: 1, segment: seg }], text);
  check('apply writes one row', applied.written === 1 && applied.text.split('\n')[1] === once);
  check('apply leaves the other rows', applied.text.split('\n')[2] === plain && applied.text.split('\n')[4] === annotated);
  const dupText = ['## Pending', plain, plain].join('\n');
  const dupOut = applyJevAnnotations(dupText, [
    { raw: plain, index: 1, segment: 'jev: 70 apply — first' },
    { raw: plain, index: 2, segment: 'jev: 30 skip — second' },
  ], dupText);
  check('duplicates take their own segment', dupOut.written === 2 && dupOut.text.includes('— first') && dupOut.text.includes('— second'));
  check('a vanished row is a no-op', applyJevAnnotations('- [ ] https://other.test | X | Y', [{ raw: plain, segment: seg }]).written === 0);

  check('limit respected', selectJevBatch(pending, 1).length === 1);
  check('default limit', selectJevBatch(Array(80).fill({}), undefined).length === DEFAULT_LIMIT);
  check('ceiling cannot be raised', selectJevBatch(Array(600).fill({}), 9999).length === LIMIT_CEILING);

  const job = jobFromEntry(pending[1], { title: 'Android Lead (m/f/d)', text: 'Body', ats: 'lever' });
  check('fetched JD becomes the description', job.description === 'Body' && job.company === 'Beta' && job.url === 'https://x.test/2');
  check('summary line', summaryLine({ scored: 1, noJd: 2, failed: 3, skipped: 4 }) === 'jev-rank: 1 scored, 2 without JD, 3 failed, 4 already annotated');

  const apply = { fit: 79, verdict: 'apply', reasons: { seniority_match: 'match', location_ok: 'yes', language_blocker: 'none', team_type: 'product', stack_fit: 'stack_agnostic' }, error: null };
  const scorer = async (j) => { if (j.url.endsWith('/2')) throw new Error('HTTP 500'); return apply; };
  const fetchJd = async (url) => ({ url, title: 'T', text: 'fetched body' });
  const run = await scorePending(pending, { dataRoot: join(CAREER_OPS, 'does-not-exist'), scorer, fetchJd, noFetch: false, skipped: 1 });
  check('one scored, one failed', run.counts.scored === 1 && run.counts.failed === 1 && run.counts.noJd === 0 && run.counts.skipped === 1);
  check('annotation carries the segment', run.annotations[0]?.segment === seg && run.annotations[0].index === 1);
  const noFetchRun = await scorePending(pending, { dataRoot: join(CAREER_OPS, 'does-not-exist'), scorer, fetchJd, noFetch: true });
  check('--no-fetch counts rows without a stored JD', noFetchRun.counts.noJd === 2 && noFetchRun.annotations.length === 0);
  const noFitRun = await scorePending([pending[0]], { dataRoot: join(CAREER_OPS, 'does-not-exist'), scorer: async () => ({ ...apply, fit: null }), fetchJd, noFetch: false });
  check('a null fit is a failure, never jev: 0', noFitRun.counts.failed === 1 && noFitRun.annotations.length === 0);

  console.log(`\n  jev-rank self-test: ${pass} passed, ${fail} failed\n`);
  return fail === 0 ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, {
    valueFlags: VALUE_FLAGS,
    requireOperand: true,
  });
  if (hasFlag(args, '--self-test')) {
    selfTest().then((code) => process.exit(code)).catch((err) => {
      console.error(err?.message ?? err);
      process.exit(1);
    });
  } else {
    main(args).then((code) => process.exit(code)).catch((err) => {
      console.error(err?.message ?? err);
      process.exit(1);
    });
  }
}
