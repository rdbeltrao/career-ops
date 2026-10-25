/**
 * login-wall.mjs - decide whether a page the Apply proxy opened is a sign-in
 * wall rather than an application form.
 *
 * Plain .mjs with no imports so `node --test` can load it, like exit.mjs.
 *
 * Why this exists: the application-form heuristic in session.ts accepts any page
 * with an email field, and a login form has one. A LinkedIn posting opened in a
 * fresh, signed-out browser lands on the LinkedIn sign-in page, which the proxy
 * then re-rendered and handed to the planner to pre-fill. This check runs first,
 * so a login form is never claimed as an application.
 */

/**
 * A login, sign-up, account or auth-wall route. Matched as a whole path segment,
 * so a role slug like "authentication-engineer" or "accountant" does not count.
 * The word list is the one classifyEmpty() has always used, plus LinkedIn's own
 * wall routes (authwall, checkpoint, uas/login).
 */
export const LOGIN_URL_RE = /\/(login|log-in|sign-?in|register|sign-?up|auth|authwall|account|accounts|mfa|2fa|checkpoint|uas)(\/|$|\?|#)/i;

/** A field whose label asks for a password, in the languages the forms arrive in. */
const PASSWORD_LABEL_RE = /\b(password|passwort|kennwort|mot de passe|contrase[nñ]a|senha|wachtwoord|has[lł]o)\b/i;

export const LOGIN_WALL_MESSAGE =
  "This page wants you to sign in or create an account first. Open it directly, log in, then paste the actual application-form URL here.";

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isLoginUrl(url) {
  let path;
  try {
    const u = new URL(url);
    path = `${u.pathname}${u.search}`;
  } catch {
    return false;
  }
  return LOGIN_URL_RE.test(path);
}

/**
 * @param {{ url?: string, hasPassword?: boolean, fields?: { label?: string }[] }} page
 * `hasPassword` is whether any frame holds an <input type="password">. `fields`
 * are the extracted fields; extract.ts maps a password input to type "text", so
 * its label is the fallback signal.
 * @returns {boolean}
 */
export function isLoginWall({ url = "", hasPassword = false, fields = [] } = {}) {
  if (hasPassword) return true;
  if (fields.some((f) => PASSWORD_LABEL_RE.test(f?.label ?? ""))) return true;
  return isLoginUrl(url);
}
