/**
 * lib/linkedin-session.mjs — is the LinkedIn crawl profile signed in, and what
 * did the last crawl find?
 *
 * FORK-LOCAL, like providers.local/linkedin-browser.mjs.
 *
 * Session: read from the crawl profile's own Chromium cookie database
 * (`{profile}/Default/Cookies`, SQLite). Only cookie NAMES and timestamps are
 * read, never a value, and from a temporary copy, so a running browser holding
 * the file is never disturbed. LinkedIn's session cookie is `li_at`; it carries
 * a one-year expiry, so a live cookie alone does not prove LinkedIn still
 * accepts it. The crawl status settles that: a crawl that hit the login wall
 * after the cookie was set means a new sign-in is needed.
 *
 * Crawl status: `{DATA_ROOT}/data/linkedin-status.json`, written by the
 * provider after each search: `{ result, search, jobs, message, at }` with
 * result `ok`, `login-required` or `error`.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const CRAWL_STATUS_FILE = join('data', 'linkedin-status.json');
const RESULTS = new Set(['ok', 'login-required', 'error']);
const SESSION_COOKIE = 'li_at';
// Chromium stores times as microseconds since 1601-01-01 UTC.
const EPOCH_1601_S = 11644473600;

/** The persistent Chromium profile the crawl uses: LINKEDIN_PROFILE_DIR, else ~/.job-hunt/browser-profile. */
export function profileDir() {
  const env = process.env.LINKEDIN_PROFILE_DIR?.trim();
  return env || join(homedir(), '.job-hunt', 'browser-profile');
}

/**
 * node:sqlite, loaded on first use. Node prints a one-time "SQLite is an
 * experimental feature" warning when it loads; the web dev server forwards
 * every server warning to the page as an error, so that one warning is
 * dropped while the module loads and every other warning still goes through.
 */
function loadSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (/SQLite is an experimental feature/.test(String(warning?.message ?? warning))) return;
    return emit.call(process, warning, ...rest);
  };
  try {
    return process.getBuiltinModule('node:sqlite');
  } finally {
    process.emitWarning = emit;
  }
}

/**
 * Whether a browser holds the profile right now. Chromium marks a profile in
 * use with `SingletonLock`, a symlink to "<hostname>-<pid>" whose target does
 * not exist, so existsSync() (which follows links) never sees it. A lock whose
 * process is gone on this machine is a crash leftover and does not count; a
 * lock from another machine cannot be checked, so it counts.
 * @param {string} [dir]
 */
export function profileBusy(dir = profileDir()) {
  const lock = join(dir, 'SingletonLock');
  let stat;
  try {
    stat = lstatSync(lock);
  } catch {
    return false;
  }
  if (!stat.isSymbolicLink()) return true;
  let target = '';
  try {
    target = readlinkSync(lock);
  } catch {
    return true;
  }
  const m = /^(.*)-(\d+)$/.exec(target);
  if (!m || m[1] !== hostname()) return true;
  try {
    process.kill(Number(m[2]), 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const iso = (seconds) => (Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : '');

/**
 * LinkedIn cookies in the profile: names, hosts and times, never values.
 * @param {string} [dir]
 * @returns {{ exists: boolean, cookies: { name: string, host: string, createdAt: string, expiresAt: string }[], error?: string }}
 */
export function readSessionCookies(dir = profileDir()) {
  // Default/Cookies on macOS and Linux; Default/Network/Cookies on Windows.
  const file = [join(dir, 'Default', 'Cookies'), join(dir, 'Default', 'Network', 'Cookies')].find((f) => existsSync(f));
  if (!file) return { exists: false, cookies: [] };
  let tmp = null;
  try {
    tmp = mkdtempSync(join(tmpdir(), 'li-cookies-'));
    // The browser may hold the database and its write-ahead log; read a copy of both.
    copyFileSync(file, join(tmp, 'Cookies'));
    for (const side of ['-wal', '-journal']) if (existsSync(`${file}${side}`)) copyFileSync(`${file}${side}`, join(tmp, `Cookies${side}`));
    const { DatabaseSync } = loadSqlite();
    // Not read-only: a copy taken while the browser writes carries a hot
    // journal that SQLite must roll back first. The copy is private and thrown away.
    const db = new DatabaseSync(join(tmp, 'Cookies'));
    try {
      const rows = db.prepare(
        `SELECT name, host_key AS host,
                CAST(creation_utc / 1000000 AS INTEGER) - ${EPOCH_1601_S} AS created,
                CAST(expires_utc / 1000000 AS INTEGER) - ${EPOCH_1601_S} AS expires
           FROM cookies
          WHERE (host_key = 'linkedin.com' OR host_key LIKE '%.linkedin.com') AND name = ?`,
      ).all(SESSION_COOKIE);
      return { exists: true, cookies: rows.map((r) => ({ name: r.name, host: r.host, createdAt: iso(Number(r.created)), expiresAt: iso(Number(r.expires)) })) };
    } finally {
      db.close();
    }
  } catch (err) {
    return { exists: true, cookies: [], error: err.message };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * @param {{ profileDir?: string, crawl?: { result: string, at: string } | null, now?: Date }} [opts]
 * @returns {{ state: 'signed-in'|'sign-in-needed'|'expired'|'signed-out'|'no-profile'|'unknown',
 *             busy: boolean, signedInAt: string, expiresAt: string, message: string }}
 */
export function sessionStatus({ profileDir: dir = profileDir(), crawl = null, now = new Date() } = {}) {
  const busy = profileBusy(dir);
  const read = readSessionCookies(dir);
  const base = { busy, signedInAt: '', expiresAt: '' };
  if (!read.exists) return { ...base, state: 'no-profile', message: 'The crawl browser profile does not exist yet. Sign in once to create it.' };
  if (read.error) return { ...base, state: 'unknown', message: `The profile's cookies could not be read (${read.error}).` };
  const latest = read.cookies.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!latest) return { ...base, state: 'signed-out', message: 'The crawl profile is not signed in to LinkedIn.' };
  const info = { ...base, signedInAt: latest.createdAt, expiresAt: latest.expiresAt };
  if (latest.expiresAt && new Date(latest.expiresAt) <= now) return { ...info, state: 'expired', message: 'The LinkedIn session in the crawl profile has expired.' };
  if (crawl?.result === 'login-required' && crawl.at && latest.createdAt && new Date(crawl.at) > new Date(latest.createdAt)) {
    return { ...info, state: 'sign-in-needed', message: 'The last crawl was sent to LinkedIn\'s login page, so LinkedIn no longer accepts this session.' };
  }
  return { ...info, state: 'signed-in', message: 'The crawl profile is signed in to LinkedIn.' };
}

/** @param {string} root The data root. */
export function readCrawlStatus(root) {
  const file = join(root, CRAWL_STATUS_FILE);
  if (!existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return s && RESULTS.has(s.result) ? s : null;
  } catch {
    return null;
  }
}

/**
 * Record the outcome of one crawl search (atomic replace; only the latest is kept).
 * @param {string} root
 * @param {{ result: 'ok'|'login-required'|'error', search?: string, jobs?: number, message?: string, at?: string }} status
 */
export function recordCrawlStatus(root, { result, search = '', jobs, message = '', at } = {}) {
  if (!RESULTS.has(result)) throw new Error(`linkedin-session: result must be ok, login-required or error, got ${JSON.stringify(result)}`);
  const body = { result, search: String(search), ...(Number.isInteger(jobs) ? { jobs } : {}), message: String(message).slice(0, 500), at: at || new Date().toISOString() };
  const file = join(root, CRAWL_STATUS_FILE);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.linkedin-status.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return body;
}
