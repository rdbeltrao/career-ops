/**
 * lib/linkedin-apply.mjs — the employer's application URL behind a LinkedIn
 * "Apply on company website" button, and the small store that keeps it.
 *
 * FORK-LOCAL, like providers.local/linkedin-browser.mjs, which feeds it.
 *
 * Where the URL lives (probed 2026-10-25 in the signed-in crawl profile):
 *   - the signed-in search-results pane renders the button as
 *     <button role="link" aria-label="Apply to … on company website"> with no
 *     href, so the pane tells the apply KIND and nothing more;
 *   - the signed-in posting page /jobs/view/{id}/ renders it as
 *     <a aria-label="Apply on company website"
 *        href="https://www.linkedin.com/safety/go/?url=<employer URL>&urlhash=…">;
 *   - signed-out pages (the guest endpoint and the public page) show a sign-in
 *     modal and carry no URL at all.
 *
 * The store, {DATA_ROOT}/data/linkedin-apply.json, keeps the three things that
 * belong together: the LinkedIn posting id (the key), its board link, and the
 * employer URL. The board link stays the tracker's posting URL; the employer
 * URL is what the web Apply button opens in the form proxy.
 *
 *   { "4480683016": { "linkedinUrl": "https://www.linkedin.com/jobs/view/4480683016/",
 *                     "applyUrl": "https://jobs.ashbyhq.com/…", "kind": "offsite",
 *                     "checkedAt": "2026-10-25" } }
 *
 * `kind` is "offsite" (applied on the employer's site), "easy-apply" (applied
 * inside LinkedIn, so there is no employer URL) or "" (not recognised).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodeEntities } from '../providers/_html-entities.mjs';
import { linkedInJobId } from './linkedin-url.mjs';
import { localToday } from './local-today.mjs';

export const APPLY_STORE_FILE = join('data', 'linkedin-apply.json');
const KINDS = new Set(['offsite', 'easy-apply', '']);
const LINKEDIN_HOST_RE = /(^|\.)linkedin\.com$/i;
// The three ways LinkedIn wraps an outbound link: the current safety interstitial,
// the older redirector, and the externalApply route older posting pages used.
const REDIRECT_PATH_RE = /^\/(safety\/go|redir\/redirect|jobs\/view\/externalApply\/\d+)\/?$/;

function httpUrl(raw) {
  try {
    const u = new URL(String(raw ?? '').trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (LINKEDIN_HOST_RE.test(u.hostname)) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * The employer URL a LinkedIn outbound link points at, or null. Only a link on
 * linkedin.com itself counts (label-anchored, so "linkedin.com.evil.example"
 * does not), and only an http(s) target that is not LinkedIn again.
 * @param {string} href
 * @returns {string|null}
 */
export function linkedInRedirectTarget(href) {
  let u;
  try {
    u = new URL(decodeEntities(String(href ?? '').trim()));
  } catch {
    return null;
  }
  if (!LINKEDIN_HOST_RE.test(u.hostname) || !REDIRECT_PATH_RE.test(u.pathname)) return null;
  return httpUrl(u.searchParams.get('url'));
}

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? '') : '';
}

const APPLY_LABEL_RE = /\bapply\b/i;
const NOT_APPLY_RE = /apply current filter|apply filter/i;
// The top-card apply control and nothing else: its label says "apply ... on
// company website", or it carries LinkedIn's apply-button class or id. Links in
// the description and the "About the company" website link go through the same
// redirect and may even say "Apply here", so text alone never qualifies.
const COMPANY_WEBSITE_RE = /\bapply\b.*\bcompany website\b/i;
const APPLY_CONTROL_CLASS_RE = /(^|\s)jobs-apply-button(\s|$)/;

function isTopCardApply(tag) {
  return COMPANY_WEBSITE_RE.test(attr(tag, 'aria-label'))
    || APPLY_CONTROL_CLASS_RE.test(attr(tag, 'class'))
    || attr(tag, 'id') === 'jobs-apply-button-id';
}

/**
 * The employer URL from a signed-in LinkedIn posting page: the href of its
 * top-card apply link.
 * @param {string} html
 * @returns {string|null}
 */
