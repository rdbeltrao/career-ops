// @ts-check
/** @typedef {import('../providers/_types.js').Job} Job */

/**
 * providers.local/linkedin-browser.mjs — LinkedIn job searches read through
 * the user's own logged-in browser. FORK-LOCAL: upstream career-ops refuses
 * LinkedIn scraping by design, so this provider lives outside providers/ and
 * is never offered upstream.
 *
 * A port of job-hunt's `jobs/adapters/linkedin_browser.py` and
 * `jobs/browser.py`. One `portals.yml` entry per saved search:
 *
 *   tracked_companies:
 *     - name: engineering-manager-germany-7d
 *       provider: linkedin-browser
 *       search_url: "https://www.linkedin.com/jobs/search/?f_TPR=r604800&geoId=101282230&keywords=Engineering%20Manager&sortBy=DD"
 *       max_pages: 3        # optional, 25 cards per page, default 3
 *       resolve_apply_url: true  # optional, default true (see below)
 *       max_apply_lookups: 25    # optional, posting pages opened per search, default 25
 *       enabled: true
 *
 * Apply links: the pane says whether a posting is Easy Apply or applied "on
 * company website", but carries no URL for the latter. For an offsite posting
 * the walk opens /jobs/view/{id}/ in a second tab, paced like a card, and reads
 * the employer URL from its apply link (lib/linkedin-apply.mjs). The job keeps
 * its LinkedIn `url` and `externalId` and gains `applyUrl` / `applyKind`; the
 * JD capture gains `apply_url`; {DATA_ROOT}/data/linkedin-apply.json keeps
 * id, board link and employer URL together for the web Apply button.
 * `resolve_apply_url: false` skips the extra page; `max_apply_lookups` caps it.
 *
 * The browser is a persistent Chromium profile at LINKEDIN_PROFILE_DIR or
 * ~/.job-hunt/browser-profile (sign in once with `node linkedin-login.mjs`),
 * headless unless LINKEDIN_HEADED=1. The pacing is deliberately that of a
 * person and is not configurable: a random 1.5 to 4 s pause between cards,
 * 5 to 10 s between result pages, searches in random order (scan.mjs starts
 * `sequential` providers last and shuffled), one search at a time on the one
 * profile, and a job id already in `{DATA_ROOT}/data/linkedin-seen.json` is
 * never reopened. A login, checkpoint or authwall redirect stops the whole
 * LinkedIn part of the run at once with a clear message; nothing is retried
 * in that process.
 *
 * Parsing is pure and exported (parseCards, parseDetail, pagedUrl,
 * isLoginWall, postedDateFromText) so tests/providers/linkedin-browser.test.mjs
 * can run against the saved fixtures without a browser. LinkedIn changes its
 * markup regularly: every selector carries fallbacks, and a broken one is
 * fixed from the real HTML (set LINKEDIN_DUMP_DIR to keep what a run saw).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodeEntities } from '../providers/_html-entities.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { applyKindFromHtml, offsiteApplyUrlFromHtml, recordApply } from '../lib/linkedin-apply.mjs';
import { profileDir as sessionProfileDir, recordCrawlStatus } from '../lib/linkedin-session.mjs';

export const SOURCE = 'linkedin-browser';
export const PAGE_SIZE = 25;
export const DEFAULT_MAX_PAGES = 3;
export const CARD_WAIT_MS = [1500, 4000];
export const PAGE_WAIT_MS = [5000, 10000];
export const SEEN_FILE = join('data', 'linkedin-seen.json');
export const LINKEDIN_ORIGIN = 'https://www.linkedin.com';
export const LINKEDIN_LOGIN_URL = 'https://www.linkedin.com/login';
export const LINKEDIN_FEED_URL = 'https://www.linkedin.com/feed/';

// URL path fragments that mean LinkedIn wants the human back: the login page,
// a 2FA or captcha checkpoint, or the logged-out "authwall" interstitial.
const LOGIN_WALL_MARKERS = ['/login', '/uas/login', '/checkpoint/', '/authwall', '/signup', '/sign-in'];
// Present on every logged-in LinkedIn page (the top navigation with "Me").
const LOGGED_IN_SELECTOR = '#global-nav, .global-nav__me, #global-nav-typeahead';
// Present on the public, logged-out variants of the jobs pages, which LinkedIn
// serves instead of redirecting to /login.
const LOGGED_OUT_SELECTOR = "a.nav__button-secondary[href*='login'], .base-search-card, .authwall-join-form, form.join-form";
const LOGGED_IN_HTML_RE = /id="global-nav"|global-nav__me|id="global-nav-typeahead"/;
// contextual-sign-in-modal: the signed-out posting page, which LinkedIn serves at
// /jobs/view/{id}/ without any redirect, with Apply wired to a sign-in modal.
const LOGGED_OUT_HTML_RE = /authwall-join-form|class="[^"]*\bjoin-form\b|base-search-card|nav__button-secondary[^>]*href="[^"]*login|contextual-sign-in-modal/;

// Selectors for the result list cards; all are tried, matches merge on the job id.
export const CARD_SELECTORS = [
  'li[data-occludable-job-id]',
  'div.job-card-container[data-job-id]',
  'li.jobs-search-results__list-item',
  'li.scaffold-layout__list-item',
];
const DETAIL_PANE_SELECTORS = [
  '.scaffold-layout__detail',
  '.jobs-search__job-details--wrapper',
  '.jobs-search__job-details--container',
  '.jobs-details',
];
const RESULTS_LIST_SELECTORS = ['.scaffold-layout__list', '.jobs-search-results-list', 'ul.jobs-search__results-list', 'main'];
const DESCRIPTION_SELECTORS = ['#job-details', '.jobs-description__content', '.jobs-description-content__text', '.jobs-box__html-content', 'article'];
// Containers of the top card, where the company name links to the company page.
const COMPANY_LINK_SCOPES = [
  '.job-details-jobs-unified-top-card__company-name',
  '.jobs-unified-top-card__company-name',
  '.job-details-jobs-unified-top-card__container--two-pane',
  '.job-details-jobs-unified-top-card__primary-description-container',
  '.jobs-unified-top-card',
];
const PILL_SELECTORS = [
  '.job-details-fit-level-preferences button',
  ".job-details-fit-level-preferences span[aria-hidden='true']",
  '.job-details-jobs-unified-top-card__job-insight span',
  '.job-details-jobs-unified-top-card__job-insight-view-model-secondary',
  '.jobs-unified-top-card__job-insight span',
  '.job-details-preferences-and-skills__pill span',
];

const JOB_ID_RE = /\/jobs\/view\/(\d+)/;
const SALARY_RE = /(€|\$|£|EUR|USD|GBP)\s?\d|\d\s?(€|EUR|USD|GBP|k\/yr|\/yr|\/hr|\/month|\/mo|per year|per month)/i;
const WORKPLACE_WORDS = [['remote', 'remote'], ['hybrid', 'hybrid'], ['on-site', 'onsite'], ['onsite', 'onsite'], ['on site', 'onsite']];
const SENIORITY_WORDS = ['internship', 'entry level', 'associate', 'mid-senior', 'director', 'executive', 'level'];
const EMPLOYMENT_WORDS = ['full-time', 'part-time', 'contract', 'internship', 'temporary', 'volunteer', 'other'];
// "23 hours ago", "Reposted 2 days ago", "1 week ago", "an hour ago".
const RELATIVE_RE = /\b(\d+|an?|one)\s+(minute|min|hour|hr|day|week|month|year)s?\s+ago\b/i;
const RELATIVE_UNIT_DAYS = { day: 1, week: 7, month: 30, year: 365 };
// Premium "hiring insights" describe the applicants, not the job.
const APPLICANT_INSIGHT_RE = /applicant/i;
const COMPANY_URL_RE = /^(https?:\/\/[^/]+)?\/company\/([^/?#]+)/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// ---------------------------------------------------------------- minimal DOM
//
// career-ops ships no HTML parser and this provider must not add a dependency
// for a fork-local file, so this is the smallest DOM the selectors above need:
// elements with attributes and children, text nodes, and a matcher for
// `tag.class#id[attr op value]` compounds joined by the descendant combinator
// and grouped with commas. No child combinator, no pseudo-classes.

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT_TAGS = new Set(['script', 'style']);
const BLOCK_TAGS = new Set(['p', 'div', 'br', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'tr']);

/**
 * @typedef {{ type: 'element', tag: string, attrs: Record<string, string>, children: Node[], parent: Element|null }} Element
 * @typedef {{ type: 'text', text: string, parent: Element }} Text
 * @typedef {Element|Text} Node
 */

