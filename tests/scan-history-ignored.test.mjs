// tests/scan-history-ignored.test.mjs — a posting the user ignored stays out.
//
// The web Explore page's Ignore button writes a `skipped_ignored` row to
// data/scan-history.tsv. Every scanner, the Explore dry run included, builds its
// seen-set through collectSeenUrls, so that row must pin the URL. And it must
// pin it for good: `scan_history.recheck_after_days` releases old `added` and
// `skipped_expired` rows, but the user decided against this posting, so the
// window must not bring it back.
import { pass, fail } from './helpers.mjs';
import { IGNORED_SCAN_HISTORY_STATUS, shouldDedupScanHistoryRow, collectSeenUrls, unrecordedOffers, normalizeUrlForDedup } from '../scan.mjs';

console.log('\nscan.mjs — skipped_ignored pins a posting permanently');

const HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation';
const IGNORED = 'https://jobs.ashbyhq.com/acme/1111';
const OLD_ADDED = 'https://jobs.ashbyhq.com/acme/2222';
const POLICY = { recheckAfterDays: 30, today: '2026-10-25' };

if (IGNORED_SCAN_HISTORY_STATUS === 'skipped_ignored') {
  pass('IGNORED_SCAN_HISTORY_STATUS is skipped_ignored, the status modes/scan.md documents');
} else {
  fail(`IGNORED_SCAN_HISTORY_STATUS is ${JSON.stringify(IGNORED_SCAN_HISTORY_STATUS)}, expected "skipped_ignored"`);
}

if (shouldDedupScanHistoryRow({ firstSeen: '2025-01-01', status: 'skipped_ignored' }, POLICY)) {
  pass('an ignored row older than recheck_after_days still dedups');
} else {
  fail('recheck_after_days released an ignored row, so the posting would come back');
}

const { seen } = collectSeenUrls({
  scanHistoryText: [
    HEADER,
    `${IGNORED}\t2025-01-01\tashby\tEngineering Lead\tAcme\tskipped_ignored\tRemote`,
    `${OLD_ADDED}\t2025-01-01\tashby\tEngineering Lead\tAcme\tadded\tRemote`,
    '',
  ].join('\n'),
}, POLICY);

if (seen.has(normalizeUrlForDedup(IGNORED))) {
  pass('collectSeenUrls pins an ignored URL past the recheck window');
} else {
  fail('collectSeenUrls did not pin the ignored URL, so the next scan would surface it again');
}
if (!seen.has(normalizeUrlForDedup(OLD_ADDED))) {
  pass('an old added row is still released by the same window (control)');
} else {
  fail('control failed: the old added row was not released, so this test proves nothing about the window');
}

const history = [HEADER, `${IGNORED}\t2026-10-20\tashby\tEngineering Lead\tAcme\tskipped_ignored\tRemote`, ''].join('\n');
const fresh = unrecordedOffers([{ url: IGNORED }, { url: OLD_ADDED }], 'skipped_ignored', history);
if (fresh.length === 1 && fresh[0].url === OLD_ADDED) {
  pass('ignoring a posting twice writes one skipped_ignored row');
} else {
  fail(`unrecordedOffers returned ${JSON.stringify(fresh)}, expected only ${OLD_ADDED}`);
}