export function offsiteApplyUrlFromHtml(html) {
  for (const m of String(html ?? '').matchAll(/<a\b([^>]*)>/gi)) {
    const tag = ` ${m[1]}`;
    if (!isTopCardApply(tag)) continue;
    const target = linkedInRedirectTarget(attr(tag, 'href'));
    if (target) return target;
  }
  return null;
}

/**
 * How the posting is applied to, from its apply control's aria-label. A
 * "company website" label wins over an "Easy Apply" one: a posting page also
 * lists other jobs, and their Easy Apply buttons are not this posting's.
 * @param {string} html
 * @returns {'offsite'|'easy-apply'|''}
 */
export function applyKindFromHtml(html) {
  const labels = [...String(html ?? '').matchAll(/\saria-label\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
    .map((m) => decodeEntities(m[1] ?? m[2] ?? ''))
    .filter((l) => APPLY_LABEL_RE.test(l) && !NOT_APPLY_RE.test(l));
  if (labels.some((l) => COMPANY_WEBSITE_RE.test(l))) return 'offsite';
  if (labels.some((l) => /easy apply/i.test(l))) return 'easy-apply';
  return '';
}

// ---------------------------------------------------------------- store

/** @param {string} root The data root (getCareerOpsRoot()). */
export function applyStorePath(root) {
  return join(root, APPLY_STORE_FILE);
}

function readStore(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object');
  return data;
}

/**
 * The store for lookups. A missing or unreadable file reads as empty: a lookup
 * that finds nothing offers the live lookup instead, which is the safe miss.
 * @returns {Record<string, {linkedinUrl: string, applyUrl: string, kind: string, checkedAt: string}>}
 */
export function loadApplyStore(root) {
  const file = applyStorePath(root);
  if (!existsSync(file)) return {};
  try {
    return readStore(file);
  } catch {
    return {};
  }
}

/**
 * Record what one posting's check found. A known employer URL is never erased
 * by a later check that could not read one (a changed layout, a timeout), and
 * a target that is not an http(s) employer page is stored as ''.
 * @param {string} root
 * @param {{ id: string, applyUrl?: string|null, kind?: string, checkedAt?: string }} entry
 */
export function recordApply(root, { id, applyUrl = '', kind = '', checkedAt } = {}) {
  const key = String(id ?? '').trim();
  if (!/^\d+$/.test(key)) throw new Error(`linkedin-apply: id must be a LinkedIn job id, got ${JSON.stringify(id)}`);
  const file = applyStorePath(root);
  // Writing replaces the file, so an existing file that does not parse (a
  // hand-edit typo) is refused rather than rewritten with this one entry.
  let store = {};
  if (existsSync(file)) {
    try {
      store = readStore(file);
    } catch (err) {
      throw new Error(`linkedin-apply: ${file} could not be read (${err.message}); fix or remove it, nothing was written`);
    }
  }
  const prev = store[key];
  const nextKind = KINDS.has(kind) && kind ? kind : prev?.kind || '';
  const url = httpUrl(applyUrl) ?? '';
  store[key] = {
    linkedinUrl: `https://www.linkedin.com/jobs/view/${key}/`,
    // An Easy Apply posting is applied to on LinkedIn: it has no employer URL.
    applyUrl: nextKind === 'easy-apply' ? '' : url || prev?.applyUrl || '',
    kind: nextKind,
    checkedAt: checkedAt || localToday(),
  };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.linkedin-apply.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return { id: key, ...store[key] };
}

/**
 * The stored entry for a LinkedIn posting URL (any spelling that carries the job
 * id), or null when the URL is not a LinkedIn posting or was never checked.
 * @param {string} root
 * @param {string} url
 * @returns {{ id: string, linkedinUrl: string, applyUrl: string, kind: string, checkedAt: string } | null}
 */
export function lookupApply(root, url) {
  let id;
  try {
    id = linkedInJobId(new URL(String(url ?? '')));
  } catch {
    return null;
  }
  if (!id) return null;
  const entry = loadApplyStore(root)[id];
  return entry ? { id, ...entry } : null;
}
