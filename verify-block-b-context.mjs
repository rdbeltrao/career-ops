#!/usr/bin/env node

/**
 * verify-block-b-context.mjs — zero-LLM check that a report's Block B does
 * not mark a requirement missing when modes/_context.md carries it.
 *
 * modes/_context.md is the source of truth about the candidate: every fact
 * and figure in it is evidence, and cv.md is a tailored rendering of it. A
 * Block B row ("Match with CV", also headed "B) Match with CV", "Block B —
 * Match with CV" or "CV Match") that reads `❌ Missing` therefore means that
 * neither the primary files nor the context file carry the fact. An
 * evaluation that judged the candidate on cv.md alone marks real experience
 * as missing, and "none in cv.md" is never a gap by itself. This script reads
 * the table back and flags both shapes:
 *
 *   context-has-it     a row marked missing whose Requirement names a
 *                      technology or product the context also names (a token
 *                      with a digit, or capitalized inside the cell and
 *                      written as a name in the context), or repeats a
 *                      two-word phrase of the context in which at least one
 *                      word is specific ("event driven", "information
 *                      architecture"); the targeting sections of the context
 *                      and its aspiration lines never count
 *   cv-silence-as-gap  any row whose Evidence / gap cell gives cv.md's silence
 *                      as the gap ("None in cv.md", "cv.md does not mention")
 *
 * The match is deliberately strict: it tokenizes on letters and digits, drops
 * common English, career-ops filler and the generic engineering words every
 * context file shares, keeps tokens of four characters or more and applies a
 * light stem (ies to y, es, s, ing, ed). A single ordinary word, however rare,
 * never raises a finding, so the check misses some rows the context could
 * answer; the cv-silence-as-gap shape catches the habit behind most of them.
 * It raises a row for the reader to look at; it never rewrites the report, and
 * a finding is a prompt to re-read the context, not a verdict.
 *
 * Usage:
 *   node verify-block-b-context.mjs <report.md> [--context <path>] [--json] [--strict]
 *
 *   --context  the context file to compare against (default
 *              {DATA_ROOT}/modes/_context.md)
 *   --json     print { report, context, status, reason?, findings } instead of text
 *   --strict   exit 1 when there is at least one finding, or when the Block B
 *              table could not be found
 *
 * Exit codes:
 *   0  the check ran (findings or none), or no Block B table was found
 *      (status "unverified") without --strict
 *   1  --strict and at least one finding or an unverified report
 *   2  usage error, unreadable report, or absent context file; an absent
 *      context is "unverified", never a pass
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { cleanHeading } from './web/src/lib/report-sections.mjs';
import { colIndex, parsePipeTable, splitPipeTables } from './web/src/lib/report-tables.mjs';

const USAGE = 'Usage: node verify-block-b-context.mjs <report.md> [--context <path>] [--json] [--strict]';

const BLOCK_B_HEADING_RE = /\b(?:cv match|match with cv)\b/i;
const MISSING_RE = /❌|\bmissing\b/i;
const CV_SILENCE_RES = [
  /\b(?:none|not|nothing|no mention|absent)\b[^|]{0,40}\bcv\.md\b/i,
  /\bcv\.md\b[^|]{0,30}\b(?:silent|does not|doesn't|lacks)\b/i,
];
const CV_SILENCE_DETAIL = 'cv.md silence is never a gap; cite modes/_context.md or mark the row from what the context says';

// Common English plus the filler a JD requirement row repeats on every line.
// A term on this list never counts as a match, whatever the context says.
const STOPWORDS = new Set([
  'about', 'above', 'across', 'after', 'again', 'against', 'along', 'also', 'among', 'another', 'around',
  'because', 'been', 'before', 'being', 'below', 'between', 'both', 'could', 'does', 'doing', 'down', 'during',
  'each', 'either', 'else', 'even', 'ever', 'every', 'from', 'further', 'have', 'having', 'here', 'highly',
  'into', 'itself', 'just', 'like', 'many', 'might', 'more', 'most', 'much', 'must', 'need', 'needed', 'needs',
  'once', 'only', 'other', 'others', 'over', 'same', 'several', 'shall', 'should', 'since', 'some', 'something',
  'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under',
  'until', 'upon', 'used', 'using', 'very', 'well', 'were', 'what', 'when', 'where', 'which', 'while', 'will',
  'with', 'within', 'without', 'would', 'your', 'yours',
  // career-ops and JD filler
  'ability', 'able', 'advanced', 'background', 'basic', 'best', 'build', 'building', 'business', 'capability',
  'comfortable', 'company', 'complex', 'deep', 'demonstrated', 'depth', 'desirable', 'excellent', 'experience',
  'experienced', 'expertise', 'familiar', 'familiarity', 'good', 'great', 'hands', 'high', 'ideally', 'including',
  'knowledge', 'large', 'lead', 'leading', 'level', 'minimum', 'modern', 'multiple', 'nice', 'passion', 'passionate',
  'plus', 'practice', 'practices', 'preferred', 'previous', 'prior', 'proficiency', 'proficient', 'proven', 'quality',
  'record', 'related', 'relevant', 'required', 'requirement', 'requirements', 'role', 'roles', 'scale', 'senior',
  'skill', 'skills', 'solid', 'strong', 'successful', 'team', 'teams', 'track', 'understanding', 'willingness',
  'work', 'working', 'years',
]);

// Words that appear in almost every engineering-management context file, so a
// hit on one of them says nothing about this requirement. A generic term counts
// only inside a matched two-word phrase ("incident management", "developer
// platform"); on its own it never triggers a finding.
const GENERIC = new Set([
  'administration', 'agile', 'application', 'applications', 'architecture', 'automation', 'availability',
  'cloud', 'collaboration', 'communication', 'continuous', 'cross', 'culture', 'customer', 'customers', 'data',
  'delivery', 'design', 'developer', 'developers', 'development', 'digital', 'distributed', 'engineer',
  'engineering', 'engineers', 'environment', 'framework', 'frameworks', 'functional', 'global', 'growth',
  'improvement', 'infrastructure', 'initiative', 'initiatives', 'international', 'leadership', 'management',
  'manager', 'managers', 'metrics', 'mobile', 'open', 'operations', 'organisation', 'organization',
  'performance', 'platform', 'platforms', 'process', 'processes', 'product', 'products', 'program', 'programs',
  'project', 'projects', 'reliability', 'remote', 'review', 'reviews', 'security', 'service', 'services',
  'software', 'solution', 'solutions', 'source', 'stakeholder', 'stakeholders', 'standard', 'standards',
  'strategic', 'strategy', 'support', 'system', 'systems', 'technical', 'technologies', 'technology', 'tool',
  'tools', 'web', 'widely', 'adopted',
  // words a location, seniority or stack row shares with every context file
  'backend', 'based', 'database', 'databases', 'days', 'domain', 'frontend', 'fullstack', 'hands', 'hybrid',
  'industry', 'located', 'location', 'month', 'office', 'onsite', 'production', 'relocation', 'site', 'stack',
  'startup', 'startups', 'week', 'weekly',
]);

/**
 * Light stem shared by the requirement and the context so the two sides agree:
 * "ies" to "y", then one trailing "ing", "ed", "es" or "s".
 * @param {string} token lowercased
 * @returns {string}
 */
