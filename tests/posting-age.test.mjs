// tests/posting-age.test.mjs — posting-age.mjs turns the evergreen /
// re-listed hard stop of modes/oferta.md into data: first-seen date, age in
// days and repost count from a scan-history.tsv, with the same clustering
// detect-reposts.mjs uses. Read-only; exit 0 with an answer, 1 when the
// history is absent.
//
// Run:  node --test tests/posting-age.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_POSTING_AGE_DAYS, REPOST_HARD_STOP_COUNT, postingAge, postingAgeFromHistory, postedAtByUrl, renderMarkdown } from '../posting-age.mjs';
import { parseScanHistory } from '../detect-reposts.mjs';
import { SCAN_HISTORY_COLUMNS } from '../lib/scan-history-columns.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'posting-age.mjs');
const TODAY = '2026-11-09';

/** One scan-history line by column name; unnamed columns are empty. */
function line(cells) {
  return SCAN_HISTORY_COLUMNS.map((name) => cells[name] ?? '').join('\t');
}

const HISTORY = [
  SCAN_HISTORY_COLUMNS.join('\t'),
  // Acme re-lists one Backend Engineer requisition three times under three URLs.
  line({ url: 'https://boards.greenhouse.io/acme/jobs/100', first_seen: '2026-07-01', portal: 'greenhouse', title: 'Backend Engineer', company: 'Acme', status: 'added', location: 'Berlin' }),
  line({ url: 'https://boards.greenhouse.io/acme/jobs/200', first_seen: '2026-08-15', portal: 'greenhouse', title: 'Backend Engineer', company: 'Acme', status: 'added', location: 'Berlin' }),
  line({ url: 'https://boards.greenhouse.io/acme/jobs/300', first_seen: '2026-09-20', portal: 'greenhouse', title: 'Engineer, Backend', company: 'Acme Inc.', status: 'added', location: 'Berlin' }),
  // Globex posted one role once, two weeks ago, with an ATS posted_at.
  line({ url: 'https://jobs.lever.co/globex/abc', first_seen: '2026-10-26', portal: 'lever', title: 'Engineering Manager', company: 'Globex', status: 'added', location: 'Remote', posted_at: '2026-10-20T09:00:00Z' }),
  // Initech: an old sighting the scanner dropped, never evidence of a listing.
  line({ url: 'https://jobs.lever.co/initech/old', first_seen: '2026-01-01', portal: 'lever', title: 'Platform Lead', company: 'Initech', status: 'skipped_expired', location: 'Remote' }),
  // Umbrella: two city variants listed in one sweep are siblings, not a repost.
  line({ url: 'https://jobs.ashbyhq.com/umbrella/1', first_seen: '2026-10-30', portal: 'ashby', title: 'Data Engineer - Munich', company: 'Umbrella', status: 'added', location: 'Munich' }),
  line({ url: 'https://jobs.ashbyhq.com/umbrella/2', first_seen: '2026-10-30', portal: 'ashby', title: 'Data Engineer - Berlin', company: 'Umbrella', status: 'added', location: 'Berlin' }),
  '',
].join('\n');

const rows = parseScanHistory(HISTORY);
const postedAtIndex = postedAtByUrl(HISTORY);

test('a URL the history knows: first seen from its row, age from today, repost count from the detector cluster', () => {
  const r = postingAge({ url: 'https://boards.greenhouse.io/acme/jobs/300?utm_source=linkedin', company: 'Acme', title: 'Backend Engineer', today: TODAY, postedAtIndex }, rows);
  assert.equal(r.known, true, 'tracking params do not hide the row');
  assert.equal(r.url_first_seen, '2026-09-20');
  assert.equal(r.first_seen, '2026-07-01', 'the requisition is as old as its earliest same-identity listing');
  assert.equal(r.first_seen_source, 'scan-history title identity');
  assert.equal(r.age_days, 131);
  assert.equal(r.repost_count, 3, 'Acme Inc. and Acme cluster on one key; "Engineer, Backend" shares the title identity');
  assert.deepEqual(r.repost_cluster.appearances.map((a) => a.date), ['2026-07-01', '2026-08-15', '2026-09-20']);
  assert.equal(r.hard_stop, true);
  assert.match(r.hard_stop_entry, /first posted 2026-07-01 .*131 days before 2026-11-09; re-listed 3 times/);
  assert.match(r.hard_stop_entry, /capped at Consider/);
});

