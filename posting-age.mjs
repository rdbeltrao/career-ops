#!/usr/bin/env node
/**
 * posting-age.mjs — posting age and repost count as data, not prose.
 *
 * `modes/oferta.md` → **Evidence-based hard stops** item 4 caps a requisition
 * first posted more than 60 days ago, or re-listed three or more times, at
 * `final_decision: Consider`. Until this script existed, nothing computed
 * either number: the evaluator was told to look at `data/scan-history.tsv`
 * and estimate. This reads the same file and answers with the same logic
 * `detect-reposts.mjs` uses (its exported functions, not a copy), so the
 * evaluation, the batch worker and `verify-report-consistency.mjs` agree on
 * one answer.
 *
 * Inputs: the posting URL, and optionally the company and title the JD states.
 *
 *   - FIRST SEEN. The URL's own `first_seen` row in scan-history.tsv (matched
 *     by normalized URL, so http/https, tracking params and a trailing slash
 *     do not split one posting into two), the URL row's `posted_at` column
 *     when the ATS supplied one, the earliest `first_seen` of every `added`
 *     row at the same company with the same title identity
 *     (`titleIdentityKey`, the repost detector's own equality), and the
 *     `--posted-at` date the JD itself states. The earliest of those is
 *     `first_seen`; `first_seen_source` says which one won. A requisition
 *     re-listed under a new URL is the case the whole check exists for, which
 *     is why the identity cluster counts and not only the URL row.
 *
 *   - REPOST COUNT. `detectReposts()` over the whole history with its default
 *     90-day window and 1-day minimum span (both overridable, same flags as the
 *     detector). The cluster whose company key matches and that either lists
 *     this URL or shares the title identity is the posting's cluster;
 *     `repost_count` is its `repostCount` — the number of distinct listings
 *     the detector counts, including the current one. No cluster: 0 when the
 *     URL is unknown to the history, 1 when it is known (listed once).
 *
 *   - HARD STOP. `age_days > 60` or `repost_count >= 3`, exactly the two
 *     conditions the mode text names. The thresholds are exported constants so
 *     the consistency check reads the same numbers.
 *
 * Only `added` rows are evidence, as in the detector: `skipped_*` rows describe
 * postings the scanner dropped, not sightings of this requisition.
 *
 * Output: `--format json` (default) or `--format markdown`, a block the
 * evaluator pastes into Block G and, when `hard_stop` is true, a ready
 * `hard_stops` entry. Exit 0 whenever the file was read, including when the
 * URL is unknown and the age cannot be known: an unknown URL is an answer, not
 * an error. Exit 1 when scan-history.tsv is absent (a fresh install has no
 * sightings to consult — the caller writes `not run`), exit 2 on a usage error.
 * Read-only: nothing is written anywhere.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { companyKey, detectReposts, loadAggregatorCompanies, parseScanHistory, titleIdentityKey } from './detect-reposts.mjs';
import { flagValue, safeIntFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';
import { parseDate } from './lib/parse-date.mjs';
import { parseScanHistoryLine, scanHistoryLineHasColumn } from './lib/scan-history-columns.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { normalizeUrl } from './url-key.mjs';

/** Days after which a requisition counts as evergreen (`modes/oferta.md` hard stop 4). */
export const MAX_POSTING_AGE_DAYS = 60;
/** Distinct listings at which a requisition counts as re-listed (hard stop 4). */
export const REPOST_HARD_STOP_COUNT = 3;
/** The detector's defaults, repeated here only to pass them through. */
const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_MIN_SPAN_DAYS = 1;

const DAY_MS = 86_400_000;

function urlKey(raw) {
  return normalizeUrl(raw) || String(raw ?? '').trim();
}