/**
 * Parse an HTML fragment or document into a tree. Unknown end tags are
 * ignored; an end tag closes everything opened after its start tag.
 * @param {string} html
 * @returns {Element} The synthetic root.
 */
export function parseHtml(html) {
  const text = typeof html === 'string' ? html : '';
  /** @type {Element} */
  const root = { type: 'element', tag: '#root', attrs: {}, children: [], parent: null };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const addText = (s) => { if (s) top().children.push({ type: 'text', text: s, parent: top() }); };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) { addText(text.slice(i)); break; }
    if (lt > i) addText(text.slice(i, lt));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<!', lt) || text.startsWith('<?', lt)) {
      const end = text.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (text.startsWith('</', lt)) {
      const end = text.indexOf('>', lt);
      const name = text.slice(lt + 2, end === -1 ? n : end).trim().toLowerCase();
      i = end === -1 ? n : end + 1;
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) { stack.length = k; break; }
      }
      continue;
    }
    const open = /^<([a-zA-Z][^\s/>]*)/.exec(text.slice(lt, lt + 64));
    if (!open) { addText('<'); i = lt + 1; continue; }
    const tag = open[1].toLowerCase();
    let j = lt + 1 + open[1].length;
    /** @type {Record<string, string>} */
    const attrs = {};
    let selfClosing = false;
    while (j < n) {
      while (j < n && /\s/.test(text[j])) j++;
      if (j >= n) break;
      if (text[j] === '>') { j++; break; }
      if (text[j] === '/') { selfClosing = true; j++; continue; }
      let k = j;
      while (k < n && !/[\s=/>]/.test(text[k])) k++;
      const name = text.slice(j, k).toLowerCase();
      j = k;
      while (j < n && /\s/.test(text[j])) j++;
      let value = '';
      if (text[j] === '=') {
        j++;
        while (j < n && /\s/.test(text[j])) j++;
        const quote = text[j];
        if (quote === '"' || quote === "'") {
          const end = text.indexOf(quote, j + 1);
          value = text.slice(j + 1, end === -1 ? n : end);
          j = end === -1 ? n : end + 1;
        } else {
          k = j;
          while (k < n && !/[\s>]/.test(text[k])) k++;
          value = text.slice(j, k);
          j = k;
        }
      }
      if (name) attrs[name] = decodeEntities(value);
    }
    i = j;
    /** @type {Element} */
    const el = { type: 'element', tag, attrs, children: [], parent: top() };
    top().children.push(el);
    if (RAW_TEXT_TAGS.has(tag)) {
      const close = new RegExp(`</${tag}\\s*>`, 'ig');
      close.lastIndex = i;
      const m = close.exec(text);
      i = m ? m.index + m[0].length : n;
      continue;
    }
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(el);
  }
  return root;
}

/** @typedef {{ tag: string, id: string, classes: string[], attrs: {name: string, op: string, value: string}[] }} Simple */

/** @param {string} selector @returns {Simple[][]} One chain (left to right) per comma group. */
function parseSelector(selector) {
  const groups = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const ch of selector) {
    if (quote) { current += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === ',' && depth === 0) { groups.push(current); current = ''; continue; }
    current += ch;
  }
  groups.push(current);
  return groups.map((g) => g.trim()).filter(Boolean).map((g) => {
    const compounds = [];
    let buf = '';
    let inBracket = 0;
    let q = '';
    const flush = () => { if (buf.trim()) compounds.push(parseCompound(buf.trim())); buf = ''; };
    for (const ch of g) {
      if (q) { buf += ch; if (ch === q) q = ''; continue; }
      if (ch === '"' || ch === "'") { q = ch; buf += ch; continue; }
      if (ch === '[') inBracket++;
      if (ch === ']') inBracket--;
      if (/\s/.test(ch) && inBracket === 0) { flush(); continue; }
      buf += ch;
    }
    flush();
    return compounds;
  });
}

