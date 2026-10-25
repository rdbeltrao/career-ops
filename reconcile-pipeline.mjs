#!/usr/bin/env node
/**
 * reconcile-pipeline.mjs — move evaluated postings out of pipeline.md Pending
 *
 * THE PROBLEM
 * Every evaluation path writes a report and a tracker row, but only the batch
 * runner ever moved the pipeline row to Processed, and only by reading
 * batch/batch-state.tsv. Reports written by the interactive mode, the web
 * evaluate action or the OpenRouter runner left their rows under Pending, so
 * they came back in the web INBOX and in the next pipeline run.
 *
 * WHAT THIS DOES
 * Reconciles data/pipeline.md against three sources and moves every Pending
 * row that has a report under Processed, through lib/pipeline-processed.mjs
 * (the same helper persist-evaluation-report.mjs, merge-tracker.mjs and
 * openrouter-runner.mjs call the moment a report is persisted):
 *
 *   1. batch/batch-state.tsv — `completed` and `skipped` batch offers, as before
 *   2. reports/*.md          — every report's `**URL:**`, `**Score:**`, `**PDF:**`
 *   3. data/applications.md — every tracker row that links a report, by URL
 *
 * Rows are matched by posting key (url-key.mjs), so a tracking parameter, a
 * trailing slash or http/https never leaves a second copy. The Processed row
 * keeps the shape this script has always written: report link, URL, company,
 * role, score and PDF flag. A report with no tracker row gets one, built from
 * the report header and merged through merge-tracker.mjs, never by editing
 * the tracker markdown here.
 *
 * Idempotent: a row already under Processed is a no-op, a stale Pending twin
 * is dropped. Safe to run after every batch, after every scan, and once as a
 * backfill.
 *
 * Run: node reconcile-pipeline.mjs [--dry-run] [--no-tracker] [--state <path>] [--pipeline <path>]
 */

import { readFileSync, existsSync, readdirSync, realpathSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { normalizeReportLink } from './tracker-links.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';
import { LockTimeoutError } from './pipeline-lock.mjs';
import { sectionKind } from './lib/pipeline-sections.mjs';
import { markPipelineProcessed, rowKey, pendingRowFields, PENDING_ITEM_RE } from './lib/pipeline-processed.mjs';
import { companyRoleDedupKey, requisitionIdsForDedup } from './scan.mjs';
import { resolveColumns, parseTrackerRow, extractTrackerReportNumbers, extractCellUrl } from './tracker-parse.mjs';
import { trackerTsvLine, normalizedTrackerScore, isPostingUrl } from './lib/tracker-addition.mjs';

const CAREER_OPS = getCareerOpsRoot();
const CODEBASE_ROOT = dirname(fileURLToPath(import.meta.url));

const KNOWN_FLAGS = ['--dry-run', '--no-tracker', '--pipeline', '--state', '--help', '-h'];
const VALUE_FLAGS = ['--pipeline', '--state'];
const USAGE = `Usage: node reconcile-pipeline.mjs [--dry-run] [--no-tracker] [--state <path>] [--pipeline <path>]
  Moves evaluated offers out of pipeline.md "Pendientes" into "Procesadas", matched by
  posting URL against batch-state.tsv, reports/ and the tracker, or by company and
  role against an evaluation report written for another URL; creates a tracker
  row for a report that has none (--no-tracker skips that step).`;

// An unrecognized flag (typo'd --dry-run, say) used to be silently ignored
// and fall through to a LIVE run that writes pipeline.md — the caller
// believed they were in dry-run mode and were not. Fail fast instead.
const args = process.argv.slice(2);
validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

const DRY_RUN = args.includes('--dry-run');
const NO_TRACKER = args.includes('--no-tracker');

// Pipeline writes stay inside the data root. Batch state can also live in the
// code checkout, where batch-runner.sh keeps it under batch/.
// Symlinks are resolved first (realpathSync) so an in-repo symlink cannot
// smuggle the real target outside the tree past a purely lexical check.
function resolveInsideRepo(inputPath, fallbackPath, flag, roots = [CAREER_OPS]) {
  const abs = resolve(inputPath || fallbackPath);
  let repoRoots, targetReal;
  try {
    repoRoots = roots.map(root => realpathSync(root));
    // The target may not exist yet (e.g. a fresh --pipeline path); fall back to
    // its parent directory so the symlink-resolved boundary check still applies.
    targetReal = existsSync(abs) ? realpathSync(abs) : realpathSync(dirname(abs));
  } catch {
    console.error(`Invalid ${flag}: cannot resolve path (${abs})`);
    process.exit(1);
  }
  if (!repoRoots.some(root => {
    const rel = relative(root, targetReal);
    return !rel.startsWith('..') && !isAbsolute(rel);
  })) {
    console.error(`Invalid ${flag}: path must stay inside the repository (${abs})`);
    process.exit(1);
  }
  // Reject a directory target early — otherwise readFileSync/copyFileSync would
  // throw an unhandled EISDIR later instead of failing with a clear message.
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    console.error(`Invalid ${flag}: expected a file, not a directory (${abs})`);
    process.exit(1);
  }
  return abs;
}

