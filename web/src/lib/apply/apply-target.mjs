/**
 * apply-target.mjs - decide where the Apply button sends a posting.
 *
 * Plain .mjs with no imports so `node --test` can load it.
 *
 * Two destinations:
 *   - "proxy": the in-app form proxy (/apply), which opens the employer form in a
 *     local browser, re-renders it and pre-fills it. Right for an ATS or an
 *     employer careers page.
 *   - "direct": the user's own browser. Right for a job board. A board shows its
 *     "Apply" flow only to a signed-in member, and the proxy's browser is a fresh,
 *     signed-out one: it wandered into the board's login page and re-rendered
 *     that as if it were the application.
 *
 * Which hosts are boards is the core's call (url-key.mjs isAggregatorUrl, the
 * same list the tracker dedup uses), injected by the server. The built-in list
 * below is only the fallback for a core too old to export it.
 */

// JUDGMENT: the fallback names the six boards url-key.mjs adds on top of the
// shared scraper list, matched on any TLD (glassdoor.de, uk.indeed.com), because
// those are the ones that gate their Apply flow behind a member login.
const FALLBACK_BOARD_RE = /(^|\.)(linkedin|indeed|glassdoor|ziprecruiter|wellfound|dice)\.[a-z.]+$/i;

/** @param {string} url */
export function fallbackIsJobBoard(url) {
  try {
    return FALLBACK_BOARD_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * @param {string | undefined | null} url
 * @param {(url: string) => boolean} isAggregatorUrl
 * @returns {{ kind: "none" } | { kind: "direct" | "proxy", host: string }}
 */
export function applyTarget(url, isAggregatorUrl) {
  if (!url || !/^https?:\/\//i.test(url)) return { kind: "none" };
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { kind: "none" };
  }
  let board;
  try {
    board = isAggregatorUrl(url) === true;
  } catch {
    board = fallbackIsJobBoard(url);
  }
  return { kind: board ? "direct" : "proxy", host };
}

/** The session route's refusal when a board URL is pasted into the Apply page. */
export function aggregatorRefusal(host) {
  return `This is a ${host} listing. Job boards only show their Apply flow to a signed-in member, so career-ops can't read it here. Open it in your browser, or find the same role on the employer's careers page and paste that application URL.`;
}
