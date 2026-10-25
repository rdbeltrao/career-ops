/**
 * apply-target.mjs - decide where the Apply button sends a posting.
 *
 * Plain .mjs with no imports so `node --test` can load it.
 *
 * Two destinations:
 *   - "proxy": the in-app form proxy (/apply), which opens the posting in a
 *     local browser, follows its Apply link to the employer form, re-renders it
 *     and pre-fills it. Right for an ATS, an employer careers page, and the many
 *     boards that link out to the employer without a login.
 *   - "direct": the user's own browser. Right only for a board whose Apply flow
 *     needs a signed-in member. The proxy's browser is a fresh, signed-out one,
 *     so on such a board it ends at the board's login page.
 *
 * JUDGMENT: a dedicated list, not the core's isAggregatorUrl. That set exists
 * for tracker dedup and also holds boards that link out to the employer with
 * no login (remoteok, himalayas, builtin, ...); sending those to the browser
 * would take the proxy away from rows it handles today.
 */

// JUDGMENT: the six primary boards url-key.mjs names, whose own Apply ("Easy
// Apply", "1-Click") runs on a member account. Kept short on purpose: a board
// missing here still goes through the proxy, and the login-wall check stops it
// at the sign-in page, so a miss costs a clear message, not a re-rendered login
// form. Matched on any TLD and subdomain (glassdoor.de, uk.indeed.com), never as
// a substring of another name.
const LOGIN_GATED_BOARD_RE = /(^|\.)(linkedin|indeed|glassdoor|ziprecruiter|wellfound|dice)\.[a-z.]+$/i;

/** @param {string} url */
export function isLoginGatedBoard(url) {
  try {
    return LOGIN_GATED_BOARD_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * @param {string | undefined | null} url
 * @returns {{ kind: "none" } | { kind: "direct" | "proxy", host: string }}
 */
export function applyTarget(url) {
  if (!url || !/^https?:\/\//i.test(url)) return { kind: "none" };
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { kind: "none" };
  }
  return { kind: isLoginGatedBoard(url) ? "direct" : "proxy", host };
}

/** The session route's refusal when a login-gated board URL is pasted into the Apply page. */
export function loginGatedRefusal(host) {
  return `This is a ${host} listing. ${host} shows its Apply flow only to a signed-in member, so career-ops can't read it here. Open it in your browser, or find the same role on the employer's careers page and paste that application URL.`;
}
