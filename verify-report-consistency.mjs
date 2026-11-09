#!/usr/bin/env node

/**
 * verify-report-consistency.mjs — zero-LLM check that a written report agrees
 * with itself: the Machine Summary YAML against the Block B table, the header
 * and the Verdict.
 *
 * A diagnostic of sent applications found four shapes of drift that no single
 * section shows on its own. Each is a finding here:
 *
 *   work-auth-location        `work_auth` is `not_needed` or `unstated` while
 *                             `posting_location` names a country outside
 *                             `config/profile.yml` → `location.authorized_in`
 *                             and the profile has `needs_sponsorship: true`
 *                             (a German EU Blue Card does not work in Spain),
 *                             or `permit_question` / `no_sponsorship` for a
 *                             role inside an authorized country
 *   work-auth-header          the header `**Work Auth:**` tier and the YAML
 *                             `work_auth` value disagree
 *   stack-fit-contradiction   `jev.reasons.stack_fit: required_mismatch` while
 *                             every Block B row that names a stack is ✅ Strong
 *   apply-with-hard-stops     `final_decision: Apply` while `hard_stops` holds
 *                             at least one entry
 *   apply-with-permit-question `final_decision: Apply` while `work_auth` is
 *                             `permit_question` (the application waits for the
 *                             recruiter's answer)
 *   posting-age-hard-stop-missing `posting_first_seen` is more than 60 days before
 *                             the report's `**Date:**` (today when the header
 *                             has none), or `repost_count` is 3 or more, and
 *                             no `hard_stops` entry names the evergreen /
 *                             re-listed requisition (an `overridden:` entry in
 *                             `soft_gaps` after "apply anyway" also satisfies it)
 *   posting-age-cap           an evergreen / re-listed `hard_stops` entry beside
 *                             `final_decision: Apply`: hard stop 4 caps the
 *                             verdict at Consider
 *   posting-age-legitimacy    an evergreen / re-listed `hard_stops` entry beside
 *                             `legitimacy_tier: High Confidence`: hard stop 4
 *                             caps Block G at Proceed with Caution
 *   posting-age-value         `posting_first_seen` is not a `YYYY-MM-DD` date, or
 *                             `repost_count` is not a non-negative integer
 *   without-clause-unsupported a `top_strengths` entry or the `## Verdict
 *                             (lead)` block says "without {noun}" ("without
 *                             headcount growth", "without adding people") and
 *                             no Block B Evidence / gap cell mentions that noun
 *
 * It reads; it never rewrites a report, the profile or the tracker. A finding
 * is a prompt to re-read the section it names, not a verdict.
 *
 * Usage:
 *   node verify-report-consistency.mjs <report.md> [--profile <path>] [--json] [--strict]
 *   node verify-report-consistency.mjs <reports-dir> --all [--profile <path>] [--json] [--strict]
 *
 *   --all      scan every *.md file in the directory given
 *   --profile  an explicit profile override (default: {DATA_ROOT}/config/profile.yml,
 *              or CAREER_OPS_PROFILE when set)
 *   --json     print { profile, reports: [{ report, status, reason?, findings }], total }
 *   --strict   exit 1 when there is at least one finding, or when a report
 *              could not be verified
 *
 * Exit codes:
 *   0  the check ran (findings or none); a report without a Machine Summary is
 *      "unverified", not a pass, and exits 0 without --strict
 *   1  --strict and at least one finding or an unverified report
 *   2  usage error, or the report path does not exist
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { isMainModule } from './lib/is-main-module.mjs';
import { getProfilePath } from './path-resolver.mjs';
import { loadYaml } from './lib/yaml-document.mjs';
import { localToday } from './lib/local-today.mjs';
import { parseDate } from './lib/parse-date.mjs';
import { MAX_POSTING_AGE_DAYS, REPOST_HARD_STOP_COUNT } from './posting-age.mjs';
import { machineSummary } from './lib/evaluation-report.mjs';
import { findBlockB, findMatchTable } from './verify-block-b-context.mjs';
import { colIndex } from './web/src/lib/report-tables.mjs';

const USAGE = 'Usage: node verify-report-consistency.mjs <report.md | reports-dir --all> [--profile <path>] [--json] [--strict]';

export const WORK_AUTH_VALUES = ['sponsors', 'not_needed', 'unstated', 'permit_question', 'no_sponsorship'];

// Header tier labels, as modes/oferta.md writes them, mapped to the YAML enum.
const HEADER_TIERS = [
  [/permit needed/i, 'permit_question'],
  [/no sponsorship/i, 'no_sponsorship'],
  [/not needed/i, 'not_needed'],
  [/unstated/i, 'unstated'],
  [/sponsors/i, 'sponsors'],
];
// The tier label sits before any explanation: "➖ Not needed (fully remote; no
// sponsorship issue raised)" is not_needed, whatever the parenthesis says.
const headerTierLabel = (text) => String(text ?? '').split(/[(—–;:,]/)[0];

// Countries a posting location can name, with the spellings a JD uses. A
// location that names none of these (a bare city, "Remote") is left alone:
// the check never guesses a country from a city.
const COUNTRIES = [
  ['Germany', ['germany', 'deutschland', 'alemania', 'allemagne']],
  ['Spain', ['spain', 'españa', 'espana', 'espagne']],
  ['France', ['france', 'francia', 'frankreich']],
  ['Italy', ['italy', 'italia', 'italien']],
  ['Portugal', ['portugal']],
  ['Netherlands', ['netherlands', 'the netherlands', 'nederland', 'holland']],
  ['Belgium', ['belgium', 'belgique', 'belgië', 'belgie']],
  ['Luxembourg', ['luxembourg']],
  ['Austria', ['austria', 'österreich', 'osterreich']],
  ['Switzerland', ['switzerland', 'schweiz', 'suisse', 'svizzera']],
  ['Poland', ['poland', 'polska', 'polen']],
  ['Czechia', ['czechia', 'czech republic', 'česko']],
  ['Slovakia', ['slovakia']],
  ['Hungary', ['hungary']],
  ['Romania', ['romania']],
  ['Bulgaria', ['bulgaria']],
  ['Greece', ['greece']],
  ['Croatia', ['croatia']],
  ['Slovenia', ['slovenia']],
  ['Ireland', ['ireland', 'republic of ireland']],
  ['Denmark', ['denmark', 'danmark']],
  ['Sweden', ['sweden', 'sverige']],
  ['Norway', ['norway', 'norge']],
  ['Finland', ['finland', 'suomi']],
  ['Iceland', ['iceland']],
  ['Estonia', ['estonia']],
  ['Latvia', ['latvia']],
  ['Lithuania', ['lithuania']],
  ['Malta', ['malta']],
  ['Cyprus', ['cyprus']],
  ['United Kingdom', ['united kingdom', 'uk', 'u.k.', 'great britain', 'england', 'scotland', 'wales', 'northern ireland']],
  ['United States', ['united states', 'usa', 'u.s.', 'u.s.a.', 'us']],
  ['Canada', ['canada']],
  ['Brazil', ['brazil', 'brasil']],
  ['Mexico', ['mexico', 'méxico']],
  ['Argentina', ['argentina']],
  ['Chile', ['chile']],
  ['Colombia', ['colombia']],
  ['Australia', ['australia']],
  ['New Zealand', ['new zealand']],
  ['India', ['india']],
  ['Singapore', ['singapore']],
  ['Japan', ['japan']],
  ['South Korea', ['south korea', 'korea']],
  ['China', ['china']],
  ['Hong Kong', ['hong kong']],
  ['Taiwan', ['taiwan']],
  ['Vietnam', ['vietnam', 'viet nam']],
  ['Indonesia', ['indonesia']],
  ['Turkey', ['turkey', 'türkiye', 'turkiye']],
  ['Israel', ['israel']],
  ['United Arab Emirates', ['united arab emirates', 'uae', 'dubai', 'abu dhabi']],
  ['Saudi Arabia', ['saudi arabia']],
  ['South Africa', ['south africa']],
  ['Nigeria', ['nigeria']],
  ['Egypt', ['egypt']],
  ['Ukraine', ['ukraine']],
  ['Serbia', ['serbia']],
];

const EU_MEMBERS = new Set([
  'Germany', 'Spain', 'France', 'Italy', 'Portugal', 'Netherlands', 'Belgium', 'Luxembourg', 'Austria', 'Poland',
  'Czechia', 'Slovakia', 'Hungary', 'Romania', 'Bulgaria', 'Greece', 'Croatia', 'Slovenia', 'Ireland', 'Denmark',
  'Sweden', 'Finland', 'Estonia', 'Latvia', 'Lithuania', 'Malta', 'Cyprus',
]);
const EEA_EXTRA = new Set(['Norway', 'Iceland']);
// An `authorized_in` entry that names a bloc. "EU" here means the candidate
// holds the right to work across it (citizenship), which the profile states;
// a national permit is listed by its country and never expands to this.
const BLOC_ALIASES = [
  [/^(?:eu|european union)$/i, (c) => EU_MEMBERS.has(c) || c === 'European Union'],
  [/^(?:eea|european economic area)$/i, (c) => EU_MEMBERS.has(c) || EEA_EXTRA.has(c) || c === 'European Union' || c === 'European Economic Area'],
  [/^(?:eu\s*\/\s*eea|eea\s*\/\s*eu)$/i, (c) => EU_MEMBERS.has(c) || EEA_EXTRA.has(c) || c === 'European Union' || c === 'European Economic Area'],
  [/^(?:eu\s*\+\s*switzerland|eu\/efta|efta)$/i, (c) => EU_MEMBERS.has(c) || EEA_EXTRA.has(c) || c === 'Switzerland' || c === 'European Union' || c === 'European Economic Area'],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The country a location string names, or null when it names none this
 * module knows. Aliases are matched on word boundaries so "us" never matches
 * inside "Austria" or "campus".
 * @param {unknown} text
 * @returns {string|null}
 */