export function stem(token) {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/**
 * Split a cell or a file into its raw tokens: runs of letters (accents
 * included) and digits.
 * @param {string} text
 * @returns {string[]}
 */
function rawTokens(text) {
  return String(text ?? '').match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * The distinctive terms of a text, as a map from stemmed term to the first
 * original spelling, with a flag per term saying whether it looks like a
 * technology or product name: it carries a digit, or it is capitalized in the
 * text without opening it.
 *
 * @param {string} text
 * @returns {Map<string, {original: string, properNoun: boolean}>}
 */
export function distinctiveTerms(text) {
  const out = new Map();
  const tokens = rawTokens(text);
  tokens.forEach((original, index) => {
    const lower = original.toLowerCase();
    if (lower.length < 4 || STOPWORDS.has(lower)) return;
    const stemmed = stem(lower);
    if (stemmed.length < 4 || STOPWORDS.has(stemmed)) return;
    const hasDigit = /\p{N}/u.test(original);
    const capitalized = /^\p{Lu}/u.test(original) && index > 0;
    const properNoun = hasDigit || capitalized;
    const seen = out.get(stemmed);
    if (!seen) out.set(stemmed, { original, properNoun });
    else if (properNoun && !seen.properNoun) seen.properNoun = true;
  });
  return out;
}

/**
 * Every stemmed term that occurs in the context file (stopwords dropped so a
 * requirement term can never match one).
 * @param {string} text
 * @returns {Set<string>}
 */
export function contextTermSet(text) {
  return new Set(distinctiveTerms(text).keys());
}

/**
 * Adjacent stemmed pairs of a text, stopwords dropped first so "incident and
 * on-call management" and "incident management" give the same pair. Generic
 * words stay in: a two-word phrase is specific even when both words are not.
 * @param {string} text
 * @returns {Set<string>} pairs as "a b"
 */
export function phrasePairs(text) {
  const stems = rawTokens(text)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t))
    .map(stem)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  const out = new Set();
  for (let i = 0; i + 1 < stems.length; i++) out.add(`${stems[i]} ${stems[i + 1]}`);
  return out;
}

