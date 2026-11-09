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

/**
 * Fact-gate warnings block publication unless the caller explicitly allows
 * them: a warning printed to a console nobody reads shipped CVs with advisory
 * phrases and unsourced adoption claims. The warnings are listed in the error
 * so the fix is visible without rerunning the gate.
 */
export function assertFactGate(facts, { allowWarnings = false, print = console.warn } = {}) {
  if (facts.verdict !== 'warn') return;
  const lines = [];
  printFactWarnings(facts, line => lines.push(line));
  // Strict blocks on advisory FACTS (an adoption claim or a field claim with no
  // source). Hedge-word hits and coverage notes stay printed warnings: "about"
  // in "four articles about recommendation systems" is not a hedge, and a
  // non-English CV the gate cannot read is a scope note, not a false claim.
  const blocking = (facts.advisoryFacts ?? []).length > 0;
  if (allowWarnings || !blocking) { for (const line of lines) print(line); return; }
  throw new Error(`CV publication blocked by unsourced advisory facts (fix them, or pass --allow-warnings to publish anyway):\n${lines.join('\n')}`);
}

const USAGE = 'Usage: node publish-cv.mjs --html=path --payload=path --pdf=path --report=N [--format=a4|letter] [--country=XX] [--strict | --allow-warnings]';

/** Parse the CLI arguments. Strict (warnings block) is the default; --allow-warnings is the escape. */
export function parsePublishArgs(argv) {
  const flags = { strict: false, allowWarnings: false };
  const args = Object.fromEntries(argv.filter(value => {
    if (value === '--strict') { flags.strict = true; return false; }
    if (value === '--allow-warnings') { flags.allowWarnings = true; return false; }
    return true;
  }).map(value => {
    const match = /^--([a-z-]+)(?:=(.+))?$/.exec(value);
    if (!match) throw new Error(USAGE);
    if (!['html', 'payload', 'pdf', 'report', 'format', 'country'].includes(match[1]) || match[2] === undefined) throw new Error(`Unknown option: ${value}`);
    return [match[1], match[2]];
  }));
  if (flags.strict && flags.allowWarnings) throw new Error('--strict and --allow-warnings exclude each other.');
  if (!args.html || !args.pdf || !args.payload || !/^\d+$/.test(args.report ?? '')) throw new Error('HTML, PDF, payload and numeric report are required.');
  if (args.format && !['a4', 'letter'].includes(args.format)) throw new Error('Format must be a4 or letter.');
  if (args.country && !/^[a-z]{2}$/i.test(args.country)) throw new Error('Country must be a two-letter ISO code.');
  return { ...args, allowWarnings: flags.allowWarnings };
}

export async function publishCv({ html, pdf, payload, reportNum, reportFile, dataRoot = getCareerOpsRoot(), format, country = payload.country, allowWarnings = false }) {
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
  if (facts.configMissing) console.warn('No config/cv-facts.json — forbidden/advisory phrase checks did not run.');
  assertFactGate(facts, { allowWarnings });
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
    console.log(USAGE);
  } else {
  try {
    const args = parsePublishArgs(process.argv.slice(2));
    const root = getCareerOpsRoot();
    const reports = fs.readdirSync(path.join(root, 'reports')).filter(file => new RegExp(`^0*${Number(args.report)}-.*\\.md$`).test(file));
    if (reports.length !== 1) throw new Error(`Report #${args.report} must resolve to exactly one file.`);
    const result = await publishCv({ html: path.resolve(args.html), pdf: path.resolve(args.pdf), payload: JSON.parse(fs.readFileSync(args.payload, 'utf8')), reportNum: args.report, reportFile: path.join(root, 'reports', reports[0]), dataRoot: root, format: args.format, country: args.country, allowWarnings: args.allowWarnings });
    for (const gap of result.gaps) console.warn(`Remaining fit gap: ${gap}`);
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