test('a recent single listing is no hard stop; posted_at from the ATS wins over the scan date when earlier', () => {
  const r = postingAge({ url: 'https://jobs.lever.co/globex/abc', today: TODAY, postedAtIndex }, rows);
  assert.equal(r.known, true);
  assert.equal(r.company, 'Globex', 'company and title fall back to the URL row');
  assert.equal(r.title, 'Engineering Manager');
  assert.equal(r.first_seen, '2026-10-20');
  assert.equal(r.first_seen_source, 'scan-history posted_at');
  assert.equal(r.age_days, 20);
  assert.equal(r.repost_count, 1, 'listed once, so no cluster, count 1');
  assert.equal(r.hard_stop, false);
  assert.equal(r.hard_stop_entry, null);
});

test('an unknown URL with no company or title: nothing is known, nothing is invented', () => {
  const r = postingAge({ url: 'https://example.com/jobs/unknown', today: TODAY, postedAtIndex }, rows);
  assert.equal(r.known, false);
  assert.equal(r.first_seen, null);
  assert.equal(r.age_days, null);
  assert.equal(r.repost_count, 0);
  assert.equal(r.hard_stop, false);
  assert.equal(r.company, null);
});

test('an unknown URL still finds the requisition through company and title identity', () => {
  const r = postingAge({ url: 'https://www.linkedin.com/jobs/view/999', company: 'Acme', title: 'Backend Engineer', today: TODAY, postedAtIndex }, rows);
  assert.equal(r.known, false);
  assert.equal(r.first_seen, '2026-07-01');
  assert.equal(r.repost_count, 3);
  assert.equal(r.hard_stop, true);
});

test('the JD\'s own posting date counts when it is the earliest; a dropped sighting never does', () => {
  const stated = postingAge({ url: 'https://jobs.lever.co/globex/abc', postedAt: '2026-08-01', today: TODAY, postedAtIndex }, rows);
  assert.equal(stated.first_seen, '2026-08-01');
  assert.equal(stated.first_seen_source, 'jd posted_at');
  assert.equal(stated.age_days, 100);
  assert.equal(stated.hard_stop, true, 'age alone is a hard stop');
  assert.equal(stated.repost_count, 1);
  const dropped = postingAge({ url: 'https://jobs.lever.co/initech/old', today: TODAY, postedAtIndex }, rows);
  assert.equal(dropped.known, false, 'a skipped_expired row is not a listing');
  assert.equal(dropped.first_seen, null);
});

test('sibling requisitions listed in one sweep are not a repost cluster', () => {
  const r = postingAge({ url: 'https://jobs.ashbyhq.com/umbrella/1', today: TODAY, postedAtIndex }, rows);
  assert.equal(r.repost_count, 1);
  assert.equal(r.repost_cluster, null);
  assert.equal(r.age_days, 10);
  assert.equal(r.hard_stop, false);
});

test('thresholds are the ones the mode text states and sit exactly on the boundary', () => {
  assert.equal(MAX_POSTING_AGE_DAYS, 60);
  assert.equal(REPOST_HARD_STOP_COUNT, 3);
  const onEdge = postingAge({ url: 'https://jobs.lever.co/globex/abc', postedAt: '2026-09-10', today: TODAY, postedAtIndex }, rows);
  assert.equal(onEdge.age_days, 60);
  assert.equal(onEdge.hard_stop, false, 'exactly 60 days is not "more than 60"');
  const over = postingAge({ url: 'https://jobs.lever.co/globex/abc', postedAt: '2026-09-09', today: TODAY, postedAtIndex }, rows);
  assert.equal(over.age_days, 61);
  assert.equal(over.hard_stop, true);
});

