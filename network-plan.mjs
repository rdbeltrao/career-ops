#!/usr/bin/env node
/**
 * network-plan.mjs — the weekly LinkedIn connection plan, built from the funnel.
 *
 * Recruiters filter on "has connections at our company" and "follows our
 * company page", so the network should grow at the companies whose openings the
 * candidate liked or applied to. This script ranks those companies from
 * `data/applications.md` and the pending rows of `data/pipeline.md`, leaves out
 * the ones already covered (`data/network.json`), and prints a checklist with
 * the LinkedIn search links to work through by hand. It never opens LinkedIn:
 * zero network, zero tokens, and the only write is `--done`.
 *
 * Ranking, per row, capped at --per-company openings per company:
 *   - a tracker row in an active state (Applied, Responded, Assessment,
 *     Interview, Offer) counts 10;
 *   - a pipeline row with `jev: … apply`, or `rank: 4.0/5` or better, counts 3;
 *   - `jev: … maybe`, or `rank: 3.5/5` or better, counts 1;
 *   - an Evaluated tracker row counts by its score on the same thresholds;
 *   - Rejected, Discarded, SKIP and Hired rows, and `jev: … skip`, count nothing.
 *
 * Usage:
 *   node network-plan.mjs                         # this week's plan, markdown on stdout
 *   node network-plan.mjs --json                  # the same plan as JSON
 *   node network-plan.mjs --done "Acme"           # mark Acme covered, then print the plan
 *   node network-plan.mjs --out output/plan.md    # write the markdown instead
 *
 * Exports (consumed by tests/network-plan.test.mjs): rankCompanies, renderPlan,
 * parsePipelineRows, readTrackerRows, loadDone, saveDone, markDone,
 * peopleSearchUrl, companySearchUrl, DEFAULT_ROLES.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { flagValue, hasFlag, safeIntFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { isHeaderRow, isSeparatorRow, parseMarkdownLinks, parseScore, parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import { companiesMatchIgnoringCorporateForm, normalizeCompany, writeFileAtomic } from './tracker-utils.mjs';

// Role families to connect with at each company, in priority order: peers with
// the target title, the level above, then the people who run the hiring.
export const DEFAULT_ROLES = [
  'Engineering Manager',
  'Head of Engineering',
  'VP Engineering',
  'CTO',
  'Technical Recruiter',
];
export const DEFAULT_QUOTA = 100;
export const DEFAULT_PER_COMPANY = 10;

// Tracker states (templates/states.yml labels, compared case-insensitively).
const ACTIVE_STATUSES = new Set(['applied', 'responded', 'assessment', 'interview', 'offer']);
const CLOSED_STATUSES = new Set(['rejected', 'discarded', 'skip', 'hired']);

const WEIGHT_ACTIVE = 10;
const WEIGHT_STRONG = 3;
const WEIGHT_WEAK = 1;
const STRONG_SCORE = 4.0;
const WEAK_SCORE = 3.5;

const LABELED_SEGMENT = /^(posted|trust|note|rank|jev):/i;
const RANK_SEGMENT = /^rank:\s*(\d+(?:\.\d+)?)\s*\/\s*5/i;
const JEV_SEGMENT = /^jev:\s*(\d+)\s+(apply|maybe|skip)\b/i;

/** Python's quote_plus: spaces become `+`, everything else percent-encoded. */
function quotePlus(text) {
  return encodeURIComponent(String(text ?? ''))
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

export function peopleSearchUrl(company, role) {
  return `https://www.linkedin.com/search/results/people/?keywords=${quotePlus(`${company} ${role}`)}&origin=GLOBAL_SEARCH_HEADER`;
}

export function companySearchUrl(company) {
  return `https://www.linkedin.com/search/results/companies/?keywords=${quotePlus(company)}`;
}

/** Weight of a verdict score (a Jev-style or tracker-style 0-5 number). */
function weightForScore(score) {
  if (!Number.isFinite(score)) return 0;
  if (score >= STRONG_SCORE) return WEIGHT_STRONG;
  if (score >= WEAK_SCORE) return WEIGHT_WEAK;
  return 0;
}

function weightForVerdict(verdict) {
  if (verdict === 'apply') return WEIGHT_STRONG;
  if (verdict === 'maybe') return WEIGHT_WEAK;
  return 0;
}

/**
 * Pending pipeline rows with their `rank:` and `jev:` segments. Positional
 * cells end at the first labeled segment, so a bare-URL row that carries only
 * `| jev: …` does not read the segment as its company.
 *
 * @param {string} text - data/pipeline.md contents.
 * @returns {Array<{url: string, company: string, title: string, rank: number|null, jev: {fit: number, verdict: string}|null}>}
 */
export function parsePipelineRows(text) {
  const rows = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.startsWith('- [ ] ')) continue;
    const cells = raw.slice(6).split('|').map((c) => c.trim());
    const firstLabeled = cells.findIndex((c, i) => i > 0 && LABELED_SEGMENT.test(c));
    const positional = firstLabeled === -1 ? cells : cells.slice(0, firstLabeled);
    let rank = null;
    let jev = null;
    for (const cell of cells.slice(1)) {
      const r = cell.match(RANK_SEGMENT);
      if (r) rank = Number(r[1]);
      const j = cell.match(JEV_SEGMENT);
      if (j) jev = { fit: Number(j[1]), verdict: j[2].toLowerCase() };
    }
    rows.push({
      url: positional[0] ?? '',
      company: positional[1] ?? '',
      title: positional[2] ?? '',
      rank,
      jev,
    });
  }
  return rows;
}

