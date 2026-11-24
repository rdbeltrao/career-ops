// Which discovered offers count as "already evaluated" for the Explore /
// "new matches" supply loop (api/whats-new).
//
// Pure JS (no TS types) so it can be imported by the route AND by a
// `node --test` unit test, matching funnel-tiles.mjs / status-alias.mjs /
// clean-chips.mjs — web's test script is `node --test tests/**/*.test.mjs`
// and there is no TS runner.
//
// THE KEY IS COMPANY **AND** ROLE (#3131). Suppressing by employer alone meant
// one evaluated role removed that employer's entire board from Explore,
// permanently, including postings first seen afterwards. An employer with 20+
// live roles went completely invisible after evaluating one of them, and the
// scanner was working throughout — the rows were in scan-history.tsv, only the
// view hid them. "No new matches" then reads identically to "matches exist but
// are suppressed", which is what makes it hard to notice.
//
// The trade is deliberate and in the safer direction. If the tracker's role
// text and the scan-history title drift apart ("Staff SWE" vs "Staff Software
// Engineer"), an already-evaluated role can reappear in Explore once: a
// VISIBLE false positive the user can dismiss. What it replaces is a silent
// false negative — a board the user cannot see and gets no signal about.
//
// The normalizer is injected rather than imported, because the route resolves
// the CORE's normalizeTextKey from the user's own checkout (lib/core/text-key)
// so web dedup always matches CLI dedup. A second key helper here is exactly
// the local reimplementation #2666 removed.

import { inboxKey } from "./inbox-pending.mjs";
import { postingHref } from "./posting-url.mjs";

/**
 * Suppression key for one company/role pair.
 *
 * A tracker row with no role yields "company|", which matches only a scan row
 * that also has no title — so a backfilled, role-less row (#1799) suppresses
 * that one shape rather than the whole employer.
 *
 * @param {(value: unknown, separator?: string) => string} norm - Core key fn.
 * @param {string} company
 * @param {string} role
 * @returns {string}
 */
export function suppressionKey(norm, company, role) {
  return `${norm(company, " ")}|${norm(role, " ")}`;
}

/**
 * Keys for every evaluated application.
 *
 * Rows whose company normalizes to nothing are dropped: they cannot identify
 * an employer, and keeping them would let one blank row suppress every scan
 * row whose company is also unkeyable.
 *
 * @param {{company: string, role: string}[]} applications
 * @param {(value: unknown, separator?: string) => string} norm
 * @returns {Set<string>}
 */
export function evaluatedKeys(applications, norm) {
  const keys = new Set();
  for (const app of applications ?? []) {
    if (!norm(app?.company, " ")) continue;
    keys.add(suppressionKey(norm, app?.company ?? "", app?.role ?? ""));
  }
  return keys;
}

/**
 * Has this discovered offer already been evaluated?
 *
 * @param {Set<string>} keys - From evaluatedKeys().
 * @param {(value: unknown, separator?: string) => string} norm
 * @param {string} company - Scan-history company cell.
 * @param {string} title - Scan-history title cell.
 * @returns {boolean}
 */
export function isEvaluated(keys, norm, company, title) {
  if (!company || !norm(company, " ")) return false;
  return keys.has(suppressionKey(norm, company, title));
}

// ── Posting-URL suppression ────────────────────────────────────────────────
//
// Company+role text is the fallback, not the main key. It misses most postings
// the user has already handled, because the three sources spell them
// differently: scan-history stores the board slug ("crownholdings") while the
// tracker holds the display name ("Crown Holdings"), titles get reworded
// ("SW Engineering Lead" vs "Software Engineering Lead"), and a LinkedIn row
// whose employer was hidden is tracked as "?". Every one of those resurfaced as
// a "new match" although it had a tracker row and a processed pipeline entry.
//
// The posting URL is the key all of them share: the tracker's URL column and
// pipeline.md (the route adds report **URL:** headers via evaluatedPostingKeys). It is compared through inboxKey(),
// the same canonical key the pipeline page uses, so tracking parameters and a
// trailing slash do not break a match, and two postings on one board stay two.
//
// Pending pipeline rows do NOT suppress. The scanner writes every match there,
// so a pending row is exactly a scanned, not-yet-evaluated posting: what this
// feed exists to show. Only a processed ([x]) row means the user dealt with it.

/**
 * Canonical keys of every posting the user has already handled.
 *
 * @param {{
 *   applications?: {url?: string}[],
 *   inbox?: {url?: string, done?: boolean}[],
 * }} [sources]
 * @returns {Set<string>}
 */
export function handledPostingKeys({ applications = [], inbox = [] } = {}) {
  const keys = new Set();
  const add = (url) => {
    if (url && /^https?:\/\//i.test(url)) keys.add(inboxKey(url));
  };
  for (const app of applications ?? []) add(postingHref(app?.url));
  for (const job of inbox ?? []) if (job?.done) add(String(job?.url ?? "").trim());
  return keys;
}

/**
 * Has the user already handled this posting (tracker row or a processed
 * pipeline row)?
 *
 * @param {Set<string>} keys - From handledPostingKeys().
 * @param {string} url - Scan-history URL cell.
 * @returns {boolean}
 */
export function isHandledPosting(keys, url) {
  const value = String(url ?? "").trim();
  if (!value) return false;
  return keys.has(inboxKey(value));
}