const defaultPipeline = existsSync(join(CAREER_OPS, 'data/pipeline.md'))
  ? join(CAREER_OPS, 'data/pipeline.md')
  : join(CAREER_OPS, 'pipeline.md');
const PIPELINE_FILE = resolveInsideRepo(flagValue(args, '--pipeline'), defaultPipeline, '--pipeline');
const STATE_FILE = resolveInsideRepo(flagValue(args, '--state'), join(CODEBASE_ROOT, 'batch/batch-state.tsv'), '--state', [CODEBASE_ROOT, CAREER_OPS]);
const REPORTS_DIR = join(CAREER_OPS, 'reports');
const TRACKER_FILE = resolveTrackerPath(CAREER_OPS);
const ADDITIONS_DIR = process.env.CAREER_OPS_ADDITIONS || join(CAREER_OPS, 'batch', 'tracker-additions');

if (!existsSync(PIPELINE_FILE)) {
  console.log('No pipeline.md found — nothing to reconcile.');
  process.exit(0);
}

// ---- report lookup ----
let reportFiles = [];
try { reportFiles = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')); } catch { /* no reports dir */ }

function reportNumberOf(file) {
  const m = file.match(/^(\d+)-/);
  return m ? parseInt(m[1], 10) : null;
}

function findReportFile(reportNum) {
  if (!reportNum || reportNum === '-') return null;
  const n = parseInt(reportNum, 10);
  if (Number.isNaN(n)) return null;
  return reportFiles.find(f => reportNumberOf(f) === n && !/-RESERVED\.md$/.test(f)) || null;
}

const reportTextCache = new Map();
function reportText(reportFile) {
  if (!reportTextCache.has(reportFile)) {
    try { reportTextCache.set(reportFile, readFileSync(join(REPORTS_DIR, reportFile), 'utf-8')); }
    catch { reportTextCache.set(reportFile, null); }
  }
  return reportTextCache.get(reportFile);
}

function readReportField(reportFile, field) {
  const txt = reportFile ? reportText(reportFile) : null;
  if (!txt) return null;
  // An empty header is unknown; never borrow the following URL/PDF line.
  const m = txt.match(new RegExp(`^\\*\\*${field}:\\*\\*([^\\r\\n]*)$`, 'm'));
  return m ? m[1].trim() : null;
}

// The posting URL of a report: the first `**URL:**` line that carries an
// http(s) URL. openrouter-runner.mjs prefixes its reports with `**URL:**
// (pasted)` when the JD was pasted, and the model's own header line with the
// real URL follows, so the first match is not always the one.
function readReportUrl(reportFile) {
  const txt = reportFile ? reportText(reportFile) : null;
  if (!txt) return null;
  for (const m of txt.matchAll(/^\*\*URL:\*\*([^\r\n]*)$/gm)) {
    const candidate = m[1].trim().split(/\s/)[0];
    if (isPostingUrl(candidate)) return candidate;
  }
  return null;
}

function formatScore(value) {
  return /^\d+(?:\.\d+)?$/.test(value) && Number(value) <= 5 ? `${value}/5` : null;
}

// A valid numeric state score is authoritative; otherwise fall back to the report.
function resolveScore(stateScore, reportFile) {
  const state = formatScore(stateScore ?? '');
  if (state) return state;
  const rep = readReportField(reportFile, 'Score');
  if (rep) {
    // Scores may have Markdown decoration or trailing prose. The first
    // denominator is authoritative even when an annotation precedes it,
    // matching evaluator score cells: "4.2 (strong fit)/10" is not 4.2/5.
    const score = rep.match(/^[*_`]*(\d+(?:\.\d+)?)(?=$|[\s*_`/,(—–-])/);
    if (!score) return 'N/A';
    const denominator = rep.match(/\/[ \t]*(\d+(?:\.\d+)?)/);
    if (denominator) {
      const tail = rep.slice(denominator.index + denominator[0].length);
      if (Number(denominator[1]) !== 5 || (tail && !/^[\s*_`,;:.()\]—–-]/.test(tail))) return 'N/A';
    } else if (/^[*_`]*[ \t]*\//.test(rep.slice(score[0].length))) {
      return 'N/A'; // An explicit but unreadable scale is not a bare score.
    }
    return formatScore(score[1]) || 'N/A';
  }
  return 'N/A';
}

// The report header names the PDF path when one was generated, and otherwise
// says "not generated" in the user's output language. Only the path is the
// same in every language.
function resolvePdf(reportFile) {
  const rep = readReportField(reportFile, 'PDF');
  // A filename ending in .pdf (path or basename), not a bare ".pdf" mention in
  // a localized "not generated" note.
  return rep && (/[^\s]+\.pdf\b/i.test(rep) || rep.includes('✅')) ? '✅' : '❌';
}

function reportLinkFor(reportFile) {
  const num = reportNumberOf(reportFile);
  return normalizeReportLink(`[${num}](reports/${reportFile})`, dirname(PIPELINE_FILE), CAREER_OPS);
}

// Company and role: the Machine Summary scalars first, then the
// `# Evaluation: Company — Role` title (em dash, en dash, double or single
// hyphen), then the comma form some runner reports use.
function yamlScalar(block, key) {
  const m = block.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  if (!m) return null;
  let v = m[1].trim();
  if (!v || v === 'null' || v === '~') return null;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v.trim() || null;
}
function reportTitle(reportFile) {
  const txt = reportText(reportFile);
  if (!txt) return null;
  const fence = txt.match(/##\s*Machine Summary\s*\n+```(?:yaml|yml)?\s*\n([\s\S]*?)\n```/i)?.[1] ?? '';
  const company = yamlScalar(fence, 'company');
  const role = yamlScalar(fence, 'role');
  if (company && role && company !== '?') return { company, role };
  const dash = txt.match(/^#\s+Evaluation:\s+(.+?)\s+(?:—|--|–|-)\s+(.+?)\s*$/m);
  if (dash) return { company: dash[1].trim(), role: dash[2].trim() };
  const comma = txt.match(/^#\s+Evaluation:\s+([^,\n]+),\s*(.+?)\s*$/m);
  if (comma) return { company: comma[1].trim(), role: comma[2].trim() };
  return null;
}

// ---- source 1: batch-state.tsv ----
// columns: id  url  status  started_at  completed_at  report_num  score  error  retries
const entriesByKey = new Map(); // posting key -> entry for lib/pipeline-processed.mjs
const skippedNoReport = [];
function addEntry(entry, { source }) {
  const key = rowKey(entry.url);
  if (!key) return;
  const existing = entriesByKey.get(key);
  // A report-backed entry beats a bare one; the first report-backed entry wins.
  if (existing && (existing.reportLink || !entry.reportLink)) return;
  entriesByKey.set(key, { ...entry, source });
}

if (existsSync(STATE_FILE)) {
  for (const line of readFileSync(STATE_FILE, 'utf-8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('id\t')) continue;
    const c = line.split('\t');
    if (c.length < 7) continue;
    const [, url, status, , , reportNum, score, error] = c;
    // "completed" and "skipped" (below --min-score) both produced a report. A
    // dealbreaker skip (batch-prompt.md Step 1.6) is finished without one: its
    // SKIP tracker row is the record.
    if (status !== 'completed' && status !== 'skipped') continue;
    if (!url || !url.trim()) continue;
    if (status === 'skipped' && (error || '').startsWith('dealbreaker:')) {
      addEntry({ url: url.trim(), skip: true }, { source: 'batch-state' });
      continue;
    }
    const reportFile = findReportFile((reportNum || '').trim());
    if (!reportFile) {
      // A Jev skip (`--skip-jev-verdict`, `--min-jev`) never had a report: the
      // posting was not evaluated and stays pending without a warning. Any
      // other row that names a report that is not on disk is worth a warning,
      // and the row stays in Pendientes rather than getting a dead link.
      if (status === 'skipped' && /\b(verdict-skip|below-min-jev)\b/.test(error || '')) continue;
      skippedNoReport.push({ url: url.trim(), reportNum: (reportNum || '').trim() || '?' });
      continue;
    }
    addEntry({ url: url.trim(), reportLink: reportLinkFor(reportFile), score: resolveScore((score || '').trim(), reportFile), pdf: resolvePdf(reportFile) }, { source: 'batch-state' });
  }
}

// ---- source 2: reports/*.md ----
// Only an evaluation counts: a file under reports/ that stopped before Block A
// (a Jev hard stop, an agency pause waiting for the candidate's answer) has
// no score header, no evaluation title and no Machine Summary, and its
// posting is still pending.
function isEvaluationReport(file) {
  const txt = reportText(file);
  return Boolean(txt) && (/^\*\*Score:\*\*/m.test(txt) || /^#\s+Evaluation:/m.test(txt) || /^##\s*Machine Summary/m.test(txt));
}
const reportsByNumber = new Map();
for (const file of reportFiles) {
  const num = reportNumberOf(file);
  if (num === null || /-RESERVED\.md$/.test(file)) continue;
  const txt = reportText(file);
  if (!txt || !txt.trim() || !isEvaluationReport(file)) continue;
  reportsByNumber.set(num, file);
  const url = readReportUrl(file);
  if (!url) continue;
  addEntry({ url, reportLink: reportLinkFor(file), score: resolveScore(null, file), pdf: resolvePdf(file) }, { source: 'reports' });
}

// ---- source 3: the tracker ----
const trackerReportNumbers = new Set();
if (existsSync(TRACKER_FILE)) {
  const lines = readFileSync(TRACKER_FILE, 'utf-8').split(/\r?\n/);
  const colmap = resolveColumns(lines);
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    const numbers = extractTrackerReportNumbers(row.report, row.notes);
    for (const n of numbers) trackerReportNumbers.add(parseInt(n, 10));
    const url = extractCellUrl(row.url ?? '');
    if (!url || !isPostingUrl(url)) continue;
    const reportFile = numbers.length ? findReportFile(numbers[0]) : null;
    if (!reportFile) continue; // a row without a report is not an evaluation
    addEntry({ url, reportLink: reportLinkFor(reportFile), score: resolveScore(null, reportFile), pdf: resolvePdf(reportFile) }, { source: 'tracker' });
  }
}

// ---- source 4: company and role ----
// The same role often reaches the pipeline under two URLs: a LinkedIn search
// and the employer's own Ashby or Greenhouse board. Once one copy is
// evaluated, the other is not a new posting, so a pending row whose company
// and role match an evaluation report moves to Processed with that report's
// link. The key is scan.mjs's company+role dedup key, the one the scanners use
// to refuse such a row at ingestion. Two postings that name different
// requisition IDs stay distinct, as they do there.
const evaluatedRoles = new Map(); // company+role key -> { file, url }
for (const [, file] of [...reportsByNumber.entries()].sort((a, b) => b[0] - a[0])) {
  const title = reportTitle(file);
  if (!title || title.company === '?') continue;
  const key = companyRoleDedupKey(title.company, title.role);
  if (!evaluatedRoles.has(key)) evaluatedRoles.set(key, { file, url: readReportUrl(file) || '' });
}
const requisitionForms = (url, role) => {
  const forms = requisitionIdsForDedup({ url, text: role });
  return (Array.isArray(forms) ? forms : [forms]).filter(Boolean);
};
if (evaluatedRoles.size && existsSync(PIPELINE_FILE)) {
  for (const line of readFileSync(PIPELINE_FILE, 'utf-8').split(/\r?\n/)) {
    if (!PENDING_ITEM_RE.test(line)) continue;
    const { url, company, role } = pendingRowFields(line);
    if (!url || !company || !role || entriesByKey.has(rowKey(url))) continue;
    const hit = evaluatedRoles.get(companyRoleDedupKey(company, role));
    if (!hit) continue;
    const mine = requisitionForms(url, role);
    const theirs = requisitionForms(hit.url, role);
    if (mine.length && theirs.length && !mine.some((form) => theirs.includes(form))) continue;
    addEntry({ url, reportLink: reportLinkFor(hit.file), score: resolveScore(null, hit.file), pdf: resolvePdf(hit.file) }, { source: 'company-role' });
  }
}

// ---- reports with no tracker row ----
// A report whose addition merge-tracker.mjs has already seen is covered, even
// when no row links it: the merge may have folded it into an existing row as
// a re-evaluation of the same company and role, or refused it because the
// batch recorded that number as failed. Writing the TSV again would only
// repeat that decision on every run. Additions are read by their `num` cell
// (headed or legacy), both the ones still waiting and the ones in merged/.
const pendingAdditionNumbers = new Set();
function additionNumber(file) {
  let text;
  try { text = readFileSync(file, 'utf-8'); } catch { return null; }
  const rows = text.split(/\r?\n/).filter(l => l.trim());
  if (!rows.length) return null;
  const header = rows[0].split('\t');
  const numCol = header.indexOf('num');
  const data = numCol >= 0 ? rows[1]?.split('\t') : rows[0].split('\t');
  const cell = data?.[numCol >= 0 ? numCol : 0] ?? '';
  return /^\d+$/.test(cell.trim()) ? parseInt(cell, 10) : null;
}
for (const dir of [ADDITIONS_DIR, join(ADDITIONS_DIR, 'merged')]) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.tsv')) continue;
    const n = additionNumber(join(dir, f));
    if (n !== null) pendingAdditionNumbers.add(n);
  }
}
const missingTrackerRows = [];
for (const [num, file] of [...reportsByNumber.entries()].sort((a, b) => a[0] - b[0])) {
  if (trackerReportNumbers.has(num) || pendingAdditionNumbers.has(num)) continue;
  const title = reportTitle(file);
  const date = (readReportField(file, 'Date') || '').match(/^\d{4}-\d{2}-\d{2}/)?.[0] || file.match(/-(\d{4}-\d{2}-\d{2})\.md$/)?.[1] || null;
  if (!title || !date) {
    console.warn(`⚠️  reports/${file} has no tracker row and no readable title or date — left alone.`);
    continue;
  }
  const url = readReportUrl(file) || '';
  const score = normalizedTrackerScore(resolveScore(null, file));
  const slug = file.slice(String(num).padStart(3, '0').length + 1, file.length - date.length - 4).replace(/-$/, '') || 'report';
  missingTrackerRows.push({ num, file, slug, title, date, url, score });
}

// ---- reconcile ----
const entries = [...entriesByKey.values()];
console.log('=== Reconcile pipeline.md ===');
for (const s of skippedNoReport) {
  console.warn(`⚠️  ${s.url} — batch reports report #${s.reportNum} but no reports/${s.reportNum}-*.md found; left in Pendientes.`);
}
console.log(`Sources: ${entries.filter(e => e.source === 'batch-state').length} batch-state, ${entries.filter(e => e.source === 'reports').length} reports, ${entries.filter(e => e.source === 'tracker').length} tracker, ${entries.filter(e => e.source === 'company-role').length} same company and role (${entries.length} distinct postings)`);

let result;
try {
  result = await markPipelineProcessed(PIPELINE_FILE, entries, { dryRun: DRY_RUN, backup: true });
} catch (err) {
  if (!(err instanceof LockTimeoutError)) throw err;
  console.error(`❌ ${err.message} — another process is writing pipeline.md; nothing was changed. Re-run once it finishes.`);
  process.exit(1);
}

if (result.noPendingSection) {
  console.log('No "Pendientes" section in pipeline.md — nothing to reconcile.');
} else if (!result.changed) {
  console.log('✅ pipeline.md already in sync — nothing to reconcile.');
} else {
  console.log(`🔄 ${result.moved.length} processed entr${result.moved.length === 1 ? 'y' : 'ies'} moved Pendientes → Procesadas:`);
  for (const m of result.moved) {
    const num = m.skip ? '-' : (m.reportLink.match(/^\[(\d+)\]/)?.[1] ?? '?');
    console.log(`   + #${num} ${m.company} — ${m.role} (${m.skip ? 'SKIP, dealbreaker' : m.score})`);
  }
  if (result.dropped.length) console.log(`🧹 ${result.dropped.length} stale Pendientes entr${result.dropped.length === 1 ? 'y' : 'ies'} dropped (already in Procesadas).`);
  console.log(`📋 Pendientes now: ${result.pendingAfter} entr${result.pendingAfter === 1 ? 'y' : 'ies'} (was ${result.pendingBefore})`);
  if (DRY_RUN) console.log('(dry-run — no changes written)');
  else console.log(`✅ pipeline.md updated (backup: ${PIPELINE_FILE}.pre-reconcile.bak)`);
}

// ---- tracker rows for reports that have none ----
if (NO_TRACKER) {
  if (missingTrackerRows.length) console.log(`ℹ️  ${missingTrackerRows.length} report(s) have no tracker row (--no-tracker: left alone).`);
} else if (missingTrackerRows.length) {
  console.log(`\n📝 ${missingTrackerRows.length} report(s) have no tracker row:`);
  for (const r of missingTrackerRows) console.log(`   + #${r.num} ${r.title.company} — ${r.title.role} (${r.score})`);
  if (DRY_RUN) {
    console.log('(dry-run — no tracker additions written, merge-tracker.mjs not run)');
  } else {
    mkdirSync(ADDITIONS_DIR, { recursive: true });
    for (const r of missingTrackerRows) {
      const tsv = trackerTsvLine({ num: String(r.num).padStart(3, '0'), today: r.date, company: r.title.company, role: r.title.role, score: r.score, reportFile: r.file, notes: 'tracker row added by reconcile-pipeline.mjs from the report header', via: null, url: r.url });
      writeFileSync(join(ADDITIONS_DIR, `rc-${String(r.num).padStart(3, '0')}-${r.slug}.tsv`), tsv, 'utf-8');
    }
    console.log(`   wrote ${missingTrackerRows.length} addition(s) to ${ADDITIONS_DIR}; running merge-tracker.mjs`);
    try {
      execFileSync(process.execPath, [join(CODEBASE_ROOT, 'merge-tracker.mjs')], { cwd: CODEBASE_ROOT, stdio: 'inherit' });
    } catch (err) {
      console.error(`❌ merge-tracker.mjs failed (${err.status ?? err.message}); the additions stay in ${ADDITIONS_DIR} for the next merge.`);
      process.exitCode = 1;
    }
  }
}