// A bloc named as the posting location. "European Union" is exactly the case
// a national permit does not cover, so it is a country for this check and is
// authorized only through a bloc entry in `authorized_in`.
const BLOC_LOCATIONS = [
  ['European Union', [/(?<![\p{L}])(?:european union|eu)(?![\p{L}])/iu]],
  ['European Economic Area', [/(?<![\p{L}])(?:european economic area|eea)(?![\p{L}])/iu]],
];

export function countryOf(text) {
  const s = String(text ?? '').toLowerCase();
  if (!s.trim()) return null;
  for (const [name, patterns] of BLOC_LOCATIONS) if (patterns.some((re) => re.test(s))) {
    // A bloc beside a country ("Berlin, Germany (EU)") still names the country.
    const named = countryNamed(s);
    return named ?? name;
  }
  return countryNamed(s);
}

function countryNamed(s) {
  let best = null;
  for (const [name, aliases] of COUNTRIES) {
    for (const alias of aliases) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(alias)}(?![\\p{L}\\p{N}])`, 'u');
      const m = re.exec(s);
      if (m && (best === null || m.index < best.index || (m.index === best.index && alias.length > best.alias.length))) {
        best = { name, index: m.index, alias };
      }
    }
  }
  // A location usually ends with the country ("Barcelona, Spain"); when two
  // countries are named ("Remote — Spain or Portugal") the first one wins and
  // the finding names it, which is enough for the reader to look.
  return best?.name ?? null;
}

/**
 * Whether `country` is covered by the profile's `authorized_in` list: by name,
 * by an alias of the same country, or by a bloc entry (EU, EEA).
 * @param {string} country canonical name from countryOf()
 * @param {unknown[]} authorizedIn
 * @returns {boolean}
 */
export function isAuthorized(country, authorizedIn) {
  for (const raw of Array.isArray(authorizedIn) ? authorizedIn : []) {
    const entry = String(raw ?? '').trim();
    if (!entry) continue;
    if (countryOf(entry) === country) return true;
    for (const [re, covers] of BLOC_ALIASES) if (re.test(entry) && covers(country)) return true;
  }
  return false;
}

/**
 * The candidate's work rights from a profile file: `location.authorized_in`
 * and `location.needs_sponsorship`. Null when the file is absent or has no
 * `location` block; the work-auth check is then skipped, never guessed.
 * @param {string} profilePath
 * @returns {{authorizedIn: string[], needsSponsorship: boolean|null}|null}
 */
export function readProfileLocation(profilePath) {
  if (!profilePath || !existsSync(profilePath)) return null;
  let data;
  try { data = loadYaml(readFileSync(profilePath, 'utf-8')); } catch { return null; }
  const location = data && typeof data === 'object' ? data.location : null;
  if (!location || typeof location !== 'object') return null;
  const authorizedIn = Array.isArray(location.authorized_in) ? location.authorized_in.map((x) => String(x)) : [];
  const needsSponsorship = typeof location.needs_sponsorship === 'boolean' ? location.needs_sponsorship : null;
  return { authorizedIn, needsSponsorship };
}

/**
 * The header's `**Work Auth:**` tier as the YAML enum value, or null when the
 * header line is absent or names no known tier.
 * @param {string} markdown
 * @returns {string|null}
 */
export function headerWorkAuth(markdown) {
  const m = /^\*\*Work Auth:\*\*[ \t]*(.+)$/im.exec(String(markdown ?? ''));
  if (!m) return null;
  const label = headerTierLabel(m[1]);
  for (const [re, value] of HEADER_TIERS) if (re.test(label)) return value;
  // A header with no recognisable label before the explanation: read the whole line.
  for (const [re, value] of HEADER_TIERS) if (re.test(m[1])) return value;
  return null;
}

/**
 * The `## Verdict (lead)` block's text (any heading carrying the `(lead)`
 * marker, in any language), without the heading, up to the next heading of
 * the same or a higher level. Empty when the report has none.
 * @param {string} markdown
 * @returns {string}
 */
