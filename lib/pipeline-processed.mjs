/**
 * pipeline-processed.mjs — the one place that moves a data/pipeline.md row
 * from Pending to Processed once a posting has a report.
 *
 * THE PROBLEM
 * The interactive mode, the web evaluate action, the OpenRouter runner and
 * the batch all write a report and a tracker row, but only the batch path
 * ever reconciled the pipeline, and only from batch/batch-state.tsv. Every
 * other evaluation left its row under Pending, so the web INBOX kept showing
 * postings that already had a report and the ALL tab showed them twice.
 *
 * WHAT THIS DOES
 * applyProcessed() takes the pipeline text and a list of evaluated postings
 * ({url, reportLink, score, pdf}) and moves each matching Pending row under
 * the Processed heading in the shape reconcile-pipeline.mjs has always
 * written: `- [x] [42](../reports/042-acme-2026-09-01.md) | url | company |
 * role | 4.2/5 | PDF ❌`. Rows are matched by posting key (url-key.mjs), so
 * a tracking parameter, a trailing slash or an http/https difference does not
 * leave a second copy behind. A row already under Processed is never copied
 * again; a stale Pending twin of a processed row is dropped. Pure and
 * idempotent: applying the same entries twice changes nothing.
 *
 * markPipelineProcessed() does the same on disk under pipeline-lock.mjs with
 * an atomic write, so it can run from persist-evaluation-report.mjs,
 * merge-tracker.mjs, openrouter-runner.mjs and reconcile-pipeline.mjs
 * without racing a scanner that appends rows.
 */

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { postingKey } from '../url-key.mjs';
import { withPipelineLock } from '../pipeline-lock.mjs';
import { writeFileAtomic } from '../tracker-utils.mjs';
import { sectionKind, processedHeadingFor } from './pipeline-sections.mjs';

export const PENDING_ITEM_RE = /^- \[ \]\s+/;
export const PROCESSED_ITEM_RE = /^- \[x\]\s+/i;
const SECTION_RE = /^##\s+/;
const URL_LIKE = /^https?:\/\//i;

/**
 * The comparison key of a pipeline URL: the posting key when the URL is an
 * http(s) posting, else the trimmed string itself (a `local:jds/...` row
 * still has to match its own report).
 * @param {string} url
 * @returns {string}
 */
export function rowKey(url) {
  const s = String(url ?? '').trim();
  return postingKey(s) || s;
}

/**
 * @param {string} line - A Pending row.
 * @returns {{url: string, company: string, role: string, parts: string[]}}
 */
export function pendingRowFields(line) {
  const parts = line.replace(PENDING_ITEM_RE, '').split('|').map((s) => s.trim());
  return { url: parts[0] ?? '', company: parts[1] ?? '', role: parts[2] ?? '', parts };
}

/**
 * The URL of a Processed row, whatever shape wrote it: the reconcile shape
 * (`[42](...) | url | ...`), the mode shape (`#143 | url | ...`), a SKIP row,
 * the runner's in-place tick (`url | company | role`) or a struck-through
 * expired row (`~~url | company | role~~ — posting expired`).
 * @param {string} line
 * @returns {string}
 */
