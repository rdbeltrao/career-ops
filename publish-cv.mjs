#!/usr/bin/env node
/** Publish a source-backed CV only after inspecting the actual rendered PDF. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCareerOpsRoot, getProfilePath } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { validateCvPublication, reviewFinalPdf, reviewReceipt, comparableText, currentEvidenceHash, digest } from './lib/cv-publication.mjs';
import { assertFacts, printFactWarnings } from './verify-cv-facts.mjs';
import { htmlToText } from './keyword-match.mjs';
import { normalizeTextForATS, renderHtmlToPdf, updatePDFManifest, isWorkspaceOutputPath, validateLockedSections } from './generate-pdf.mjs';
import { readLockedSections } from './theme-style.mjs';
import { resolveWorkspaceRootFor, writeFileAtomic } from './tracker-utils.mjs';
import { validateCvExperienceOrder } from './cv-experience-order.mjs';
import { resolvePageFormat } from './lib/page-format.mjs';

export async function publishCv({ html, pdf, payload, reportNum, reportFile, dataRoot = getCareerOpsRoot(), format, country = payload.country }) {
  const root = resolveWorkspaceRootFor(dataRoot);
  const paper = resolvePageFormat(format ?? payload.page_format, { profilePath: getProfilePath(dataRoot), country });
  if (!isWorkspaceOutputPath(pdf, root) || !isWorkspaceOutputPath(html, root)) throw new Error('CV artifacts must stay inside the workspace.');
  const report = fs.readFileSync(reportFile, 'utf8');
  const evidenceSha256 = currentEvidenceHash(dataRoot);
  const { gaps } = validateCvPublication(payload, { dataRoot, report });
  const normalized = normalizeTextForATS(fs.readFileSync(html, 'utf8')).html;
  const visible = comparableText(htmlToText(normalized));
  for (const value of [payload.summary, ...(payload.experience ?? []).flatMap(x => [x.company, x.role, x.dates ?? x.period, ...(x.bullets ?? [])])].filter(Boolean)) {
    if (!visible.includes(comparableText(value))) throw new Error('Rendered HTML does not match the reviewed CV payload.');
  }
  const facts = assertFacts(normalized, { dataRoot, label: 'CV publication' });
  if (facts.verdict === 'warn') printFactWarnings(facts, console.warn);
  if (facts.configMissing) console.warn('No config/cv-facts.json — forbidden/advisory phrase checks did not run.');
  const locked = readLockedSections(getProfilePath(dataRoot));
  const previousCv = path.join(dataRoot, 'cv.md');
  if (locked.length && fs.existsSync(previousCv)) validateLockedSections(normalized, fs.readFileSync(previousCv, 'utf8'), locked);
  validateCvExperienceOrder(normalized);
  const finalHtml = pdf.replace(/\.pdf$/i, '.html');
  const payloadFile = `${pdf}.payload.json`;
  const draft = path.join(path.dirname(pdf), `.cv-draft-${randomUUID()}.pdf`);
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  try {
    await renderHtmlToPdf(normalized, draft, { format: paper, country, inputPath: html, workspaceRoot: root, publish: false, strictPages: true, maxPages: 2 });
    const buffer = fs.readFileSync(draft);
    const review = await reviewFinalPdf(buffer, payload);
    if (currentEvidenceHash(dataRoot) !== evidenceSha256 || digest(fs.readFileSync(reportFile)) !== digest(report)) throw new Error('Career evidence or job requirements changed during review; regenerate the draft.');
    // Nothing replaces the previous deliverable until every content/layout check passes.
    writeFileAtomic(finalHtml, normalized);
    writeFileAtomic(payloadFile, JSON.stringify(payload, null, 2) + '\n');
    writeFileAtomic(pdf, buffer);
    const receipt = reviewReceipt({ pdf, html: finalHtml, reportFile, payloadFile, dataRoot, reportNum, review, gaps });
    writeFileAtomic(`${pdf}.review.json`, JSON.stringify(receipt, null, 2) + '\n');
    await updatePDFManifest(reportNum, pdf, finalHtml, paper, 'cv', dataRoot);
    return { pdf, html: finalHtml, pages: review.pages.length, gaps, review: `${pdf}.review.json` };
  } finally { fs.rmSync(draft, { force: true }); }
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: node publish-cv.mjs --html=path --payload=path --pdf=path --report=N [--format=a4|letter]');
  } else {
  try {
    const args = Object.fromEntries(process.argv.slice(2).map(value => {
      const match = /^--([a-z-]+)=(.+)$/.exec(value);
      if (!match) throw new Error('Usage: node publish-cv.mjs --html=path --payload=path --pdf=path --report=N [--format=a4|letter]');
      if (!['html', 'payload', 'pdf', 'report', 'format', 'country'].includes(match[1])) throw new Error(`Unknown option: --${match[1]}`);
      return [match[1], match[2]];
    }));
    if (!args.html || !args.pdf || !args.payload || !/^\d+$/.test(args.report ?? '')) throw new Error('HTML, PDF, payload and numeric report are required.');
    if (args.format && !['a4', 'letter'].includes(args.format)) throw new Error('Format must be a4 or letter.');
    if (args.country && !/^[a-z]{2}$/i.test(args.country)) throw new Error('Country must be a two-letter ISO code.');
    const root = getCareerOpsRoot();
    const reports = fs.readdirSync(path.join(root, 'reports')).filter(file => new RegExp(`^0*${Number(args.report)}-.*\\.md$`).test(file));
    if (reports.length !== 1) throw new Error(`Report #${args.report} must resolve to exactly one file.`);
    const result = await publishCv({ html: path.resolve(args.html), pdf: path.resolve(args.pdf), payload: JSON.parse(fs.readFileSync(args.payload, 'utf8')), reportNum: args.report, reportFile: path.join(root, 'reports', reports[0]), dataRoot: root, format: args.format, country: args.country });
    for (const gap of result.gaps) console.warn(`Remaining fit gap: ${gap}`);
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