export function verdictText(markdown) {
  const lines = String(markdown ?? '').split('\n');
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!m) continue;
    if (start < 0) {
      if (/\(lead\)/i.test(m[2])) { start = i; level = m[1].length; }
    } else if (m[1].length <= level) {
      return lines.slice(start + 1, i).join('\n');
    }
  }
  return start < 0 ? '' : lines.slice(start + 1).join('\n');
}

// Words that name a technology, a language or a platform, or say that a row is
// about the stack. A row is a "stack row" when its Requirement cell carries one.
// Deliberately names, not habits: "hands-on in design discussions" and "OKR
// frameworks" are not stack rows, and a false stack row would turn a correct
// required_mismatch into a finding.
const STACK_RE = /(?:\bstack\b|\btechnolog|\bprogramming language|\bbackend ecosystem|c#|\.net\b|\bjava\b|\bjvm\b|\bgo\b|\bgolang\b|\bpython\b|\btypescript\b|\bjavascript\b|\bnode(?:\.js)?\b|\breact\b|\bvue\b|\bangular\b|\bphp\b|\bruby\b|\brails\b|\brust\b|\bkotlin\b|\bswift\b|\bscala\b|\belixir\b|\bc\+\+|\bkubernetes\b|\bk8s\b|\bdocker\b|\baws\b|\bgcp\b|\bazure\b|\bterraform\b|\bpulumi\b|\bkafka\b|\brabbitmq\b|\bpostgres(?:ql)?\b|\bmysql\b|\bmongodb\b|\bgraphql\b|\bsql\b)/i;
const STRONG_RE = /✅|\bstrong\b/i;

/**
 * Block B rows whose Requirement names a stack.
 * @param {ReturnType<typeof findMatchTable>} table
 * @returns {Array<{requirement: string, match: string, evidence: string}>}
 */
export function stackRows(table) {
  if (!table) return [];
  const cell = (row, i) => (i >= 0 ? String(row[i] ?? '').trim() : '');
  const importance = colIndex(table.header, ['importance']);
  return table.rows
    .map((row) => ({ requirement: cell(row, table.cols.requirement), importance: cell(row, importance), match: cell(row, table.cols.match), evidence: cell(row, table.cols.evidence) }))
    .filter((r) => r.requirement && STACK_RE.test(r.requirement));
}

/**
 * The stack rows Jev's `required_mismatch` speaks to: the ones at `critical`
 * or `high` importance when any stack row carries a band, otherwise all of
 * them. A `preferred` stack row marked Partial does not reconcile a required
 * stack row marked Strong.
 * @param {ReturnType<typeof stackRows>} rows
 * @returns {ReturnType<typeof stackRows>}
 */
export function requiredStackRows(rows) {
  const banded = rows.filter((r) => /\b(?:critical|high|meaningful|preferred|low_signal)\b/i.test(r.importance));
  if (!banded.length) return rows;
  return banded.filter((r) => /\b(?:critical|high)\b/i.test(r.importance));
}

// "without adding people": the words between "without" and the noun that
// carry no claim of their own, and the nouns that are too weak to anchor one.
const WITHOUT_FILLER = new Set(['adding', 'growing', 'increasing', 'expanding', 'hiring', 'needing', 'requiring', 'taking', 'any', 'the', 'a', 'an', 'more', 'extra', 'additional', 'new', 'further', 'to', 'of', 'in', 'on', 'or', 'and', 'its', 'their', 'our',
  // pronouns, adverbs and manner nouns: "without hesitation once it arrives" claims no resource
  'it', 'them', 'us', 'him', 'her', 'this', 'that', 'these', 'those', 'once', 'ever', 'first', 'much', 'too', 'yet', 'hesitation', 'delay', 'delays', 'fail', 'failing', 'issue', 'issues', 'problem', 'problems', 'friction', 'drama', 'doubt', 'question', 'fuss']);
const WITHOUT_WEAK = new Set(['growth', 'increase', 'change', 'changes', 'addition', 'additions', 'expansion', 'loss', 'cost', 'costs', 'drop', 'drops']);
// Synonyms a Block B Evidence cell may use for the resource named after
// "without". `people` and `hiring` are deliberately absent: every engineering-
// manager report mentions people and hiring somewhere, so they evidenced any
// "without headcount" claim and the check passed against itself (report 583).
const WITHOUT_SYNONYMS = {
  headcount: ['headcount', 'head count', 'team size', 'engineers added', 'fte', 'additional engineers', 'more engineers', 'new hires', 'extra hires'],
  hires: ['hires', 'headcount', 'head count', 'team size', 'new hires'],
  budget: ['budget', 'spend', 'cost'],
  downtime: ['downtime', 'outage', 'outages', 'uptime', 'availability'],
  outages: ['outage', 'outages', 'downtime', 'uptime', 'availability'],
  incidents: ['incident', 'incidents', 'outage', 'outages'],
  attrition: ['attrition', 'turnover', 'retention', 'churn'],
  turnover: ['turnover', 'attrition', 'retention', 'churn'],
  regressions: ['regression', 'regressions', 'defect', 'defects', 'bug', 'bugs'],
  overtime: ['overtime', 'crunch', 'working hours'],
};

const stemWord = (w) => w.toLowerCase().replace(/(?:ies)$/, 'y').replace(/(?:ing|ed|es|s)$/, '');

/**
 * Every "without {phrase}" claim in a text, with the nouns that must be
 * evidenced for it to stand.
 * @param {string} text
 * @returns {Array<{phrase: string, nouns: string[]}>}
 */
export function withoutClauses(text) {
  const out = [];
  const re = /\bwithout\s+((?:[\p{L}][\p{L}\p{N}'-]*)(?:\s+[\p{L}][\p{L}\p{N}'-]*){0,3})/giu;
  for (const m of String(text ?? '').matchAll(re)) {
    const words = m[1].split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, '')).filter(Boolean);
    const trimmed = [];
    // The clause ends at the first word that starts a new phrase.
    for (const w of words) {
      if (/^(?:and|or|but|which|that|so|because|while|as|for|with|from|by|at|on|in|into|after|before|since|then|also|only|still|yet|if|when|though|once|it|them|us|this|these|those|he|she|we|you|they)$/i.test(w) && trimmed.length) break;
      trimmed.push(w);
    }
    if (!trimmed.length) continue;
    const head = trimmed[0].toLowerCase();
    // "without owning all priorities", "without being the bottleneck", "without
    // a fundamental change" describe a manner, not a resource the candidate
    // did without. The rule is "without" plus a noun: a verb-led clause whose
    // head is a gerund outside the filler list, or an article-led description,
    // is left alone.
    if (/ing$/.test(head) && !WITHOUT_FILLER.has(head)) continue;
    if (/^(?:a|an|the)$/.test(head)) continue;
    const nouns = trimmed.filter((w) => !WITHOUT_FILLER.has(w.toLowerCase()));
    if (!nouns.length) continue;
    const anchors = nouns.filter((w) => !WITHOUT_WEAK.has(w.toLowerCase()));
    out.push({ phrase: `without ${trimmed.join(' ')}`, nouns: (anchors.length ? anchors : nouns).map((w) => w.toLowerCase()) });
  }
  return out;
}