// Sections of modes/_context.md that say what the candidate wants or avoids,
// not what they did. A technology named under "Signals of a weak match" or as
// an aspiration is the opposite of evidence, so these never feed the term set.
const TARGETING_HEADING_RE = /^(?:target role|location and language|preferences\b.*|deal-breakers\b.*|signals of a (?:strong|weak) match)$/i;
const ASPIRATION_LINE_RE = /^\s*[-*]\s*(?:aspirations? only|managed, not hands-on|active learning)\b/i;

/**
 * The evidence part of a context file: every section except the targeting
 * ones, minus the lines that list aspirations or managed-only areas.
 * @param {string} text
 * @returns {string}
 */
export function evidenceText(text) {
  const kept = [];
  let skipping = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) skipping = TARGETING_HEADING_RE.test(heading[1].trim());
    if (skipping || ASPIRATION_LINE_RE.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Whether a capitalized token appears in the context as a name: with the same
 * spelling, after a comma, a parenthesis, a slash or a lowercase word on the
 * same line. A match only at the start of a line or a sentence does not count.
 * @param {string} token as written in the requirement cell
 * @param {string} contextText
 * @returns {boolean}
 */
export function namedInContext(token, contextText) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:[\\p{Ll}\\)\\],/]\\s*|[(/])${escaped}(?!\\p{L})`, 'u').test(contextText);
}

/**
 * Find Block B in a report: the section whose cleaned heading names the CV
 * match, running to the next heading of the same or a higher level so its
 * own sub-sections (Gaps, for one) stay inside it. Null when the report has
 * no such heading.
 *
 * @param {string} markdown
 * @returns {string|null}
 */
export function findBlockB(markdown) {
  const lines = String(markdown ?? '').split('\n');
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    if (start < 0) {
      if (BLOCK_B_HEADING_RE.test(cleanHeading(m[2]))) { start = i; level = m[1].length; }
    } else if (m[1].length <= level) {
      return lines.slice(start + 1, i).join('\n');
    }
  }
  return start < 0 ? null : lines.slice(start + 1).join('\n');
}

/**
 * The first pipe table in a Block B section whose header has a Match and a
 * Requirement column, with the column indexes the checks read.
 *
 * @param {string} section
 * @returns {{header: string[], rows: string[][], cols: {requirement: number, match: number, signal: number, evidence: number}} | null}
 */
export function findMatchTable(section) {
  for (const part of splitPipeTables(section)) {
    if (part.type !== 'table') continue;
    const table = parsePipeTable(part.text);
    if (!table) continue;
    const match = colIndex(table.header, ['match']);
    const requirement = colIndex(table.header, ['requirement']);
    if (match < 0 || requirement < 0) continue;
    return {
      ...table,
      cols: {
        requirement,
        match,
        signal: colIndex(table.header, ['jd signal', 'signal']),
        evidence: colIndex(table.header, ['evidence / gap', 'evidence', 'gap']),
      },
    };
  }
  return null;
}

/**
 * Run both checks over a Block B table.
 *
 * @param {ReturnType<typeof findMatchTable>} table
 * @param {string} contextText
 * @returns {Array<{kind: string, requirement: string, match: string, terms: string[], evidence: string, detail: string}>}
 */
export function checkRows(table, contextText) {
  const evidence = evidenceText(contextText);
  const context = contextTermSet(evidence);
  const contextPairs = phrasePairs(evidence);
  const findings = [];
  const cell = (row, index) => (index >= 0 ? String(row[index] ?? '').trim() : '');
  for (const row of table.rows) {
    const requirement = cell(row, table.cols.requirement);
    const match = cell(row, table.cols.match);
    const signal = cell(row, table.cols.signal);
    const evidence = cell(row, table.cols.evidence);
    if (!requirement) continue;
    if (MISSING_RE.test(match)) {
      // Only the requirement cell is matched: the JD signal column quotes the
      // posting, and its prose shares words with any context file.
      const terms = distinctiveTerms(requirement);
      const hits = [...terms.entries()].filter(([stemmed]) => context.has(stemmed));
      const isGeneric = ([stemmed, { original }]) => GENERIC.has(stemmed) || GENERIC.has(original.toLowerCase());
      // A finding needs a specific signal: two non-generic terms, one
      // technology-looking token (a digit, or a capital inside the cell), or a
      // two-word phrase the context repeats. One ordinary word, or any number
      // of generic ones ("system", "production"), is not a signal.
      // A name counts only when the context also writes it as a name: inside a
      // sentence or a list, never only at the start of a line, where any word
      // is capitalized ("Core, many years hands-on" is not the product Core).
      const nameHits = hits.filter((hit) => !isGeneric(hit) && hit[1].properNoun && namedInContext(hit[1].original, evidence));
      // A phrase counts when at least one of its words is specific.
      const pairHits = [...phrasePairs(requirement)]
        .filter((pair) => contextPairs.has(pair))
        .filter((pair) => pair.split(' ').some((w) => !GENERIC.has(w)));
      if (nameHits.length >= 1 || pairHits.length >= 1) {
        const matched = hits.map(([, { original }]) => original);
        const phrases = pairHits.map((p) => `"${p}"`);
        const mentions = [...matched, ...phrases.filter((p) => !matched.some((m) => p.includes(m.toLowerCase())))];
        findings.push({
          kind: 'context-has-it',
          requirement,
          match,
          terms: matched,
          evidence,
          detail: `modes/_context.md mentions ${mentions.join(', ')}; check the row: a requirement the context carries is Strong or Partial, never Missing`,
        });
      }
    }
    if (evidence && CV_SILENCE_RES.some((re) => re.test(evidence))) {
      findings.push({ kind: 'cv-silence-as-gap', requirement, match, terms: [], evidence, detail: CV_SILENCE_DETAIL });
    }
  }
  return findings;
}

/**
 * The whole check for one report.
 *
 * @param {{reportPath: string, contextPath: string}} opts
 * @returns {{report: string, context: string, status: 'ok'|'findings'|'unverified', reason?: string, findings: object[], exitCode: number}}
 */
export function verifyBlockBContext({ reportPath, contextPath }) {
  const base = { report: reportPath, context: contextPath, findings: [] };
  if (!existsSync(reportPath)) {
    return { ...base, status: 'unverified', reason: `report not found: ${reportPath}`, exitCode: 2 };
  }
  if (!existsSync(contextPath)) {
    return { ...base, status: 'unverified', reason: `context file not found: ${contextPath}`, exitCode: 2 };
  }
  let report;
  let contextText;
  try {
    report = readFileSync(reportPath, 'utf-8');
    contextText = readFileSync(contextPath, 'utf-8');
  } catch (err) {
    return { ...base, status: 'unverified', reason: `could not read: ${err.message}`, exitCode: 2 };
  }
  const section = findBlockB(report);
  const table = section === null ? null : findMatchTable(section);
  if (!table) {
    return { ...base, status: 'unverified', reason: 'no-block-b-table', exitCode: 0 };
  }
  const findings = checkRows(table, contextText);
  return { ...base, status: findings.length ? 'findings' : 'ok', findings, exitCode: 0 };
}

/**
 * @param {string[]} argv
 * @returns {{reportPath: string, contextPath: string, json: boolean, strict: boolean} | {error: string} | {help: true}}
 */
export function parseArgs(argv) {
  let reportArg = null;
  let contextArg = null;
  let json = false;
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') json = true;
    else if (a === '--strict') strict = true;
    else if (a === '--context') {
      contextArg = argv[++i];
      if (!contextArg) return { error: '--context needs a path' };
    } else if (a.startsWith('--')) return { error: `unknown flag ${a}` };
    else if (reportArg === null) reportArg = a;
    else return { error: `unexpected extra argument: ${a}` };
  }
  if (reportArg === null) return { error: 'a report path is required' };
  const contextPath = contextArg ? resolve(contextArg) : join(getCareerOpsRoot(), 'modes', '_context.md');
  return { reportPath: resolve(reportArg), contextPath, json, strict };
}

/**
 * @param {ReturnType<typeof verifyBlockBContext>} result
 * @returns {string}
 */
export function formatText(result) {
  const lines = [];
  for (const f of result.findings) {
    lines.push(`⚠️  ${f.kind}  row "${f.requirement}" (${f.match}): ${f.detail}`);
  }
  if (result.status === 'unverified') {
    lines.push(`UNVERIFIED: ${result.reason} (${result.report})`);
  } else {
    lines.push(`${result.findings.length} finding(s) in ${result.report}`);
  }
  return `${lines.join('\n')}\n`;
}

if (isMainModule(import.meta.url)) {
  const parsed = parseArgs(process.argv.slice(2));
  if ('help' in parsed) { console.log(USAGE); process.exit(0); }
  if ('error' in parsed) { console.error(`Error: ${parsed.error}\n${USAGE}`); process.exit(2); }
  const { exitCode, ...result } = verifyBlockBContext(parsed);
  if (parsed.json) {
    const { report, context, status, reason, findings } = result;
    console.log(JSON.stringify({ report, context, status, ...(reason ? { reason } : {}), findings: findings.map(({ kind, requirement, match, terms, evidence }) => ({ kind, requirement, match, terms, evidence })) }, null, 2));
    if (exitCode === 2) console.error(`Error: ${reason}`);
  } else if (exitCode === 2) {
    console.error(`Error: ${result.reason}`);
  } else {
    process.stdout.write(formatText(result));
  }
  if (exitCode !== 0) process.exit(exitCode);
  if (parsed.strict && (result.findings.length || result.status === 'unverified')) process.exit(1);
}