/** The first http(s) markdown link in a cell, or ''. */
function firstHttpLink(cell) {
  for (const link of parseMarkdownLinks(String(cell ?? ''))) {
    const target = String(link.target).trim().replace(/^<|>$/g, '');
    if (/^https?:\/\//i.test(target)) return target;
  }
  return '';
}

/**
 * Tracker rows through the shared header-aware column mapping. A row's `url`
 * is the URL column when the layout has one; otherwise the first http(s) link
 * in Notes, where the legacy nine-column layout keeps the posting link.
 *
 * @param {string} path - data/applications.md.
 * @returns {Array<object>} parseTrackerRow() results, in file order.
 */
export function readTrackerRows(path) {
  if (!path || !existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
  const colmap = resolveColumns(lines);
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith('|') || isSeparatorRow(line) || isHeaderRow(line)) continue;
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    if (!row.url) row.url = firstHttpLink(row.notes);
    rows.push(row);
  }
  return rows;
}

/** Companies already covered: lower-cased name -> ISO date. */
export function loadDone(path) {
  if (!path || !existsSync(path)) return {};
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    console.error(`network-plan: ${path} is not valid JSON (${err.message}); treating it as empty`);
    return {};
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const done = {};
  for (const [k, v] of Object.entries(data)) done[String(k).trim().toLowerCase()] = String(v);
  return done;
}

export function saveDone(done, path) {
  mkdirSync(dirname(path), { recursive: true });
  const sorted = Object.fromEntries(Object.keys(done).sort().map((k) => [k, done[k]]));
  writeFileAtomic(path, `${JSON.stringify(sorted, null, 1)}\n`);
}

export function markDone(companies, done, today) {
  const out = { ...done };
  for (const name of companies) {
    const key = String(name ?? '').trim().toLowerCase();
    if (key) out[key] = today;
  }
  return out;
}

function isDone(company, done) {
  const keys = Object.keys(done ?? {});
  if (keys.length === 0) return false;
  const key = normalizeCompany(company);
  return keys.some((k) => normalizeCompany(k) === key || companiesMatchIgnoringCorporateForm(k, company));
}

function cleanStatus(status) {
  return String(status ?? '').replace(/\*\*/g, '').trim();
}

/**
 * Companies worth connecting at, best first.
 *
 * @param {Array<object>} trackerRows - readTrackerRows() output.
 * @param {Array<object>} pipelineRows - parsePipelineRows() output.
 * @param {{perCompany?: number, done?: Record<string, string>}} [options]
 * @returns {Array<{company: string, score: number, applied: boolean, openings: Array<{title: string, url: string, state: string, weight: number, source: string}>}>}
 */