/** @param {string} compound @returns {Simple} */
function parseCompound(compound) {
  /** @type {Simple} */
  const out = { tag: '', id: '', classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([*^$]?=)("[^"]*"|'[^']*'|[^\]]*))?\]/g;
  let m;
  while ((m = re.exec(compound)) !== null) {
    if (m[1]) out.tag = m[1].toLowerCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else if (m[4]) {
      const raw = m[6] ?? '';
      const value = /^["']/.test(raw) ? raw.slice(1, -1) : raw;
      out.attrs.push({ name: m[4].toLowerCase(), op: m[5] ?? '', value });
    }
  }
  return out;
}

/** @param {Element} el @param {Simple} s */
function matchesSimple(el, s) {
  if (s.tag && el.tag !== s.tag) return false;
  if (s.id && el.attrs.id !== s.id) return false;
  if (s.classes.length) {
    const classes = (el.attrs.class ?? '').split(/\s+/);
    for (const c of s.classes) if (!classes.includes(c)) return false;
  }
  for (const a of s.attrs) {
    const v = el.attrs[a.name];
    if (v === undefined) return false;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
    if (a.op === '$=' && !v.endsWith(a.value)) return false;
  }
  return true;
}

/** @param {Element} el @param {Simple[]} chain */
function matchesChain(el, chain) {
  let idx = chain.length - 1;
  if (idx < 0 || !matchesSimple(el, chain[idx])) return false;
  let node = el.parent;
  idx--;
  while (idx >= 0) {
    while (node && node.tag !== '#root' && !matchesSimple(node, chain[idx])) node = node.parent;
    if (!node || node.tag === '#root') return false;
    node = node.parent;
    idx--;
  }
  return true;
}

/** @param {Element} root @param {(el: Element) => boolean|void} visit Return true to stop. */
function walk(root, visit) {
  for (const child of root.children) {
    if (child.type !== 'element') continue;
    if (visit(child)) return true;
    if (walk(child, visit)) return true;
  }
  return false;
}

/** Every descendant element matching the selector list, in document order. */
export function selectAll(root, selector) {
  const chains = parseSelector(selector);
  /** @type {Element[]} */
  const out = [];
  walk(root, (el) => { if (chains.some((c) => matchesChain(el, c))) out.push(el); });
  return out;
}

/** The first descendant element matching the selector list, or null. */
export function selectOne(root, selector) {
  const chains = parseSelector(selector);
  /** @type {Element|null} */
  let found = null;
  walk(root, (el) => { if (chains.some((c) => matchesChain(el, c))) { found = el; return true; } return false; });
  return found;
}

/** Collapse whitespace runs to one space and decode entities. */
export function squash(text) {
  return decodeEntities(String(text ?? '')).replace(/\s+/g, ' ').trim();
}

/** @param {Element|null} el @param {string[]} parts */
function collectText(el, parts) {
  if (!el) return;
  for (const child of el.children) {
    if (child.type === 'text') parts.push(child.text);
    else collectText(child, parts);
  }
}

/** The element's text with descendants' text runs joined by one space, squashed. */
export function textOf(el) {
  const parts = [];
  collectText(el, parts);
  return squash(parts.join(' '));
}

/** @param {Element} el @param {string[]} parts */
function collectTextWithBreaks(el, parts) {
  for (const child of el.children) {
    if (child.type === 'text') { parts.push(child.text); continue; }
    const block = BLOCK_TAGS.has(child.tag);
    if (block) parts.push('\n');
    if (child.tag === 'li') parts.push('- ');
    collectTextWithBreaks(child, parts);
    if (block) parts.push('\n');
  }
}

/** Plain text of an element's content, keeping paragraph and list breaks. */
export function htmlToText(el) {
  if (!el) return '';
  const parts = [];
  collectTextWithBreaks(el, parts);
  return decodeEntities(parts.join(''))
    .replace(/[ \t\r\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------- pure parsing

/**
 * @typedef {object} Card
 * @property {string} id
 * @property {string} title
 * @property {string} company
 * @property {string} location
 * @property {string} postedDate ISO date or ''.
 * @property {string} salary Salary text or ''.
 */

/**
 * @typedef {object} Detail
 * @property {string} title
 * @property {string} company
 * @property {string} location
 * @property {string} description
 * @property {string} postedDate ISO date from "x days ago" / "Reposted x hours ago", or ''.
 * @property {string} workplace 'remote' | 'hybrid' | 'onsite' | ''.
 * @property {string} seniority
 * @property {string} employmentType
 * @property {string} salary
 * @property {string} companyUrl
 * @property {string[]} pills
 */

/** The first selector whose first match has text; '' when none does. */
function textFirst(root, ...selectors) {
  const node = firstNode(root, ...selectors);
  return node ? textOf(node) : '';
}

function firstNode(root, ...selectors) {
  for (const sel of selectors) {
    const node = selectOne(root, sel);
    if (node && textOf(node)) return node;
  }
  return null;
}

function datetimeFirst(root) {
  const t = selectOne(root, 'time[datetime]');
  if (!t) return '';
  const value = t.attrs.datetime ?? '';
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
}

function cardId(node) {
  for (const attr of ['data-occludable-job-id', 'data-job-id']) {
    if (node.attrs[attr]) return node.attrs[attr].trim();
  }
  const inner = selectOne(node, '[data-job-id]');
  if (inner?.attrs['data-job-id']) return inner.attrs['data-job-id'].trim();
  const link = selectOne(node, 'a[href*="/jobs/view/"]');
  const m = link ? JOB_ID_RE.exec(link.attrs.href ?? '') : null;
  return m ? m[1] : '';
}

function cardTitle(node) {
  const link = selectOne(node, "a.job-card-list__title--link, a.job-card-container__link, a.job-card-list__title, a[href*='/jobs/view/']");
  if (!link) return textFirst(node, '.artdeco-entity-lockup__title');
  const strong = selectOne(link, 'strong');
  if (strong && textOf(strong)) return textOf(strong);
  if (link.attrs['aria-label']) return squash(link.attrs['aria-label']);
  const hidden = selectOne(link, '.visually-hidden');
  if (hidden) return textOf(hidden);
  return textOf(link);
}

/** Salary row of the card metadata; LinkedIn renders it in an obfuscated-class <li>. */
function cardSalary(node) {
  for (const li of selectAll(node, '.job-card-container__metadata-wrapper li, .artdeco-entity-lockup__metadata li')) {
    const txt = textOf(li);
    if (txt && SALARY_RE.test(txt)) return txt;
  }
  return '';
}

/**
 * The result cards of a search page. Nested matches (an li and its inner div)
 * and re-rendered duplicates collapse on the job id.
 * @param {string} html
 * @returns {Card[]}
 */
export function parseCards(html) {
  const root = parseHtml(html);
  /** @type {Card[]} */
  const cards = [];
  const seen = new Set();
  for (const node of selectAll(root, CARD_SELECTORS.join(', '))) {
    const id = cardId(node);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    cards.push({
      id,
      title: cardTitle(node),
      company: textFirst(node, '.artdeco-entity-lockup__subtitle', '.job-card-container__primary-description', '.job-card-container__company-name'),
      location: textFirst(node, '.job-card-container__metadata-wrapper li', '.job-card-container__metadata-item', '.artdeco-entity-lockup__caption'),
      postedDate: datetimeFirst(node)
        || postedDateFromText(textFirst(node, '.job-card-container__footer-item--highlighted', '.job-card-container__footer-item', '.job-card-list__footer-wrapper')),
      salary: textFirst(node, '.job-card-container__metadata-item--salary', '.job-card-list__salary') || cardSalary(node),
    });
  }
  return cards;
}

/** 'Berlin, Germany · 2 days ago · 45 applicants' -> 'Berlin, Germany'. */
function locationFromMeta(meta) {
  if (!meta) return '';
  return squash(meta.split(/\s[·•]\s/)[0]);
}

/** Texts of the job-insight pills (workplace type, employment type, seniority, salary). */
function pillTexts(root) {
  /** @type {string[]} */
  let texts = [];
  for (const sel of PILL_SELECTORS) {
    for (const node of selectAll(root, sel)) {
      const txt = textOf(node);
      if (txt && !texts.includes(txt) && txt.length < 80) texts.push(txt);
    }
    if (texts.length) break;
  }
  // Pills often nest "Hybrid Matches your job preferences"; keep the leading label only.
  const cleaned = [];
  for (const raw of texts) {
    const t = raw.replace(/\s*Matches your job preferences.*$/i, '').trim();
    if (t && !cleaned.includes(t)) cleaned.push(t);
  }
  return cleaned;
}

/**
 * The "Seniority level" criteria row when the pane renders the job criteria
 * list. The premium "Applicant seniority level" insight is skipped on purpose.
 */
function seniorityFromCriteria(root) {
  for (const item of selectAll(root, '.description__job-criteria-item, .jobs-description-details__list-item, .job-criteria__item, li')) {
    const heading = selectOne(item, '.description__job-criteria-subheader, .job-criteria__subheader, h3, h4, dt, strong');
    if (!heading) continue;
    const headingText = textOf(heading);
    const label = headingText.replace(/:$/, '').trim().toLowerCase();
    // Only the literal criteria heading counts; "Seniority & Leadership:" and
    // "Applicant seniority level" do not.
    if (label !== 'seniority level') continue;
    const value = selectOne(item, '.description__job-criteria-text, .job-criteria__text, dd, span, p');
    let text = value ? textOf(value) : '';
    if (!text || text.replace(/:$/, '').trim().toLowerCase() === label) {
      text = squash(textOf(item).replace(headingText, '')).replace(/^:/, '').trim();
    }
    if (text && text.length < 40 && !APPLICANT_INSIGHT_RE.test(text)) return text;
  }
  // "Seniority level" as a text run of its own, with the value in the next sibling.
  /** @type {string} */
  let found = '';
  walk(root, (el) => {
    for (let k = 0; k < el.children.length; k++) {
      const child = el.children[k];
      if (child.type !== 'text' || !/^\s*Seniority level\s*:?\s*$/i.test(child.text)) continue;
      if (APPLICANT_INSIGHT_RE.test(textOf(el))) continue;
      const parentIndex = el.parent ? el.parent.children.indexOf(el) : -1;
      const sibling = parentIndex >= 0 ? el.parent.children.slice(parentIndex + 1).find((c) => c.type === 'element') : null;
      const text = sibling ? textOf(sibling) : '';
      if (text && text.length < 40) { found = text; return true; }
    }
    return false;
  });
  return found;
}

/** 'https://www.linkedin.com/company/momox/life?x=1' -> 'https://www.linkedin.com/company/momox/'; '' when not a company link. */
export function canonicalCompanyUrl(href) {
  const m = COMPANY_URL_RE.exec(String(href ?? '').trim());
  if (!m) return '';
  return `${m[1] || LINKEDIN_ORIGIN}/company/${m[2]}/`;
}

function companyUrl(root) {
  for (const scope of COMPANY_LINK_SCOPES) {
    for (const node of selectAll(root, scope)) {
      for (const link of selectAll(node, 'a[href*="/company/"]')) {
        const url = canonicalCompanyUrl(link.attrs.href);
        if (url) return url;
      }
    }
  }
  return '';
}

/**
 * The detail pane of one posting.
 * @param {string} html
 * @param {{ now?: Date }} [opts] `now` anchors relative posting ages (tests).
 * @returns {Detail}
 */
export function parseDetail(html, { now } = {}) {
  const root = parseHtml(html);
  const title = textFirst(root, '.job-details-jobs-unified-top-card__job-title', 'h1.t-24', 'h1', 'h2.jobs-details-top-card__job-title');
  const company = textFirst(root, '.job-details-jobs-unified-top-card__company-name', '.jobs-unified-top-card__company-name', '.jobs-details-top-card__company-url');
  const meta = textFirst(
    root,
    '.job-details-jobs-unified-top-card__tertiary-description-container',
    '.job-details-jobs-unified-top-card__primary-description-container',
    '.jobs-unified-top-card__primary-description',
    '.jobs-unified-top-card__subtitle-primary-grouping',
  );
  const descNode = firstNode(root, ...DESCRIPTION_SELECTORS);
  const description = htmlToText(descNode).replace(/^About the job\s*/, '').trim();
  const pills = pillTexts(root);
  /** @type {Detail} */
  const detail = {
    title,
    company,
    location: locationFromMeta(meta),
    description,
    postedDate: datetimeFirst(root) || postedDateFromText(meta, now),
    workplace: '',
    seniority: '',
    employmentType: '',
    salary: '',
    companyUrl: companyUrl(root),
    pills,
  };
  for (const pill of pills) {
    const low = pill.toLowerCase();
    if (!detail.workplace) {
      const hit = WORKPLACE_WORDS.find(([word]) => low.includes(word));
      if (hit) detail.workplace = hit[1];
    }
    if (!detail.employmentType && EMPLOYMENT_WORDS.some((w) => low === w || low.startsWith(w))) detail.employmentType = pill;
    else if (!detail.seniority && SENIORITY_WORDS.some((w) => low.includes(w))) detail.seniority = pill;
    else if (!detail.salary && SALARY_RE.test(pill)) detail.salary = pill;
  }
  if (!detail.seniority) detail.seniority = seniorityFromCriteria(root);
  return detail;
}

const pad = (n) => String(n).padStart(2, '0');
/** @param {Date} d Local calendar date as ISO. */
function localIsoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthIndex(name) {
  const low = name.toLowerCase();
  const idx = MONTHS.findIndex((m) => m === low || (low.length === 3 && m.startsWith(low)));
  return idx;
}

function validDate(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** An absolute spelling LinkedIn uses, as an ISO date; '' when the part is not one. */
function absoluteDate(part) {
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(part))) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  if ((m = /^([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})$/.exec(part))) {
    const month = monthIndex(m[1]);
    return month === -1 ? '' : validDate(Number(m[3]), month + 1, Number(m[2]));
  }
  if ((m = /^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})$/.exec(part))) {
    const month = monthIndex(m[2]);
    return month === -1 ? '' : validDate(Number(m[3]), month + 1, Number(m[1]));
  }
  if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(part))) return validDate(Number(m[3]), Number(m[2]), Number(m[1]));
  return '';
}