export function processedRowUrl(line) {
  const body = line.replace(PROCESSED_ITEM_RE, '').replace(/~~/g, '');
  const parts = body.split('|').map((s) => s.trim());
  const urlLike = parts.find((p) => URL_LIKE.test(p));
  if (urlLike) return urlLike;
  // Not an http posting: the second cell when the first is a link or marker,
  // else the first cell.
  const first = parts[0] ?? '';
  if (/^(\[\d+\]\(|#[\d-]|SKIP\b|-$)/.test(first) && parts[1]) return parts[1];
  return first;
}

/**
 * @param {{reportLink: string, url: string, company: string, role: string, score: string, pdf: string}} row
 * @returns {string}
 */
export function processedLine({ reportLink, url, company, role, score, pdf }) {
  return `- [x] ${reportLink} | ${url} | ${company} | ${role} | ${score} | PDF ${pdf}`;
}

/**
 * Move every Pending row whose posting matches an entry under Processed.
 *
 * @param {string} text - The pipeline file.
 * @param {Array<{url: string, reportLink?: string, score?: string, pdf?: string, skip?: boolean, company?: string, role?: string}>} entries
 *   `reportLink` is the markdown link the Processed row carries
 *   (`[42](../reports/042-acme-2026-09-01.md)`), `score` an `X.X/5` cell or
 *   `N/A`, `pdf` `✅` or `❌`; `skip: true` writes a `SKIP` row (a dealbreaker
 *   finished without a report).
 * @returns {{text: string, changed: boolean, moved: object[], dropped: object[], alreadyProcessed: string[], unmatched: string[], pendingBefore: number, pendingAfter: number, noPendingSection: boolean}}
 */
export function applyProcessed(text, entries) {
  const lines = String(text ?? '').split(/\r?\n/);
  let pendStart = -1;
  let procStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const kind = sectionKind(lines[i]);
    if (pendStart < 0 && kind === 'pending') pendStart = i;
    else if (procStart < 0 && kind === 'processed') procStart = i;
  }
  const base = { text: String(text ?? ''), changed: false, moved: [], dropped: [], alreadyProcessed: [], unmatched: [], pendingBefore: 0, pendingAfter: 0, noPendingSection: pendStart < 0 };
  if (pendStart < 0) return base;

  const sectionEnd = (start) => {
    for (let i = start + 1; i < lines.length; i++) if (SECTION_RE.test(lines[i])) return i;
    return lines.length;
  };
  const pendEnd = sectionEnd(pendStart);
  const procEnd = procStart >= 0 ? sectionEnd(procStart) : -1;

  const processedKeys = new Set();
  if (procStart >= 0) {
    for (let i = procStart + 1; i < procEnd; i++) {
      if (!PROCESSED_ITEM_RE.test(lines[i])) continue;
      const url = processedRowUrl(lines[i]);
      if (url) processedKeys.add(rowKey(url));
    }
  }

  const byKey = new Map();
  for (const entry of entries ?? []) {
    const key = rowKey(entry?.url);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, entry);
  }

  const removeIdx = new Set();
  const newProcessed = [];
  const matchedKeys = new Set();
  let pendingBefore = 0;
  for (let i = pendStart + 1; i < pendEnd; i++) {
    if (!PENDING_ITEM_RE.test(lines[i])) continue; // blank lines and "- [!]" rows stay
    pendingBefore++;
    const row = pendingRowFields(lines[i]);
    const key = rowKey(row.url);
    const entry = byKey.get(key);
    if (!entry) continue;
    matchedKeys.add(key);
    if (processedKeys.has(key)) {
      removeIdx.add(i);
      base.dropped.push({ url: row.url });
      continue;
    }
    const company = row.company || entry.company || '';
    const role = row.role || entry.role || '';
    const score = entry.skip ? 'N/A' : (entry.score || 'N/A');
    const pdf = entry.pdf || '❌';
    const reportLink = entry.skip ? 'SKIP' : (entry.reportLink || '-');
    newProcessed.push(processedLine({ reportLink, url: row.url, company, role, score, pdf }));
    base.moved.push({ url: row.url, company, role, reportLink, score, pdf, skip: Boolean(entry.skip) });
    processedKeys.add(key);
    removeIdx.add(i);
  }
  for (const key of byKey.keys()) {
    if (matchedKeys.has(key)) continue;
    if (processedKeys.has(key)) base.alreadyProcessed.push(byKey.get(key).url);
    else base.unmatched.push(byKey.get(key).url);
  }
  base.pendingBefore = pendingBefore;
  base.pendingAfter = pendingBefore - removeIdx.size;
  if (removeIdx.size === 0) return base;

  const out = [];
  let skipBlankAfterProc = false;
  for (let i = 0; i < lines.length; i++) {
    if (removeIdx.has(i)) continue;
    if (skipBlankAfterProc) {
      skipBlankAfterProc = false;
      if (lines[i].trim() === '') continue; // the original blank after the heading
    }
    out.push(lines[i]);
    if (i === procStart && newProcessed.length > 0) {
      out.push('', ...newProcessed);
      skipBlankAfterProc = true;
    }
  }
  if (procStart < 0 && newProcessed.length > 0) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(processedHeadingFor(lines[pendStart]), '', ...newProcessed);
  }
  return { ...base, text: out.join('\n'), changed: true };
}

/**
 * `data/pipeline.md` under the data root, or the legacy `pipeline.md`.
 * @param {string} dataRoot
 * @returns {string}
 */
export function resolvePipelinePath(dataRoot) {
  const preferred = join(dataRoot, 'data', 'pipeline.md');
  return existsSync(preferred) ? preferred : join(dataRoot, 'pipeline.md');
}

/**
 * applyProcessed() on disk, under the pipeline lock, with an atomic write.
 * A missing pipeline file is not an error: nothing to move.
 *
 * @param {string} pipelinePath
 * @param {object[]} entries - As for applyProcessed().
 * @param {{dryRun?: boolean, backup?: boolean, lock?: object}} [opts]
 *   `backup` copies the file to `<path>.pre-reconcile.bak` before writing.
 * @returns {Promise<ReturnType<typeof applyProcessed> & {written: boolean}>}
 */
export async function markPipelineProcessed(pipelinePath, entries, { dryRun = false, backup = false, lock = {} } = {}) {
  const run = () => {
    if (!existsSync(pipelinePath)) {
      return { text: '', changed: false, moved: [], dropped: [], alreadyProcessed: [], unmatched: [], pendingBefore: 0, pendingAfter: 0, noPendingSection: true, written: false };
    }
    const result = applyProcessed(readFileSync(pipelinePath, 'utf-8'), entries);
    if (!result.changed || dryRun) return { ...result, written: false };
    if (backup) copyFileSync(pipelinePath, `${pipelinePath}.pre-reconcile.bak`);
    writeFileAtomic(pipelinePath, result.text);
    return { ...result, written: true };
  };
  // A dry run writes nothing, so it neither waits on nor blocks a writer.
  if (dryRun) return run();
  return withPipelineLock(pipelinePath, run, lock);
}