export function rankCompanies(trackerRows, pipelineRows, { perCompany = DEFAULT_PER_COMPANY, done = {} } = {}) {
  const cap = Number.isFinite(perCompany) && perCompany >= 1 ? Math.floor(perCompany) : DEFAULT_PER_COMPANY;
  const byKey = new Map();
  const add = (company, opening) => {
    const name = String(company ?? '').trim();
    if (!name || opening.weight <= 0) return;
    const key = normalizeCompany(name);
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, { company: name, openings: [] });
    byKey.get(key).openings.push(opening);
  };

  for (const row of trackerRows ?? []) {
    const status = cleanStatus(row.status);
    const lower = status.toLowerCase();
    if (CLOSED_STATUSES.has(lower)) continue;
    let weight = 0;
    if (ACTIVE_STATUSES.has(lower)) weight = WEIGHT_ACTIVE;
    else if (lower === 'evaluated') weight = weightForScore(parseScore(row.score));
    add(row.company, { title: String(row.role ?? '').trim(), url: String(row.url ?? ''), state: status, weight, source: 'tracker' });
  }

  for (const row of pipelineRows ?? []) {
    let weight = 0;
    let state = '';
    if (row.jev) {
      weight = weightForVerdict(row.jev.verdict);
      state = row.jev.verdict;
    } else if (row.rank != null) {
      weight = weightForScore(Number(row.rank));
      state = `rank ${Number(row.rank).toFixed(1)}/5`;
    }
    add(row.company, { title: String(row.title ?? '').trim(), url: String(row.url ?? ''), state, weight, source: 'pipeline' });
  }

  const plans = [];
  for (const entry of byKey.values()) {
    if (isDone(entry.company, done)) continue;
    const openings = entry.openings
      .map((o, i) => ({ o, i }))
      .sort((a, b) => b.o.weight - a.o.weight || a.i - b.i)
      .map(({ o }) => o)
      .slice(0, cap);
    const score = openings.reduce((sum, o) => sum + o.weight, 0);
    if (score <= 0) continue;
    plans.push({
      company: entry.company,
      score,
      applied: openings.some((o) => o.source === 'tracker' && ACTIVE_STATUSES.has(o.state.toLowerCase())),
      openings,
    });
  }
  return plans.sort((a, b) => b.score - a.score || a.company.toLowerCase().localeCompare(b.company.toLowerCase()));
}

/**
 * The markdown checklist: one block per company with the links to open.
 *
 * @param {Array<object>} companies - rankCompanies() output.
 * @param {{quota?: number, roles?: string[], date?: string}} [options]
 * @returns {string}
 */