/**
 * ISO date for LinkedIn's posting-age text, or '' when the text carries none.
 *
 * Relative forms ("15 minutes ago", "Reposted 23 hours ago", "2 days ago",
 * "3 weeks ago", "1 month ago", "just now", "yesterday") and a few absolute
 * spellings ("Oct 14, 2026", "14 Oct 2026", "2026-10-14", "14.10.2026").
 * Weeks and months are approximations, like LinkedIn's own rounding. The
 * date is the LOCAL calendar date, as the Python feeder computed it.
 * @param {string} text
 * @param {Date} [now]
 */
export function postedDateFromText(text, now) {
  if (!text) return '';
  const base = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const m = RELATIVE_RE.exec(text);
  if (m) {
    const amount = m[1].toLowerCase();
    const n = ['a', 'an', 'one'].includes(amount) ? 1 : Number(amount);
    const unit = m[2].toLowerCase();
    let ms;
    if (unit === 'minute' || unit === 'min') ms = n * 60_000;
    else if (unit === 'hour' || unit === 'hr') ms = n * 3_600_000;
    else ms = n * RELATIVE_UNIT_DAYS[unit] * 86_400_000;
    return localIsoDate(new Date(base.getTime() - ms));
  }
  const low = text.toLowerCase();
  if (/\bjust now\b|\btoday\b/.test(low)) return localIsoDate(base);
  if (/\byesterday\b/.test(low)) return localIsoDate(new Date(base.getTime() - 86_400_000));
  for (const rawPart of text.split(/\s[·•]\s|\n/)) {
    const part = squash(rawPart.replace(/^(Re)?posted(\s+on)?\s*/i, ''));
    const iso = absoluteDate(part);
    if (iso) return iso;
  }
  return '';
}