test('markdown output carries the Machine Summary fields and, on a hard stop, the ready hard_stops entry', () => {
  const stop = renderMarkdown(postingAge({ url: 'https://boards.greenhouse.io/acme/jobs/300', today: TODAY, postedAtIndex }, rows));
  assert.match(stop, /^## Posting age \(posting-age\.mjs\)/);
  assert.match(stop, /posting_first_seen: "2026-07-01"/);
  assert.match(stop, /repost_count: 3/);
  assert.match(stop, /hard_stops entry:/);
  assert.match(stop, /- "Evergreen or re-listed requisition \(posting-age\.mjs\)/);
  const clean = renderMarkdown(postingAge({ url: 'https://example.com/jobs/unknown', today: TODAY, postedAtIndex }, rows));
  assert.match(clean, /posting_first_seen: null/);
  assert.match(clean, /repost_count: 0/);
  assert.doesNotMatch(clean, /hard_stops entry/);
  assert.match(renderMarkdown({ error: 'history-absent', historyPath: '/x/data/scan-history.tsv' }), /not run: scan-history\.tsv absent/);
});

test('CLI: reads the data root history, honours --history, exits 1 when the file is absent, 2 on usage errors', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'posting-age-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'data'));
  const env = { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_TRACKER: '' };

  const absent = spawnSync(process.execPath, [CLI, '--url', 'https://example.com/jobs/1', '--format', 'markdown'], { env, encoding: 'utf8' });
  assert.equal(absent.status, 1);
  assert.match(absent.stdout, /not run: scan-history\.tsv absent/);

  writeFileSync(join(root, 'data/scan-history.tsv'), HISTORY);
  const json = spawnSync(process.execPath, [CLI, '--url', 'https://boards.greenhouse.io/acme/jobs/200', '--today', TODAY], { env, encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.first_seen, '2026-07-01');
  assert.equal(parsed.repost_count, 3);
  assert.equal(parsed.hard_stop, true);

  const other = join(root, 'elsewhere.tsv');
  writeFileSync(other, [SCAN_HISTORY_COLUMNS.join('\t'), line({ url: 'https://example.com/jobs/1', first_seen: '2026-11-01', portal: 'x', title: 'T', company: 'C', status: 'added' }), ''].join('\n'));
  const viaFlag = spawnSync(process.execPath, [CLI, '--url', 'https://example.com/jobs/1', '--history', other, '--today', TODAY, '--format', 'markdown'], { env, encoding: 'utf8' });
  assert.equal(viaFlag.status, 0, viaFlag.stderr);
  assert.match(viaFlag.stdout, /First seen:\*\* 2026-11-01/);
  assert.match(viaFlag.stdout, /Hard stop:\*\* no/);

  const noUrl = spawnSync(process.execPath, [CLI, '--today', TODAY], { env, encoding: 'utf8' });
  assert.equal(noUrl.status, 2);
  assert.match(noUrl.stderr, /--url is required/);
  const badFormat = spawnSync(process.execPath, [CLI, '--url', 'https://x.test/1', '--format', 'xml'], { env, encoding: 'utf8' });
  assert.equal(badFormat.status, 2);
  const badDate = spawnSync(process.execPath, [CLI, '--url', 'https://x.test/1', '--today', '2026-13-40'], { env, encoding: 'utf8' });
  assert.equal(badDate.status, 2);
  const help = spawnSync(process.execPath, [CLI, '--help'], { env, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: node posting-age\.mjs/);

  const lib = postingAgeFromHistory({ url: 'https://boards.greenhouse.io/acme/jobs/100', dataRoot: root, today: TODAY });
  assert.equal(lib.repost_count, 3);
  assert.deepEqual(postingAgeFromHistory({ url: 'https://x.test/1', dataRoot: root, historyPath: join(root, 'missing.tsv') }), { error: 'history-absent', historyPath: join(root, 'missing.tsv') });
});