/**
 * Whether any Block B Evidence / gap cell mentions one of the clause's nouns
 * (or a synonym). The Requirement cell never counts: it quotes the JD.
 * @param {{nouns: string[]}} clause
 * @param {ReturnType<typeof findMatchTable>} table
 * @returns {boolean}
 */
export function clauseEvidenced(clause, table) {
  if (!table || table.cols.evidence < 0) return false;
  const evidence = table.rows.map((row) => String(row[table.cols.evidence] ?? '').toLowerCase()).join('\n');
  const terms = new Set();
  for (const noun of clause.nouns) {
    terms.add(noun);
    const stem = stemWord(noun);
    if (stem.length >= 4) terms.add(stem);
    for (const syn of WITHOUT_SYNONYMS[noun] ?? WITHOUT_SYNONYMS[stem] ?? []) terms.add(syn);
  }
  return [...terms].some((t) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t)}`, 'u').test(evidence));
}

const lower = (v) => String(v ?? '').trim().toLowerCase();

/**
 * Words an evergreen / re-listed `hard_stops` entry carries, in the wording
 * `posting-age.mjs` prints and in the hand-written forms the mode text used
 * before the script existed. A hard stop about a stack, a span or a language
 * never names any of them, so the two cannot be confused.
 */
const POSTING_AGE_ENTRY_RE = /evergreen|re-?listed|repost|posting-age|posting age|first (?:posted|seen)/i;

/** @param {unknown} value @returns {string|null} */
function dateOnly(value) {
  const text = String(value ?? '').trim().slice(0, 10);
  return parseDate(text) ? text : null;
}

/** The report's `**Date:**` header, when it is a plain date. */
export function headerDate(markdown) {
  const m = /^\*\*Date:\*\*[ \t]*(.+)$/im.exec(String(markdown ?? ''));
  return m ? dateOnly(m[1]) : null;
}

/**
 * Days from `fromIso` to `toIso`, both `YYYY-MM-DD`; null when either is not.
 * @param {string} fromIso
 * @param {string} toIso
 * @returns {number|null}
 */
export function daysBetween(fromIso, toIso) {
  const from = parseDate(fromIso);
  const to = parseDate(toIso);
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * Run every check over one report's text.
 *
 * @param {string} markdown the report file's contents
 * @param {{profile?: {authorizedIn: string[], needsSponsorship: boolean|null}|null, today?: string}} [options]
 *   `today` (YYYY-MM-DD) stands in for the report date when the header has none.
 * @returns {{status: 'ok'|'findings'|'unverified', reason?: string, findings: Array<{kind: string, detail: string}>}}
 */
export function checkReport(markdown, { profile = null, today = localToday() } = {}) {
  const { data: ms, error } = machineSummary(markdown);
  if (!ms) return { status: 'unverified', reason: error ?? 'no Machine Summary', findings: [] };
  const findings = [];
  const section = findBlockB(markdown);
  const table = section === null ? null : findMatchTable(section);

  const workAuth = lower(ms.work_auth);
  const decision = lower(ms.final_decision);
  const hardStops = Array.isArray(ms.hard_stops) ? ms.hard_stops.filter((x) => String(x ?? '').trim()) : [];

  // 1. work_auth vs posting_location, under the profile's rights.
  if (profile && profile.needsSponsorship === true && ms.posting_location) {
    const country = countryOf(ms.posting_location);
    if (country) {
      const authorized = isAuthorized(country, profile.authorizedIn);
      if (!authorized && (workAuth === 'not_needed' || workAuth === 'unstated')) {
        findings.push({
          kind: 'work-auth-location',
          detail: `posting_location "${ms.posting_location}" is in ${country}, outside authorized_in [${profile.authorizedIn.join(', ')}], and the profile has needs_sponsorship: true, yet work_auth is "${ms.work_auth}"; expected permit_question (or sponsors / no_sponsorship when the JD says so). A national permit never counts as EU free movement`,
        });
      } else if (authorized && (workAuth === 'permit_question' || workAuth === 'no_sponsorship')) {
        findings.push({
          kind: 'work-auth-location',
          detail: `posting_location "${ms.posting_location}" is in ${country}, which authorized_in covers, yet work_auth is "${ms.work_auth}"; expected not_needed`,
        });
      }
    }
  }
  if (workAuth && !WORK_AUTH_VALUES.includes(workAuth)) {
    findings.push({ kind: 'work-auth-value', detail: `work_auth "${ms.work_auth}" is not one of ${WORK_AUTH_VALUES.join(' | ')}` });
  }

  // 2. header tier vs YAML.
  const header = headerWorkAuth(markdown);
  if (header && workAuth && header !== workAuth) {
    findings.push({ kind: 'work-auth-header', detail: `header **Work Auth:** reads as ${header} while Machine Summary work_auth is "${ms.work_auth}"` });
  }

  // 3. Jev stack_fit vs Block B stack rows.
  const stackFit = lower(ms.jev?.reasons?.stack_fit);
  if (stackFit === 'required_mismatch' && table) {
    const rows = requiredStackRows(stackRows(table));
    if (rows.length && rows.every((r) => STRONG_RE.test(r.match))) {
      findings.push({
        kind: 'stack-fit-contradiction',
        detail: `jev.reasons.stack_fit is required_mismatch while every required-tier Block B stack row is Strong (${rows.map((r) => `"${r.requirement}"`).join('; ')}); the report must say which side is right and why before the Verdict`,
      });
    }
  }

  // 4. Apply beside a hard stop or an open permit question.
  if (decision === 'apply' && hardStops.length) {
    findings.push({ kind: 'apply-with-hard-stops', detail: `final_decision is Apply while hard_stops holds ${hardStops.length} entr${hardStops.length === 1 ? 'y' : 'ies'} ("${String(hardStops[0]).slice(0, 80)}"); a hard stop caps the verdict at Research first (Consider for an evergreen requisition)` });
  }
  if (decision === 'apply' && workAuth === 'permit_question') {
    findings.push({ kind: 'apply-with-permit-question', detail: 'final_decision is Apply while work_auth is permit_question; the application waits for the recruiter\'s answer, so the verdict is at most Consider' });
  }

  // 4b. Posting age and repost count against the evergreen hard stop (hard stop 4).
  const softGaps = Array.isArray(ms.soft_gaps) ? ms.soft_gaps.filter((x) => String(x ?? '').trim()) : [];
  const ageEntries = hardStops.filter((x) => POSTING_AGE_ENTRY_RE.test(String(x)));
  const ageOverridden = softGaps.some((x) => /^\s*overridden:/i.test(String(x)) && POSTING_AGE_ENTRY_RE.test(String(x)));
  const firstSeenRaw = ms.posting_first_seen;
  const firstSeen = firstSeenRaw === null || firstSeenRaw === undefined || firstSeenRaw === '' ? null : dateOnly(firstSeenRaw);
  if (firstSeenRaw !== null && firstSeenRaw !== undefined && firstSeenRaw !== '' && !firstSeen) {
    findings.push({ kind: 'posting-age-value', detail: `posting_first_seen "${firstSeenRaw}" is not a YYYY-MM-DD date; copy the value node posting-age.mjs printed, or null when it did not run` });
  }
  const repostRaw = ms.repost_count;
  const repostCount = Number.isInteger(repostRaw) && repostRaw >= 0 ? repostRaw : null;
  if (repostRaw !== null && repostRaw !== undefined && repostCount === null) {
    findings.push({ kind: 'posting-age-value', detail: `repost_count "${repostRaw}" is not a non-negative integer; copy the value node posting-age.mjs printed, or 0 when it did not run` });
  }
  const reportDate = headerDate(markdown) ?? today;
  const ageDays = firstSeen ? daysBetween(firstSeen, reportDate) : null;
  const reasons = [];
  if (ageDays !== null && ageDays > MAX_POSTING_AGE_DAYS) reasons.push(`posting_first_seen ${firstSeen} is ${ageDays} days before the report date ${reportDate} (limit ${MAX_POSTING_AGE_DAYS})`);
  if (repostCount !== null && repostCount >= REPOST_HARD_STOP_COUNT) reasons.push(`repost_count ${repostCount} reaches ${REPOST_HARD_STOP_COUNT}`);
  if (reasons.length && !ageEntries.length && !ageOverridden) {
    findings.push({ kind: 'posting-age-hard-stop-missing', detail: `${reasons.join(' and ')}, yet hard_stops has no evergreen / re-listed requisition entry; paste the hard_stops entry node posting-age.mjs printed (or, after "apply anyway", move it to soft_gaps with the overridden: prefix) and cap final_decision at Consider` });
  }
  if (ageEntries.length && decision === 'apply') {
    findings.push({ kind: 'posting-age-cap', detail: `final_decision is Apply while hard_stops names an evergreen / re-listed requisition ("${String(ageEntries[0]).slice(0, 80)}"); hard stop 4 caps the verdict at Consider` });
  }
  if (ageEntries.length && lower(ms.legitimacy_tier) === 'high confidence') {
    findings.push({ kind: 'posting-age-legitimacy', detail: `legitimacy_tier is High Confidence while hard_stops names an evergreen / re-listed requisition ("${String(ageEntries[0]).slice(0, 80)}"); hard stop 4 caps Block G at Proceed with Caution` });
  }

  // 5. "without {noun}" claims in top_strengths and the Verdict.
  const sources = [];
  for (const s of Array.isArray(ms.top_strengths) ? ms.top_strengths : []) sources.push({ where: 'top_strengths', text: String(s ?? '') });
  const verdict = verdictText(markdown);
  if (verdict.trim()) sources.push({ where: 'Verdict (lead)', text: verdict });
  const seen = new Set();
  for (const { where, text } of sources) {
    for (const clause of withoutClauses(text)) {
      const key = `${where}|${clause.phrase.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!clauseEvidenced(clause, table)) {
        findings.push({
          kind: 'without-clause-unsupported',
          detail: `${where} says "${clause.phrase}" but no Block B Evidence / gap cell mentions ${clause.nouns.map((n) => `"${n}"`).join(' or ')}${table ? '' : ' (no Block B table found)'}; a compound claim is scored clause by clause and only an evidenced clause reaches a strength or the Verdict`,
        });
      }
    }
  }

  return { status: findings.length ? 'findings' : 'ok', findings };
}