/** Epoch ms at UTC midnight of an ISO date, or undefined. */
export function isoDateToEpochMs(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * The search URL for result page `page` (1-based): page 1 carries no `start`,
 * page n carries `start=(n-1)*25`. `currentJobId` (the pane selection LinkedIn
 * adds to a copied URL) is dropped; every other parameter is kept as it was.
 * @param {string} searchUrl
 * @param {number} page
 */
export function pagedUrl(searchUrl, page) {
  const url = new URL(searchUrl);
  url.searchParams.delete('currentJobId');
  const start = (Math.max(1, Math.trunc(Number(page) || 1)) - 1) * PAGE_SIZE;
  if (start > 0) url.searchParams.set('start', String(start));
  else url.searchParams.delete('start');
  return url.href;
}

/** `https://www.linkedin.com/jobs/view/{id}/` */
export function canonicalJobUrl(id) {
  return `${LINKEDIN_ORIGIN}/jobs/view/${String(id).trim()}/`;
}

/**
 * True when LinkedIn wants the human back: the URL is a login, checkpoint,
 * authwall or signup page, or the page is the logged-out variant of the jobs
 * site (a "Sign in" button and guest cards instead of a redirect). A page that
 * shows the logged-in navigation is never a wall.
 * @param {string} url
 * @param {string} [html]
 */
export function isLoginWall(url, html = '') {
  const text = String(url ?? '');
  let path = text;
  try { path = new URL(text).pathname; } catch { /* not a URL: match the raw string */ }
  if (LOGIN_WALL_MARKERS.some((marker) => path.includes(marker))) return true;
  const body = String(html ?? '');
  if (!body) return false;
  if (LOGGED_IN_HTML_RE.test(body)) return false;
  return LOGGED_OUT_HTML_RE.test(body);
}

/** Best-effort workplace classification from free text (title, location, description). */
export function guessWorkplace(...texts) {
  const blob = texts.filter(Boolean).join(' ').toLowerCase();
  if (!blob) return '';
  if (blob.includes('hybrid')) return 'hybrid';
  if (/remote|home ?office|work from home/.test(blob)) return 'remote';
  if (/on-site|onsite|on site|vor ort/.test(blob)) return 'onsite';
  return '';
}

/**
 * One scanner Job from a card and (when the pane was read) its detail. The
 * detail wins for every field it carries; the card fills the rest. `jd` is
 * the C6 job object scan.mjs stores for jev-rank.mjs, present only when a
 * description was read.
 *
 * `apply` is what the apply step found (lib/linkedin-apply.mjs): `applyKind`
 * ("offsite" or "easy-apply") and, for an offsite posting, `applyUrl`, the
 * employer's own application page. The LinkedIn link stays the job's `url` and
 * the LinkedIn id its `externalId`; the employer URL rides beside them, and is
 * left out entirely when there is none.
 * @param {Card} card
 * @param {Detail|null} detail
 * @param {{ name?: string }} entry
 * @param {{ applyUrl?: string|null, applyKind?: string }} [apply]
 * @returns {Job & Record<string, unknown>}
 */
export function buildJob(card, detail, entry, apply = {}) {
  const d = detail ?? null;
  const title = d?.title || card.title;
  const company = d?.company || card.company;
  const location = d?.location || card.location;
  const description = d?.description ?? '';
  const workplace = d?.workplace || guessWorkplace(title, location, description, (d?.pills ?? []).join(' '));
  const postedDate = card.postedDate || d?.postedDate || '';
  const url = canonicalJobUrl(card.id);
  const salaryText = d?.salary || card.salary || '';
  const searchName = String(entry?.name ?? '').trim();
  /** @type {Job & Record<string, unknown>} */
  const job = {
    title,
    url,
    company,
    location,
    description,
    externalId: card.id,
    source: SOURCE,
    note: `${SOURCE} ${searchName}`.trim(),
    workplace,
    seniority: d?.seniority ?? '',
    employmentType: d?.employmentType ?? '',
    salaryText,
    companyUrl: d?.companyUrl ?? '',
  };
  const postedAt = isoDateToEpochMs(postedDate);
  if (postedAt !== undefined) job.postedAt = postedAt;
  if (apply?.applyKind) job.applyKind = apply.applyKind;
  if (apply?.applyUrl) job.applyUrl = apply.applyUrl;
  if (description) {
    job.jd = {
      url,
      title,
      company,
      location,
      workplace,
      seniority: job.seniority,
      description,
      salary: salaryText,
      posted_date: postedDate,
      source: SOURCE,
      source_id: card.id,
      search_name: searchName,
    };
    if (job.applyUrl) job.jd.apply_url = job.applyUrl;
  }
  return job;
}

// ---------------------------------------------------------------- seen ids

/** `{dataRoot}/data/linkedin-seen.json`; the data root resolves through path-resolver. */
export function seenStorePath(dataRoot = getCareerOpsRoot()) {
  return join(dataRoot, SEEN_FILE);
}

/**
 * Job ids opened in earlier runs. A missing, unreadable or malformed file is
 * an empty set: the cost is reopening a posting at human pace, never a crash.
 * @param {string} path
 * @returns {Set<string>}
 */
export function loadSeen(path) {
  if (!existsSync(path)) return new Set();
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return new Set(Array.isArray(data) ? data.map((x) => String(x)) : []);
  } catch {
    return new Set();
  }
}

