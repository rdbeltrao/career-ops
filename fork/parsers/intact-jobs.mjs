#!/usr/bin/env node
/**
 * fork/parsers/intact-jobs.mjs — local parser for Intact's own careers page.
 *
 * Intact (intact-systems.com) lists its open positions on a WordPress page
 * with one `<h3 class="headline">` per role and no applicant tracking system:
 * applications go by email. This parser prints the roles in the
 * jobs-json-v1 shape scan.mjs expects (see docs/local-parser-cookbook.md).
 *
 *   node fork/parsers/intact-jobs.mjs [careers_url]
 */

const DEFAULT_URL = 'https://intact-systems.com/company/careers/';
const LOCATION = 'Lebring, Austria';

const url = process.argv[2] || DEFAULT_URL;
const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (career-ops local parser)' }, signal: AbortSignal.timeout(20_000) });
if (!res.ok) {
  console.error(`intact-jobs: HTTP ${res.status} from ${url}`);
  process.exit(1);
}
const html = await res.text();
const seen = new Set();
const jobs = [];
for (const match of html.matchAll(/<h3 class="headline">([^<]+)<\/h3>/g)) {
  const title = match[1]
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
  if (!title || seen.has(title)) continue;
  seen.add(title);
  const anchor = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  jobs.push({ title, url: `${url}#${anchor}`, location: LOCATION });
}
process.stdout.write(JSON.stringify({ jobs }) + '\n');