/**
 * The whole check for one file or a directory of reports.
 *
 * @param {{path: string, all?: boolean, profilePath?: string|null, dataRoot?: string}} opts
 * @returns {{profile: string|null, reports: Array<{report: string, status: string, reason?: string, findings: object[]}>, total: number, exitCode: number}}
 */
export function verifyReportConsistency({ path, all = false, profilePath = null, dataRoot = null }) {
  // An explicit --profile wins; an explicit data root reads its config/profile.yml;
  // otherwise path-resolver applies CAREER_OPS_PROFILE and the resolved data root.
  const resolvedProfile = profilePath ? resolve(profilePath) : dataRoot ? getProfilePath(dataRoot) : getProfilePath();
  const profile = readProfileLocation(resolvedProfile);
  const base = { profile: profile ? resolvedProfile : null, reports: [], total: 0 };
  if (!existsSync(path)) return { ...base, reports: [{ report: path, status: 'unverified', reason: `report not found: ${path}`, findings: [] }], exitCode: 2 };
  let files;
  if (statSync(path).isDirectory()) {
    if (!all) return { ...base, reports: [{ report: path, status: 'unverified', reason: 'a directory needs --all', findings: [] }], exitCode: 2 };
    files = readdirSync(path).filter((f) => f.endsWith('.md')).sort().map((f) => join(path, f));
  } else {
    files = [path];
  }
  for (const file of files) {
    let markdown;
    try { markdown = readFileSync(file, 'utf-8'); } catch (err) {
      base.reports.push({ report: file, status: 'unverified', reason: `could not read: ${err.message}`, findings: [] });
      continue;
    }
    const result = checkReport(markdown, { profile });
    base.reports.push({ report: file, ...result });
    base.total += result.findings.length;
  }
  return { ...base, exitCode: 0 };
}