/** Write the ids sorted, one per line, so the file diffs cleanly in the data root's git. */
export function saveSeen(ids, path) {
  const sorted = [...new Set([...ids].map((x) => String(x)))].sort();
  mkdirSync(dirname(path), { recursive: true });
  const body = sorted.length ? `[\n${sorted.map((id) => JSON.stringify(id)).join(',\n')}\n]\n` : '[]\n';
  writeFileSync(path, body, 'utf-8');
}

/** The cards whose id is in neither set. */
export function filterUnseen(cards, ...seenSets) {
  return cards.filter((c) => !seenSets.some((s) => s.has(c.id)));
}

// ---------------------------------------------------------------- entry shape

/** @param {{ search_url?: unknown, name?: unknown }} entry */
export function requireSearchUrl(entry) {
  const raw = typeof entry?.search_url === 'string' ? entry.search_url.trim() : '';
  if (!raw) throw new Error(`${SOURCE}: "${entry?.name ?? '?'}" has no search_url (a LinkedIn jobs search URL)`);
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${SOURCE}: "${entry?.name}" search_url is not a URL: ${raw}`); }
  if (url.protocol !== 'https:' || !/(^|\.)linkedin\.com$/.test(url.hostname) || !url.pathname.startsWith('/jobs/search')) {
    throw new Error(`${SOURCE}: "${entry?.name}" search_url must be an https://www.linkedin.com/jobs/search/ URL: ${raw}`);
  }
  return url.href;
}

/** `max_pages` as a positive integer; DEFAULT_MAX_PAGES when absent or unusable. */
// JUDGMENT: 25 is one result page of new offsite postings. Each lookup is one
// more page view on the user's real account; postings past the cap keep their
// kind and can still be looked up one at a time from the web Apply button.
export const DEFAULT_MAX_APPLY_LOOKUPS = 25;

/**
 * How many posting pages one search may open to read employer apply URLs:
 * `max_apply_lookups` (0 turns it off), and 0 when `resolve_apply_url: false`.
 * @param {{ max_apply_lookups?: unknown, resolve_apply_url?: unknown }} entry
 */
export function resolveApplyLookups(entry) {
  if (entry?.resolve_apply_url === false) return 0;
  const n = Number(entry?.max_apply_lookups);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_APPLY_LOOKUPS;
}

export function resolveMaxPages(entry) {
  const n = Number(entry?.max_pages);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_PAGES;
}

// ---------------------------------------------------------------- browser

export class LoginRequiredError extends Error {
  constructor(url) {
    super(`${SOURCE}: LinkedIn asked for a login or a checkpoint at ${url}. The LinkedIn part of this run stops here and is not retried; sign in with "node linkedin-login.mjs" and run the scan again.`);
    this.name = 'LoginRequiredError';
    this.url = url;
  }
}

/** The persistent Chromium profile: LINKEDIN_PROFILE_DIR, else ~/.job-hunt/browser-profile (lib/linkedin-session.mjs). */
export function profileDir() {
  return sessionProfileDir();
}

/**
 * Record one search's outcome for the web LinkedIn page (lib/linkedin-session.mjs).
 * Never on a dry run, and a failed write never fails the scan.
 */