function daysBetween(fromIso, toIso) {
  const from = parseDate(fromIso);
  const to = parseDate(toIso);
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

/**
 * The `posted_at` column of every `added` row whose URL matches, keyed the
 * same way the first-seen lookup is. `parseScanHistory` drops the column, so
 * this reads it from the raw lines; a value that is not a plain date is
 * ignored rather than guessed at.
 *
 * @param {string} content raw scan-history.tsv text
 * @returns {Map<string, string>} normalized URL → earliest valid posted_at
 */
export function postedAtByUrl(content) {
  const out = new Map();
  for (const line of String(content ?? '').split('\n')) {
    if (!line.trim() || !scanHistoryLineHasColumn(line, 'posted_at')) continue;
    const row = parseScanHistoryLine(line);
    if (row.url.trim().toLowerCase() === 'url') continue;
    if ((row.status || 'added').trim() !== 'added') continue;
    const posted = row.posted_at.trim().slice(0, 10);
    if (!parseDate(posted)) continue;
    const key = urlKey(row.url);
    if (!key) continue;
    const prev = out.get(key);
    if (!prev || posted < prev) out.set(key, posted);
  }
  return out;
}

/**
 * Age and repost count for one posting, from parsed scan-history rows.
 *
 * @param {{url: string, company?: string, title?: string, postedAt?: string|null, today?: string, windowDays?: number, minSpan?: number, aggregators?: Set<string>|Map<string, string>|null, postedAtIndex?: Map<string, string>}} input
 * @param {Array<ReturnType<typeof parseScanHistory>[number]>} rows
 */
export function postingAge(input, rows) {
  const today = input.today ?? localToday();
  const url = String(input.url ?? '').trim();
  const key = urlKey(url);
  const added = (Array.isArray(rows) ? rows : []).filter(r => r && (r.status ?? 'added') === 'added' && r.dateStr);
  const urlRows = key ? added.filter(r => urlKey(r.url) === key) : [];
  const urlRow = urlRows.length ? urlRows.reduce((a, b) => (b.dateStr < a.dateStr ? b : a)) : null;

  // The company and title the caller gives win; the URL's own row fills in
  // whichever the caller left out, so `--url` alone still finds the cluster.
  const company = String(input.company ?? '').trim() || urlRow?.company || '';
  const title = String(input.title ?? '').trim() || urlRow?.title || '';
  const cKey = company ? companyKey({ company }) : '';
  const tKey = title ? titleIdentityKey(title) : '';

  const identityRows = cKey && tKey ? added.filter(r => companyKey(r) === cKey && titleIdentityKey(r.title) === tKey) : [];
  const identityFirst = identityRows.length ? identityRows.reduce((a, b) => (b.dateStr < a.dateStr ? b : a)) : null;

  const candidates = [];
  if (urlRow) candidates.push({ date: urlRow.dateStr, source: 'scan-history url row' });
  const postedAt = key ? input.postedAtIndex?.get(key) : null;
  if (postedAt) candidates.push({ date: postedAt, source: 'scan-history posted_at' });
  if (identityFirst && (!urlRow || identityFirst.dateStr < urlRow.dateStr)) candidates.push({ date: identityFirst.dateStr, source: 'scan-history title identity' });
  const stated = input.postedAt ? String(input.postedAt).trim().slice(0, 10) : '';
  if (stated && parseDate(stated)) candidates.push({ date: stated, source: 'jd posted_at' });
  candidates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const first = candidates[0] ?? null;

  const clusters = detectReposts(added, input.windowDays ?? DEFAULT_WINDOW_DAYS, input.minSpan ?? DEFAULT_MIN_SPAN_DAYS, input.aggregators ?? null);
  const cluster = clusters.find(c => companyKey({ company: c.company }) === (cKey || companyKey({ company: c.company }))
    && (c.appearances.some(a => urlKey(a.url) === key) || (tKey && titleIdentityKey(c.role) === tKey))) ?? null;
  const repostCount = cluster ? cluster.repostCount : urlRow ? 1 : 0;

  const ageDays = first ? daysBetween(first.date, today) : null;
  const reasons = [];
  if (ageDays !== null && ageDays > MAX_POSTING_AGE_DAYS) reasons.push(`first posted ${first.date} (${first.source}), ${ageDays} days before ${today}`);
  if (repostCount >= REPOST_HARD_STOP_COUNT) reasons.push(`re-listed ${repostCount} times between ${cluster.firstSeen} and ${cluster.lastSeen} (detect-reposts.mjs)`);
  const hardStop = reasons.length > 0;

  return {
    url,
    company: company || null,
    title: title || null,
    today,
    known: Boolean(urlRow),
    first_seen: first?.date ?? null,
    first_seen_source: first?.source ?? null,
    url_first_seen: urlRow?.dateStr ?? null,
    age_days: ageDays,
    repost_count: repostCount,
    repost_cluster: cluster ? { firstSeen: cluster.firstSeen, lastSeen: cluster.lastSeen, daysSpan: cluster.daysSpan, appearances: cluster.appearances } : null,
    hard_stop: hardStop,
    hard_stop_entry: hardStop ? `Evergreen or re-listed requisition (posting-age.mjs): ${reasons.join('; ')}. Verdict capped at Consider; Block G at most Proceed with Caution.` : null,
    thresholds: { max_age_days: MAX_POSTING_AGE_DAYS, repost_count: REPOST_HARD_STOP_COUNT },
  };
}

/**
 * Read scan-history.tsv from the data root and answer for one posting.
 *
 * @param {{url: string, company?: string, title?: string, postedAt?: string|null, today?: string, windowDays?: number, minSpan?: number, dataRoot?: string, historyPath?: string, portalsPath?: string}} input
 * @returns {ReturnType<typeof postingAge> | {error: 'history-absent', historyPath: string}}
 */
export function postingAgeFromHistory(input) {
  const root = input.dataRoot ?? getCareerOpsRoot();
  const historyPath = input.historyPath ?? join(root, 'data/scan-history.tsv');
  if (!existsSync(historyPath)) return { error: 'history-absent', historyPath };
  const content = readFileSync(historyPath, 'utf-8');
  const portalsPath = input.portalsPath ?? process.env.CAREER_OPS_PORTALS ?? join(root, 'portals.yml');
  return postingAge({ ...input, aggregators: loadAggregatorCompanies(portalsPath), postedAtIndex: postedAtByUrl(content) }, parseScanHistory(content));
}

/** The block the evaluator pastes into Block G and, when it applies, into `hard_stops`. */
export function renderMarkdown(result) {
  if (result.error === 'history-absent') return `## Posting age (posting-age.mjs)\n\nnot run: scan-history.tsv absent at ${result.historyPath}\n`;
  const lines = ['## Posting age (posting-age.mjs)', ''];
  lines.push(`- **URL in scan-history:** ${result.known ? `yes, first seen ${result.url_first_seen}` : 'no'}`);
  lines.push(`- **First seen:** ${result.first_seen ? `${result.first_seen} (${result.first_seen_source})` : 'unknown'}`);
  lines.push(`- **Age:** ${result.age_days === null ? 'unknown' : `${result.age_days} days as of ${result.today}`} (hard stop above ${result.thresholds.max_age_days})`);
  lines.push(`- **Repost count:** ${result.repost_count}${result.repost_cluster ? ` (cluster ${result.repost_cluster.firstSeen} → ${result.repost_cluster.lastSeen}, ${result.repost_cluster.daysSpan} days)` : ''} (hard stop at ${result.thresholds.repost_count} or more)`);
  lines.push(`- **Hard stop:** ${result.hard_stop ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('Machine Summary:');
  lines.push('```yaml');
  lines.push(`posting_first_seen: ${result.first_seen ? JSON.stringify(result.first_seen) : 'null'}`);
  lines.push(`repost_count: ${result.repost_count}`);
  lines.push('```');
  if (result.hard_stop) {
    lines.push('');
    lines.push('hard_stops entry:');
    lines.push('```yaml');
    lines.push(`  - ${JSON.stringify(result.hard_stop_entry)}`);
    lines.push('```');
  }
  return `${lines.join('\n')}\n`;
}

const USAGE = `Usage: node posting-age.mjs --url <posting url> [--company <name>] [--title <title>] [--posted-at YYYY-MM-DD]
                           [--today YYYY-MM-DD] [--format json|markdown] [--history <scan-history.tsv>]
                           [--window ${DEFAULT_WINDOW_DAYS}] [--min-span ${DEFAULT_MIN_SPAN_DAYS}]

First-seen date, age in days and repost count of one posting from data/scan-history.tsv,
with the same clustering detect-reposts.mjs uses. A posting first seen more than
${MAX_POSTING_AGE_DAYS} days ago or re-listed ${REPOST_HARD_STOP_COUNT} or more times is the evergreen hard stop of
modes/oferta.md (final_decision at most Consider). Read-only. Exit 0 with an answer
(an unknown URL is an answer), 1 when scan-history.tsv is absent, 2 on a usage error.`;

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const valueFlags = ['--url', '--company', '--title', '--posted-at', '--today', '--format', '--history', '--window', '--min-span'];
  validateFlags(args, [...valueFlags, '--help', '-h'], USAGE, { valueFlags, requireOperand: true });
  const url = flagValue(args, '--url');
  if (!url) { console.error(`Error: --url is required\n${USAGE}`); process.exit(2); }
  const format = flagValue(args, '--format') ?? 'json';
  if (!['json', 'markdown'].includes(format)) { console.error(`Error: --format must be json or markdown (got "${format}")`); process.exit(2); }
  const today = flagValue(args, '--today') ?? localToday();
  if (!parseDate(today)) { console.error(`Error: --today must be YYYY-MM-DD (got "${today}")`); process.exit(2); }
  const postedAt = flagValue(args, '--posted-at') ?? null;
  if (postedAt && !parseDate(postedAt)) { console.error(`Error: --posted-at must be YYYY-MM-DD (got "${postedAt}")`); process.exit(2); }
  const result = postingAgeFromHistory({
    url, company: flagValue(args, '--company'), title: flagValue(args, '--title'), postedAt, today,
    historyPath: flagValue(args, '--history'),
    windowDays: safeIntFlag(flagValue(args, '--window'), DEFAULT_WINDOW_DAYS),
    minSpan: safeIntFlag(flagValue(args, '--min-span'), DEFAULT_MIN_SPAN_DAYS),
  });
  process.stdout.write(format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : renderMarkdown(result));
  if (result.error === 'history-absent') process.exit(1);
}