/**
 * @param {string[]} argv
 * @returns {{path: string, all: boolean, profilePath: string|null, json: boolean, strict: boolean} | {error: string} | {help: true}}
 */
export function parseArgs(argv) {
  let pathArg = null;
  let profileArg = null;
  let all = false;
  let json = false;
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') json = true;
    else if (a === '--strict') strict = true;
    else if (a === '--all') all = true;
    else if (a === '--profile') {
      profileArg = argv[++i];
      if (!profileArg) return { error: '--profile needs a path' };
    } else if (a.startsWith('--')) return { error: `unknown flag ${a}` };
    else if (pathArg === null) pathArg = a;
    else return { error: `unexpected extra argument: ${a}` };
  }
  if (pathArg === null) return { error: 'a report path is required' };
  return { path: resolve(pathArg), all, profilePath: profileArg ? resolve(profileArg) : null, json, strict };
}

/**
 * @param {ReturnType<typeof verifyReportConsistency>} result
 * @returns {string}
 */
export function formatText(result) {
  const lines = [];
  for (const r of result.reports) {
    const name = basename(r.report);
    for (const f of r.findings) lines.push(`⚠️  ${f.kind}  ${name}: ${f.detail}`);
    if (r.status === 'unverified') lines.push(`UNVERIFIED: ${r.reason} (${r.report})`);
  }
  if (!result.profile) lines.push('note: no config/profile.yml location block read; the work-auth check did not run');
  lines.push(`${result.total} finding(s) in ${result.reports.length} report(s)`);
  return `${lines.join('\n')}\n`;
}

if (isMainModule(import.meta.url)) {
  const parsed = parseArgs(process.argv.slice(2));
  if ('help' in parsed) { console.log(USAGE); process.exit(0); }
  if ('error' in parsed) { console.error(`Error: ${parsed.error}\n${USAGE}`); process.exit(2); }
  const { exitCode, ...result } = verifyReportConsistency(parsed);
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    if (exitCode === 2) console.error(`Error: ${result.reports[0]?.reason}`);
  } else if (exitCode === 2) {
    console.error(`Error: ${result.reports[0]?.reason}\n${USAGE}`);
  } else {
    process.stdout.write(formatText(result));
  }
  if (exitCode !== 0) process.exit(exitCode);
  if (parsed.strict && (result.total > 0 || result.reports.some((r) => r.status === 'unverified'))) process.exit(1);
}
