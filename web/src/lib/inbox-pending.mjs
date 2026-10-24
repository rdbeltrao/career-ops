import { normalizeUrl } from "./core/url-key.mjs";

/**
 * The comparison key of an inbox or report URL: the canonical URL when it is
 * an http(s) posting, else the trimmed string itself.
 * @param {string} url
 * @returns {string}
 */
export function inboxKey(url) {
  const s = String(url ?? "").trim();
  return normalizeUrl(s) || s;
}

/**
 * Pending inbox postings: not done, not evaluated, one per posting.
 *
 * pipeline.md can list the same posting twice, and a posting can be under
 * Pending while a report for it already exists (an evaluation path that did
 * not move the row, a URL that differs by a tracking parameter or a trailing
 * slash). Both are keyed with the same posting key the core uses
 * (url-key.mjs mirror), so the header count, the tab count and the triage
 * list agree on one number and the INBOX shows only postings that still need
 * an evaluation.
 *
 * @template {{ url: string, done: boolean }} T
 * @param {T[]} inbox
 * @param {Iterable<string>} [evaluatedKeys] posting keys (inboxKey) that already have a report
 * @returns {T[]}
 */
export function pendingInbox(inbox, evaluatedKeys = new Set()) {
  const evaluated = evaluatedKeys instanceof Set ? evaluatedKeys : new Set(evaluatedKeys);
  const seen = new Set();
  const out = [];
  for (const j of inbox) {
    const key = inboxKey(j.url);
    if (j.done || seen.has(key) || evaluated.has(key)) continue;
    seen.add(key);
    out.push(j);
  }
  return out;
}
