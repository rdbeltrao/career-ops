#!/usr/bin/env node
/** Audit by default. --apply repairs headers and delegates status writes to set-status. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { resolveColumns, parseTrackerRow, firstLinkTarget, extractCellUrl, trackerRowIdentity } from './tracker-parse.mjs';
import { writeFileAtomic } from './tracker-utils.mjs';
import { postingKey } from './url-key.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { evaluationReportState, readReportJev, withJevHeader, jevHeaderValue } from './lib/evaluation-report.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');

/** Pure plan, with report I/O injected so repairs can be tested on disposable data. */
export function planEvaluationRepairs(rows, readReport, savedRatings = new Map()) {
  const statuses = [];
  const reports = new Map();
  const gaps = [];
  for (const row of rows) {
    const report = readReport(row);
    let result = readReportJev(report?.text);
    const url = extractCellUrl(row.url ?? '');
    if (url && result.url && postingKey(url) !== postingKey(result.url)) {
      gaps.push({ num: row.num, reason: 'Linked report belongs to another posting.' });
      continue;
    }
    const state = evaluationReportState(report?.text);
    if (row.status === 'Evaluated' && (state === 'needs-review' || !report)) {
      statuses.push({ num: row.num, identity: trackerRowIdentity(row), from: row.status, to: 'Needs review',
        reason: report ? 'Saved file is a gate stop or confirmation request; evaluation was not completed.' : 'No evaluation report exists; completion cannot be verified.' });
    }
    if (!report) continue;
    // Rescore logs are evidence only when their named source report carries
    // the exact same posting URL. Tracker/report numbers are independent.
    const saved = result.status === 'missing' && result.url ? savedRatings.get(postingKey(result.url)) : null;
    if (saved) result = { ...result, jev: saved.jev, status: 'rated', source: saved.source };
    if (result.status === 'invalid') {
      gaps.push({ num: row.num, report: report.file, reason: 'Invalid or conflicting Jev evidence; left unchanged.' });
      continue;
    }
    if (result.jev || result.status === 'not-run') {
      let after = withJevHeader(report.text, result.jev ? jevHeaderValue(result.jev) : 'not run');
      if (saved) after = after.replace(/^(\*\*Jev:\*\*[^\n]*)/mi, `$1\n**Jev source:** ${saved.source}`);
      if (after !== report.text) reports.set(report.file, { file: report.file, before: report.text, after,
        source: result.source, jev: result.jev, digest: digest(report.text) });
    } else {
      gaps.push({ num: row.num, report: report.file, reason: 'No recoverable Jev result in the linked report.' });
    }
  }
  return { statuses, reports: [...reports.values()], gaps };
}

export function auditEvaluations(root, tracker) {
  const text = fs.readFileSync(tracker, 'utf8');
  const lines = text.split(/\r?\n/);
  const columns = resolveColumns(lines);
  const rows = lines.map(line => parseTrackerRow(line, columns)).filter(Boolean);
  const reportRoot = fs.realpathSync(path.join(root, 'reports'));
  const savedRatings = new Map();
  const output = path.join(root, 'output');
  for (const filename of fs.existsSync(output) ? fs.readdirSync(output).filter(f => /^jev-rescore-.*\.json$/.test(f)).sort() : []) {
    const rescore = JSON.parse(fs.readFileSync(path.join(output, filename), 'utf8'));
    for (const entry of rescore.results ?? []) {
      if (entry.error || typeof entry.fit !== 'number' || entry.fit < 0 || entry.fit > 100
        || typeof entry.jevScore !== 'number' || entry.jevScore < 0 || entry.jevScore > 5
        || !['apply', 'maybe', 'skip'].includes(entry.verdict) || path.basename(entry.report ?? '') !== entry.report) continue;
      const file = path.join(reportRoot, entry.report);
      if (!fs.existsSync(file) || !fs.realpathSync(file).startsWith(reportRoot + path.sep)) continue;
      const { url } = readReportJev(fs.readFileSync(file, 'utf8'));
      if (!url) continue;
      savedRatings.set(postingKey(url), { jev: { fit: entry.fit, score: entry.jevScore, verdict: entry.verdict },
        source: `output/${filename}, scored ${rescore.scoredAt ?? 'date unknown'}; matched by posting URL` });
    }
  }
  const plan = planEvaluationRepairs(rows, row => {
    // A tracker number is never a report identity. Follow only its actual link.
    const target = firstLinkTarget(row.report);
    if (!target) return null;
    const file = path.resolve(path.dirname(tracker), target);
    try {
      const real = fs.realpathSync(file);
      if (!real.startsWith(reportRoot + path.sep) || !real.endsWith('.md') || !fs.statSync(real).isFile()) return null;
      return { file: real, text: fs.readFileSync(real, 'utf8') };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return null;
    }
  }, savedRatings);
  return { ...plan, trackerDigest: digest(text) };
}

async function main() {
  const args = process.argv.slice(2);
  const usage = 'Usage: node repair-evaluations.mjs [--dry-run | --apply] [--help | -h]';
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return;
  }
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error(usage);
  }
  const root = getCareerOpsRoot();
  const tracker = resolveTrackerPath(root);
  const plan = auditEvaluations(root, tracker);
  const summary = { reportHeaders: plan.reports.length, statusCorrections: plan.statuses.length, gaps: plan.gaps };
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ dryRun: true, ...summary, statuses: plan.statuses.map(({ identity, ...change }) => change) }, null, 2));
    return;
  }
  const backup = path.join(root, 'output', `evaluation-repair-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(path.join(backup, 'reports'), { recursive: true });
  // Preserve one complete pre-repair snapshot, independent of per-write .bak files.
  if (digest(fs.readFileSync(tracker, 'utf8')) !== plan.trackerDigest) throw new Error('Tracker changed during audit; rerun before applying.');
  fs.copyFileSync(tracker, path.join(backup, 'applications.md'));
  const outcomes = [];
  const auditFile = path.join(backup, 'audit.json');
  const saveAudit = () => writeFileAtomic(auditFile, JSON.stringify({ ...summary, outcomes }, null, 2) + '\n');
  saveAudit();
  for (const report of plan.reports) {
    if (digest(fs.readFileSync(report.file, 'utf8')) !== report.digest) throw new Error(`Report changed during audit: ${report.file}`);
    fs.copyFileSync(report.file, path.join(backup, 'reports', path.basename(report.file)));
    writeFileAtomic(report.file, report.after);
    outcomes.push({ report: report.file, source: report.source, jev: report.jev });
    saveAudit();
  }
  const codeRoot = path.dirname(fileURLToPath(import.meta.url));
  for (const change of plan.statuses) {
    const result = spawnSync(process.execPath, [path.join(codeRoot, 'set-status.mjs'), '--row', String(change.num), change.to,
      '--expect-row', change.identity, '--expect-status', change.from, '--note', `Evaluation audit: ${change.reason}`, '--json'],
    { cwd: root, env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_TRACKER: tracker }, encoding: 'utf8', timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout);
    outcomes.push({ num: change.num, from: change.from, to: receipt.newStatus, statusLogged: receipt.statusLogged });
    saveAudit();
    if (receipt.newStatus !== change.to || receipt.statusLogged !== true) throw new Error(`Status correction for #${change.num} was not fully recorded.`);
  }
  console.log(JSON.stringify({ applied: true, ...summary, backup, auditFile }, null, 2));
}

if (isMainModule(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