function noteCrawl(ctx, status) {
  if (ctx?.dryRun === true) return;
  try {
    recordCrawlStatus(getCareerOpsRoot(), status);
  } catch (err) {
    log(`could not record the crawl status: ${err.message}`);
  }
}

/**
 * Open the shared profile. Cookies and local storage persist across runs, so
 * one `node linkedin-login.mjs` keeps every later scan signed in.
 * @param {{ headed?: boolean }} [opts]
 */
export async function openProfile({ headed = false } = {}) {
  const { chromium } = await import('playwright');
  const dir = profileDir();
  mkdirSync(dir, { recursive: true });
  return chromium.launchPersistentContext(dir, {
    headless: !headed,
    viewport: { width: 1400, height: 1000 },
    locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

/** Whether the page shows a signed-in LinkedIn (feed URL or the logged-in navigation). */
export async function isLoggedIn(page) {
  const url = page.url();
  if (url.startsWith(LINKEDIN_FEED_URL) || url.includes('/feed')) return true;
  if (isLoginWall(url)) return false;
  try {
    return await page.locator(LOGGED_IN_SELECTOR).first().isVisible({ timeout: 500 });
  } catch {
    return false;
  }
}

// A login wall seen once in this process stops every later fetch before it
// opens the browser: "never retries" is the rule, and scan.mjs would otherwise
// call this provider once per remaining search.
/** @type {LoginRequiredError|null} */
let halted = null;

/** Test seam: forget a wall seen earlier in this process. */
export function resetLoginHalt() { halted = null; }

function halt(url) {
  halted = halted ?? new LoginRequiredError(url);
  return halted;
}

async function assertLoggedIn(page) {
  const url = page.url();
  if (isLoginWall(url)) throw halt(url);
  let loggedIn = false;
  let loggedOut = false;
  try {
    loggedIn = (await page.locator(LOGGED_IN_SELECTOR).count()) > 0;
    if (!loggedIn) loggedOut = (await page.locator(LOGGED_OUT_SELECTOR).count()) > 0;
  } catch {
    return; // navigating mid-check; the next check decides
  }
  if (!loggedIn && loggedOut) throw halt(url);
}

const randomBetween = (lo, hi) => lo + Math.random() * (hi - lo);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepRandom = ([lo, hi]) => sleep(randomBetween(lo, hi));

// One search at a time: scan.mjs runs targets in parallel, and two Chromium
// instances cannot share one profile directory.
let browserLock = Promise.resolve();
function withBrowserLock(fn) {
  const run = browserLock.then(fn, fn);
  browserLock = run.catch(() => {});
  return run;
}

const log = (message) => process.stderr.write(`${SOURCE}: ${message}\n`);

async function waitForCards(page, timeoutMs = 15_000) {
  try {
    await page.waitForSelector(CARD_SELECTORS.join(', '), { timeout: timeoutMs });
  } catch {
    await assertLoggedIn(page);
    log(`no job cards appeared within ${Math.round(timeoutMs / 1000)}s at ${page.url()}`);
  }
}

/** Scroll the results list container so LinkedIn renders every (lazy) card. */
async function scrollResults(page, maxRounds = 12) {
  const selector = CARD_SELECTORS.join(', ');
  let last = -1;
  for (let round = 0; round < maxRounds; round++) {
    const count = await page.evaluate((sel) => {
      const cards = document.querySelectorAll(sel);
      if (!cards.length) return 0;
      const el = cards[cards.length - 1];
      let scroller = el;
      while (scroller && scroller !== document.body) {
        const s = getComputedStyle(scroller);
        if (scroller.scrollHeight > scroller.clientHeight + 10 && /(auto|scroll)/.test(s.overflowY)) break;
        scroller = scroller.parentElement;
      }
      if (scroller && scroller !== document.body) scroller.scrollTop += 600; else window.scrollBy(0, 600);
      el.scrollIntoView({ block: 'end' });
      return cards.length;
    }, selector);
    await page.waitForTimeout(Math.round(randomBetween(500, 1100)));
    if (count === last) break;
    last = count;
  }
}

async function firstInnerHtml(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.count()) return await loc.innerHTML({ timeout: 3000 });
    } catch {
      continue;
    }
  }
  return page.content();
}

async function openDetail(page, jobId) {
  const card = page.locator(`li[data-occludable-job-id="${jobId}"], div.job-card-container[data-job-id="${jobId}"], a[href*="/jobs/view/${jobId}"]`).first();
  try {
    await card.scrollIntoViewIfNeeded({ timeout: 5000 });
    await card.click({ timeout: 5000 });
  } catch {
    // Occluded (virtualised) card: scroll it to the centre and retry once.
    await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(Math.round(randomBetween(600, 1200)));
    await card.click({ timeout: 5000 });
  }
  // The pane re-renders asynchronously; wait for the URL to carry this id or
  // the description block to show up, whichever comes first.
  try {
    await page.waitForURL(new RegExp(`currentJobId=${jobId}`), { timeout: 8000 });
  } catch { /* the description wait below decides */ }
  await assertLoggedIn(page);
  try {
    await page.waitForSelector('#job-details, .jobs-description__content, .jobs-description-content__text', { timeout: 8000 });
  } catch {
    log(`description did not appear for ${jobId}`);
  }
  await page.waitForTimeout(Math.round(randomBetween(400, 900)));
  return firstInnerHtml(page, DETAIL_PANE_SELECTORS);
}

// The apply link of a signed-in posting page (lib/linkedin-apply.mjs has the
// markup), or the control that says the posting is Easy Apply.
const POSTING_APPLY_SELECTOR = [
  'a[aria-label*="company website" i]',
  'a[href*="/safety/go/"]',
  'a[href*="/jobs/view/externalApply/"]',
  'button.jobs-apply-button',
  '[aria-label*="Easy Apply" i]',
].join(', ');

/**
 * Read one posting's apply method from its own page, opened in a second tab of
 * the signed-in context so the search page underneath keeps its place. The
 * search pane shows an offsite button with no URL; the posting page links the
 * employer's application through LinkedIn's safety/go redirect.
 *
 * A login, checkpoint or authwall redirect halts the run like every other page.
 * @param {import('playwright').BrowserContext} context
 * @param {string} jobId
 * @returns {Promise<{ applyUrl: string|null, applyKind: 'offsite'|'easy-apply'|'' }>}
 */
