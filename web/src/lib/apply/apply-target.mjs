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
 * The LinkedIn job id of a posting URL, or null. The same four shapes as the
 * core's lib/linkedin-url.mjs (/jobs/view/{id}, /jobs/view/{slug}-{id},
 * /comm/jobs/view/{id}, ?currentJobId=), restated because suites under
 * web/tests run on web/ alone. Digits only, LinkedIn hosts only.
 * @param {string} url
 * @returns {string|null}
 */
export function linkedInPostingId(url) {
  let u;
  try {
    u = new URL(String(url ?? ""));
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/.test(u.hostname)) return null;
  const path = u.pathname.match(/^\/(?:jobs\/view\/(?:.*-)?|comm\/jobs\/view\/)(\d+)\/?$/);
  if (path) return path[1];
  const current = u.searchParams.get("currentJobId");
  return current && /^\d+$/.test(current) ? current : null;
}

function hostOf(url) {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * Where Apply goes.
 *
 * `linkedinApply` is the posting's entry from the core's data/linkedin-apply.json
 * (lib/linkedin-apply.mjs), which the LinkedIn crawl and linkedin-apply.mjs fill:
 *   - an employer URL: the proxy opens the employer's own form, and the LinkedIn
 *     link stays beside it as `boardUrl`;
 *   - Easy Apply: LinkedIn is where the application happens, so it opens there;
 *   - nothing usable yet: "resolve", the page offers to look the form up.
 * Other login-gated boards open directly, as before.
 *
 * @param {string | undefined | null} url
 * @param {{ applyUrl?: string, kind?: string } | null} [linkedinApply]
 * @returns {{ kind: "none" }
 *   | { kind: "proxy", host: string, url?: string, boardUrl?: string, boardHost?: string }
 *   | { kind: "direct", host: string, easyApply?: boolean }
 *   | { kind: "resolve", host: string }}
 */
export function applyTarget(url, linkedinApply = null) {
  if (!url || !/^https?:\/\//i.test(url)) return { kind: "none" };
  let host;
  try {
    host = hostOf(url);
  } catch {
    return { kind: "none" };
  }
  if (!isLoginGatedBoard(url)) return { kind: "proxy", host };
  if (!linkedInPostingId(url)) return { kind: "direct", host };
  const employer = linkedinApply?.applyUrl;
  if (employer && /^https?:\/\//i.test(employer) && !isLoginGatedBoard(employer)) {
    try {
      return { kind: "proxy", host: hostOf(employer), url: employer, boardUrl: url, boardHost: host };
    } catch {
      /* unparseable stored URL: treat as not found */
    }
  }
  if (linkedinApply?.kind === "easy-apply") return { kind: "direct", host, easyApply: true };
  return { kind: "resolve", host };
}

/** The session route's refusal when a login-gated board URL is pasted into the Apply page. */
export function loginGatedRefusal(host) {
  const lookup = /(^|\.)linkedin\.com$/.test(host) ? " For a LinkedIn posting, the Apply button on its report page can look up the employer's form." : "";
  return `This is a ${host} listing. ${host} shows its Apply flow only to a signed-in member, so career-ops can't read it here. Open it in your browser, or find the same role on the employer's careers page and paste that application URL.${lookup}`;
}