export function renderPlan(companies, { quota = DEFAULT_QUOTA, roles = DEFAULT_ROLES, date } = {}) {
  const today = date || new Date().toISOString().slice(0, 10);
  const perDay = Math.ceil(quota / 5);
  const lines = [
    `# LinkedIn connection plan, week of ${today}`,
    '',
    `Budget: ${quota} invitations this week, about ${perDay} a day and five companies a day. Connect, not Follow. ` +
      'A note only when there is something real to say. Follow each company page and press "I am interested" ' +
      'where it is offered. Stop at the budget. Mark a company covered with ' +
      '`node network-plan.mjs --done "<company>"`.',
    '',
  ];
  if (!companies || companies.length === 0) {
    lines.push('Nothing to do: every company with an interesting opening is already marked done, or the funnel is empty.');
    return `${lines.join('\n')}\n`;
  }
  companies.forEach((plan, i) => {
    const n = plan.openings.length;
    const tag = plan.applied ? 'applied' : `${n} opening${n === 1 ? '' : 's'}`;
    lines.push(`## ${i + 1}. ${plan.company} (${tag})`, '');
    for (const o of plan.openings) {
      const title = o.title || '(untitled)';
      lines.push(o.url ? `- ${title} [${o.state}](${o.url})` : `- ${title} [${o.state}]`);
    }
    lines.push(`- [ ] Follow the company page: ${companySearchUrl(plan.company)}`);
    for (const role of roles) lines.push(`- [ ] ${role}: ${peopleSearchUrl(plan.company, role)}`);
    lines.push('');
  });
  return `${lines.join('\n')}\n`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const USAGE = `Usage: node network-plan.mjs [--quota N] [--per-company N] [--roles "A,B"] [--done "Company" ...] [--out <path>] [--json] [--date YYYY-MM-DD]

  Weekly LinkedIn connection plan from data/applications.md and data/pipeline.md.
  Reads the funnel, ranks the companies, prints the search links. Never opens LinkedIn.

  --quota N          invitations this week (default ${DEFAULT_QUOTA})
  --per-company N    openings counted and listed per company (default ${DEFAULT_PER_COMPANY})
  --roles "A,B"      comma-separated role families to search per company
                     (default: ${DEFAULT_ROLES.join(', ')})
  --done "Company"   mark a company covered in data/network.json (repeatable),
                     then print the plan without it
  --out <path>       write the markdown plan to this file instead of stdout
  --json             print the plan as JSON instead of markdown
  --date YYYY-MM-DD  the date in the header and recorded by --done (default today)
  --help, -h         this text
`;
const KNOWN_FLAGS = ['--quota', '--per-company', '--roles', '--done', '--out', '--json', '--date', '--help', '-h'];
const VALUE_FLAGS = ['--quota', '--per-company', '--roles', '--done', '--out', '--date'];

function collectValues(args, flag) {
  const out = [];
  args.forEach((a, i) => {
    if (a === flag && args[i + 1] !== undefined) out.push(args[i + 1]);
    else if (typeof a === 'string' && a.startsWith(`${flag}=`)) out.push(a.slice(flag.length + 1));
  });
  return out;
}

function positiveInt(args, flag, fallback) {
  if (!hasFlag(args, flag)) return fallback;
  const value = safeIntFlag(flagValue(args, flag), NaN);
  if (!Number.isSafeInteger(value) || value < 1) {
    console.error(`Error: ${flag} must be a positive integer`);
    process.exit(1);
  }
  return value;
}

function main(args) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const quota = positiveInt(args, '--quota', DEFAULT_QUOTA);
  const perCompany = positiveInt(args, '--per-company', DEFAULT_PER_COMPANY);
  const rolesFlag = flagValue(args, '--roles');
  const roles = rolesFlag === undefined
    ? DEFAULT_ROLES
    : rolesFlag.split(',').map((r) => r.trim()).filter(Boolean);
  if (roles.length === 0) {
    console.error('Error: --roles needs at least one role, e.g. --roles "Engineering Manager,CTO"');
    process.exit(1);
  }
  const date = flagValue(args, '--date') ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('Error: --date must be YYYY-MM-DD');
    process.exit(1);
  }

  const dataRoot = getCareerOpsRoot();
  const trackerPath = resolveTrackerPath(dataRoot);
  const pipelinePath = process.env.CAREER_OPS_PIPELINE || join(dataRoot, 'data', 'pipeline.md');
  const donePath = join(dataRoot, 'data', 'network.json');

  let done = loadDone(donePath);
  const marked = collectValues(args, '--done').map((c) => c.trim()).filter(Boolean);
  if (marked.length > 0) {
    done = markDone(marked, done, date);
    saveDone(done, donePath);
    console.error(`network-plan: marked ${marked.length} compan${marked.length === 1 ? 'y' : 'ies'} covered in ${donePath}`);
  }

  const trackerRows = readTrackerRows(trackerPath);
  const pipelineRows = existsSync(pipelinePath) ? parsePipelineRows(readFileSync(pipelinePath, 'utf-8')) : [];
  const companies = rankCompanies(trackerRows, pipelineRows, { perCompany, done });

  if (hasFlag(args, '--json')) {
    const payload = {
      date,
      quota,
      perCompany,
      roles,
      done: marked,
      companies: companies.map((c) => ({
        company: c.company,
        score: c.score,
        applied: c.applied,
        openings: c.openings.map(({ title, url, state, source }) => ({ title, url, state, source })),
        companyUrl: companySearchUrl(c.company),
        people: roles.map((role) => ({ role, url: peopleSearchUrl(c.company, role) })),
      })),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const text = renderPlan(companies, { quota, roles, date });
  const out = flagValue(args, '--out');
  if (out !== undefined) {
    const target = resolve(out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, 'utf-8');
    console.log(`Wrote ${target} (${companies.length} compan${companies.length === 1 ? 'y' : 'ies'})`);
    return;
  }
  process.stdout.write(text);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