export async function readPostingApply(context, jobId) {
  const page = await context.newPage();
  try {
    await page.goto(canonicalJobUrl(jobId), { waitUntil: 'domcontentloaded', timeout: 20_000 });
    if (isLoginWall(page.url())) throw halt(page.url());
    await page.waitForSelector(POSTING_APPLY_SELECTOR, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(Math.round(randomBetween(400, 900)));
    const html = await page.content();
    dump(`posting-${jobId}.html`, html);
    // A signed-out session gets the public posting page at the same URL, so
    // the URL alone cannot tell; the page's own markup does.
    if (isLoginWall(page.url(), html)) throw halt(page.url());
    return { applyUrl: offsiteApplyUrlFromHtml(html), applyKind: applyKindFromHtml(html) };
  } finally {
    await page.close().catch(() => {});
  }
}

function dump(name, html) {
  const dir = process.env.LINKEDIN_DUMP_DIR?.trim();
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name.replace(/[^\w.-]+/g, '_')), html, 'utf-8');
}

/**
 * Walk one saved search in the signed-in page and return its new jobs.
 * Cards whose id is in the seen store are not opened and not returned; an id
 * joins the store once its pane gave a description (not under dryRun, which
 * must not consume postings the pipeline never received).
 */
async function walkSearch(page, { entry, searchUrl, maxPages, seenPath, dryRun, applyRoot = getCareerOpsRoot() }) {
  const name = String(entry.name ?? '');
  // Posting-page visits that read an offsite employer URL, per search.
  let applyLookupsLeft = resolveApplyLookups(entry);
  const seen = loadSeen(seenPath);
  const seenThisRun = new Set();
  /** @type {Job[]} */
  const jobs = [];
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const url = pagedUrl(searchUrl, pageNo);
    if (pageNo > 1) await sleepRandom(PAGE_WAIT_MS);
    let listHtml;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);
      await assertLoggedIn(page);
      await waitForCards(page);
      await scrollResults(page);
      listHtml = await firstInnerHtml(page, RESULTS_LIST_SELECTORS);
    } catch (err) {
      if (err instanceof LoginRequiredError) throw err;
      if (pageNo === 1 || jobs.length === 0) throw err;
      // A later page that fails to load must not discard the jobs already collected.
      log(`${name} page ${pageNo} failed, keeping ${jobs.length} jobs: ${err.message}`);
      break;
    }
    dump(`${name}-page${pageNo}-list.html`, listHtml);
    const cards = parseCards(listHtml);
    const fresh = filterUnseen(cards, seenThisRun, seen);
    for (const c of cards) seenThisRun.add(c.id);
    log(`${name} page ${pageNo}/${maxPages}: ${cards.length} cards, ${fresh.length} new`);
    if (cards.length === 0) break;
    for (const card of fresh) {
      await sleepRandom(CARD_WAIT_MS);
      let detail = null;
      let apply = { applyUrl: null, applyKind: '' };
      try {
        const detailHtml = await openDetail(page, card.id);
        dump(`${name}-${card.id}-detail.html`, detailHtml);
        detail = parseDetail(detailHtml);
        apply.applyKind = applyKindFromHtml(detailHtml);
      } catch (err) {
        if (err instanceof LoginRequiredError) throw err;
        log(`detail for ${card.id} failed: ${err.message}`);
      }
      // The pane says "on company website" but carries no URL; the posting page
      // does. One more page, paced like the cards, only for offsite postings.
      if (apply.applyKind === 'offsite' && applyLookupsLeft > 0) {
        applyLookupsLeft -= 1;
        await sleepRandom(CARD_WAIT_MS);
        try {
          const read = await readPostingApply(page.context(), card.id);
          // The pane's kind wins: it describes this posting alone, while the
          // posting page also lists other jobs and their apply buttons.
          apply = { applyUrl: read.applyUrl, applyKind: apply.applyKind || read.applyKind };
          if (!read.applyUrl) log(`no employer apply link found for ${card.id}`);
        } catch (err) {
          if (err instanceof LoginRequiredError) throw err;
          log(`apply link for ${card.id} failed: ${err.message}`);
        }
      }
      if (apply.applyKind && !dryRun) {
        try {
          recordApply(applyRoot, { id: card.id, applyUrl: apply.applyUrl, kind: apply.applyKind });
        } catch (err) {
          log(`could not record the apply link for ${card.id}: ${err.message}`);
        }
      }
      jobs.push(buildJob(card, detail, entry, apply));
      if (detail?.description && !dryRun) {
        seen.add(card.id);
        saveSeen(seen, seenPath);
      }
    }
    if (cards.length < PAGE_SIZE) break;
  }
  return jobs;
}

export default {
  id: SOURCE,
  // Not an API: scan.mjs labels the source with this instead of `{id}-api`.
  sourceName: SOURCE,
  // One browser profile, one search at a time, in random order: scan.mjs
  // starts the targets of a sequential provider last and shuffled.
  sequential: true,

  /**
   * @param {{ name?: string, search_url?: string, max_pages?: number }} entry
   * @param {{ dryRun?: boolean }} [ctx]
   * @returns {Promise<Job[]>}
   */
  async fetch(entry, ctx = {}) {
    const searchUrl = requireSearchUrl(entry);
    const maxPages = resolveMaxPages(entry);
    if (halted) throw halted;
    return withBrowserLock(async () => {
      if (halted) throw halted;
      const context = await openProfile({ headed: process.env.LINKEDIN_HEADED === '1' });
      try {
        const page = context.pages()[0] ?? await context.newPage();
        const jobs = await walkSearch(page, {
          entry,
          searchUrl,
          maxPages,
          seenPath: seenStorePath(),
          dryRun: ctx?.dryRun === true,
        });
        noteCrawl(ctx, { result: 'ok', search: String(entry.name ?? ''), jobs: jobs.length });
        return jobs;
      } catch (err) {
        noteCrawl(ctx, {
          result: err instanceof LoginRequiredError ? 'login-required' : 'error',
          search: String(entry.name ?? ''),
          message: err.message,
        });
        throw err;
      } finally {
        await context.close().catch(() => {});
      }
    });
  },
};
