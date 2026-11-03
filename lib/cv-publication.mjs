/** Source-backed CV publication checks, shared by the CLI and web adapter. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadYaml } from './yaml-document.mjs';
import { readContext } from './context-evidence.mjs';
import { filterContextEvidence } from './context-library.mjs';
import { parseCvExperience } from '../cv-title-check.mjs';
import { parseExperienceStart } from '../cv-experience-order.mjs';
import { archivedJdText } from '../keyword-match.mjs';
import { resolvePdfIndexPath, resolveTrackerPath, resolveWorkspaceRootFor, pathIsInsideCanonical } from '../tracker-utils.mjs';

export const REVIEW_VERSION = 1;
export const digest = value => createHash('sha256').update(value).digest('hex');
export const comparableText = value => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/€/g, 'eur ').replace(/×/g, 'x').replace(/[*_`’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const companyKey = value => comparableText(value).replace(/\b(?:gmbh|inc|ltd|llc|co)\b/g, '').replace(/\s+/g, ' ').trim();

function publicationContext(dataRoot) {
  const missing = file => { try { fs.statSync(file); return false; } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return true; throw error; } };
  // A legitimate data/ symlink can point outside the checkout. With neither
  // Context representation present, do not treat that absent library as unsafe.
  if (missing(path.join(dataRoot, 'data/context-workspace/index.json')) && missing(path.join(dataRoot, 'modes/_context.md'))) return null;
  return readContext(dataRoot);
}

/** Dates are compared by month where recorded, never by a computed tenure. */
export function parseCareerPeriod(value) {
  const text = String(value ?? '').replace(/[*_`]/g, '').trim()
    .replace(/^((?:19|20)\d{2}|\d{1,2}\/(?:19|20)\d{2})-(?=(?:19|20)\d{2}|present$)/i, '$1 – ');
  const parts = text.split(/\s*(?:[–—]|\bto\b|\buntil\b)\s*|\s+-\s+/i);
  if (parts.length !== 2) return null;
  const date = s => {
    if (!/^(?:(?:[A-Za-zÀ-ž]+\s+)?(?:19|20)\d{2}|\d{1,2}\/(?:19|20)\d{2}|(?:19|20)\d{2}-\d{2})$/u.test(s.trim())) return null;
    const iso = /^(\d{4})-(\d{2})$/.exec(s.trim());
    const numeric = /^(\d{1,2})\/(\d{4})$/.exec(s.trim());
    const result = iso ? { year: Number(iso[1]), month: Number(iso[2]) } : numeric ? { year: Number(numeric[2]), month: Number(numeric[1]) } : parseExperienceStart(s.trim());
    if (!result || (!/^(?:19|20)\d{2}$/.test(s.trim()) && (!result.month || result.month > 12))) return null;
    return { year: result.year, month: /^(?:19|20)\d{2}$/.test(s.trim()) ? null : result.month };
  };
  const start = date(parts[0]);
  const end = /^(?:present|current|now|heute|actualidad|atual)$/i.test(parts[1].trim()) ? 'present' : date(parts[1]);
  if (!start || !end) return null;
  if (end !== 'present' && (end.year * 12 + (end.month ?? 12) < start.year * 12 + (start.month ?? 1))) return null;
  return { start, end };
}

/** Read only eligible period fields, not the other raw claims in their blocks. */
export function careerChronology(dataRoot, context = publicationContext(dataRoot)) {
  const records = [];
  if (context?.source === 'library') {
    for (const page of context.pages) {
      if (page.usage !== 'facts' || !page.evidenceText) continue;
      const roleRecord = /^## Role record\s*\n([^]*?)(?=^## |(?![^]))/m.exec(page.content);
      const section = roleRecord?.[1];
      if (!section) continue;
      const status = section.split('\n').find(line => /^- \*\*(?:Evidence )?Status:\*\*/i.test(line));
      if (status && !filterContextEvidence(status).includes(status)) continue;
      for (const line of section.split('\n')) {
        const match = /^- \*\*Period[^*]*:\*\*\s*(.+)/i.exec(line);
        if (!match) continue;
        // Filtering the field independently avoids excluding a known date just
        // because an adjacent headcount is approximate. Heading exclusions hold.
        const index = page.content.indexOf(line, roleRecord.index);
        const headings = page.content.slice(0, index).split('\n').filter(value => /^#{1,6}\s/.test(value));
        const eligible = filterContextEvidence(`# ${page.title}\n\n${headings.join('\n\n')}\n\n${line}`);
        if (!eligible.includes(line)) continue;
        const shown = match[1].split(/[,.;](?:\s|$)/)[0].trim();
        const period = parseCareerPeriod(shown);
        if (period) records.push({ company: page.title.split(/\s+[—–]\s+/)[0], dates: shown, period, source: page.relativePath });
      }
    }
  } else {
    const cv = path.join(dataRoot, 'cv.md');
    if (fs.existsSync(cv)) for (const item of parseCvExperience(fs.readFileSync(cv, 'utf8'))) {
      const period = parseCareerPeriod(item.dates);
      if (period) records.push({ company: item.company, dates: item.dates, period, source: 'cv.md' });
    }
  }
  return records;
}

export function criticalRequirements(report, jobDescription = '') {
  const machine = /## Machine Summary\s*\n+```ya?ml\s*\n([^]*?)```/i.exec(report)?.[1];
  if (!machine) return [];
  const parsed = loadYaml(machine);
  if (!parsed || !Array.isArray(parsed.requirement_importance)) return [];
  const rank = { critical: 0, high: 1, meaningful: 2, low: 3 };
  const jd = comparableText(jobDescription);
  // Evaluation signals can summarize several passages or translate the JD.
  // Only archive-backed text is offered to the content worker as a quote.
  return parsed.requirement_importance.filter(x => typeof x?.requirement === 'string' && typeof x?.jd_signal === 'string')
    .sort((a, b) => (rank[a.importance] ?? 4) - (rank[b.importance] ?? 4)).slice(0, 3)
    .map(x => ({ requirement: x.requirement, jdSignal: x.jd_signal,
      jdQuote: comparableText(x.jd_signal).length >= 12 && jd.includes(comparableText(x.jd_signal)) ? x.jd_signal : null,
      importance: x.importance }));
}

export function publicationBrief(dataRoot, report) {
  const context = publicationContext(dataRoot);
  const jobDescription = archivedJdText(report, dataRoot);
  return { chronology: careerChronology(dataRoot, context), jobDescription, criticalRequirements: criticalRequirements(report, jobDescription),
    evidence: context?.files.map(file => ({ source: file.relativePath, text: file.text })) ?? [] };
}

export function validateCvChronology(experience, chronology) {
  const errors = [];
  for (const record of chronology) {
    if (!experience?.some(job => companyKey(job.company) === companyKey(record.company))) errors.push(`${record.company}: documented employment is missing; keep the role and tailor its bullets.`);
  }
  let previous = Infinity;
  for (const job of experience ?? []) {
    const actual = parseCareerPeriod(job.dates ?? job.period);
    if (!actual) { errors.push(`${job.company}: a complete employment period with a start and end date is required.`); continue; }
    const order = actual.start.year * 12 + (actual.start.month ?? 1);
    if (order > previous) errors.push(`${job.company}: employment must be newest-first.`);
    previous = order;
    const sources = chronology.filter(x => companyKey(x.company) === companyKey(job.company));
    if (!sources.length) { errors.push(`${job.company}: no eligible source period; resolve the source before publication.`); continue; }
    const periods = new Set(sources.map(x => JSON.stringify(x.period)));
    if (periods.size !== 1) { errors.push(`${job.company}: conflicting source periods; resolve the source before publication.`); continue; }
    if (!periods.has(JSON.stringify(actual))) errors.push(`${job.company}: dates must match ${sources[0].dates} (${sources[0].source}).`);
  }
  return errors;
}

/** Validate evidence/placement links, not keyword frequency or an invented score. */
export function validateCvPublication(payload, { dataRoot, report, brief = publicationBrief(dataRoot, report) }) {
  const errors = validateCvChronology(payload.experience, brief.chronology);
  if (brief.chronology.length && !payload.experience?.length) errors.push('Documented employment cannot be omitted to bypass chronology checks.');
  const gaps = [];
  const plan = payload.tailoring?.requirements;
  const jd = comparableText(archivedJdText(report, dataRoot) || report);
  if (!Array.isArray(plan) || plan.length !== 3) errors.push('Tailoring requires exactly three critical job requirements with evidence or explicit gaps.');
  else {
    const seen = new Set();
    const covered = new Set();
    for (const [index, entry] of plan.entries()) {
      const label = `Requirement ${index + 1}`;
      const requirement = comparableText(entry.requirement);
      if (!requirement || covered.has(requirement)) errors.push(`${label}: a distinct critical requirement is required.`);
      covered.add(requirement);
      const quote = comparableText(entry.jdQuote);
      if (quote.length < 12 || !jd.includes(quote)) errors.push(`${label}: quote must occur in the archived job description.`);
      if (seen.has(quote)) errors.push(`${label}: duplicate job requirement.`);
      seen.add(quote);
      if (brief.criticalRequirements.length === 3 && !brief.criticalRequirements.some(x => comparableText(x.requirement) === comparableText(entry.requirement))) errors.push(`${label}: must address the supplied critical requirements.`);
      if (!['supported', 'partial', 'gap'].includes(entry.match)) errors.push(`${label}: match must be supported, partial or gap.`);
      if (entry.match !== 'supported') {
        if (!entry.gap?.trim()) errors.push(`${label}: describe the remaining gap.`);
        else gaps.push(`${entry.requirement}: ${entry.gap}`);
      }
      if (entry.match === 'gap') continue;
      if (!entry.evidence?.length || !entry.placements?.length) errors.push(`${label}: matching evidence and a visible placement are required.`);
      for (const evidence of entry.evidence ?? []) {
        const source = brief.evidence.find(x => x.source === evidence.source);
        const claim = comparableText(evidence.quote);
        if (!source || claim.length < 15 || !comparableText(source.text).includes(claim)) errors.push(`${label}: evidence must quote an eligible career source.`);
      }
      for (const placement of entry.placements ?? []) {
        const content = placement.section === 'summary' ? payload.summary : placement.section === 'experience'
          ? payload.experience?.find(x => companyKey(x.company) === companyKey(placement.company))?.bullets?.[placement.bulletIndex]
          : placement.section === 'skills' ? payload.skills?.map(x => `${x.category ?? ''} ${Array.isArray(x.items) ? x.items.join(', ') : x.items}`).join(' ')
          : placement.section === 'education' ? payload.education?.map(x => `${x.title} ${x.org ?? ''}`).join(' ') : null;
        const claim = comparableText(placement.claim);
        if (!content || claim.length < 15 || !comparableText(content).includes(claim)) errors.push(`${label}: claimed proof is missing from its CV placement.`);
      }
    }
    if (!plan.some(x => x.match === 'supported' || x.match === 'partial')) errors.push('No source-backed match to the critical requirements.');
  }
  if (errors.length) throw new Error(`CV publication blocked:\n${errors.join('\n')}`);
  return { gaps, brief };
}

/** Review actual PDF text and geometry, after rendering, before readiness. */
export async function reviewFinalPdf(buffer, payload, { maxPages = 2 } = {}) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
  try {
    const document = await task.promise;
    const errors = [];
    if (document.numPages > maxPages) errors.push(`Final PDF has ${document.numPages} pages; maximum is ${maxPages}.`);
    const pages = [];
    for (let i = 1; i <= document.numPages; i++) {
      const page = await document.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const { items } = await page.getTextContent();
      const spans = items.filter(x => typeof x.str === 'string' && x.str.trim());
      const text = spans.map(x => x.str).join(' ');
      if (text.trim().split(/\s+/).length < 35) errors.push(`Final PDF page ${i} is empty or an orphan overflow page.`);
      if (spans.some(x => x.transform[4] < -2 || x.transform[4] + x.width > viewport.width + 2 || x.transform[5] < -2 || x.transform[5] > viewport.height + 2)) errors.push(`Final PDF page ${i} has text outside the page bounds.`);
      const runs = spans.filter(x => x.str.trim().length > 3);
      let overlap = false;
      for (let a = 0; a < runs.length && !overlap; a++) for (let b = a + 1; b < runs.length; b++) {
        const x = runs[a], y = runs[b];
        const width = Math.min(x.transform[4] + x.width, y.transform[4] + y.width) - Math.max(x.transform[4], y.transform[4]);
        const height = Math.min(x.transform[5] + x.height, y.transform[5] + y.height) - Math.max(x.transform[5], y.transform[5]);
        if (width > 3 && width > Math.min(x.width, y.width) * 0.2 && height > Math.min(x.height, y.height) * 0.8) { overlap = true; break; }
      }
      if (overlap) errors.push(`Final PDF page ${i} has overlapping text.`);
      pages.push({ page: i, words: text.trim().split(/\s+/).length, text });
    }
    const text = comparableText(pages.map(x => x.text).join(' '));
    const expected = [payload.candidate?.name, payload.summary,
      ...(payload.experience ?? []).flatMap(x => [x.company, x.role, x.dates ?? x.period, ...(x.bullets ?? [])]),
      ...(payload.tailoring?.requirements ?? []).flatMap(x => (x.placements ?? []).map(placement => placement.claim)),
    ].filter(Boolean);
    for (const value of expected) if (!text.includes(comparableText(value))) errors.push(`Final PDF is missing expected text: ${String(value).slice(0, 100)}`);
    if (errors.length) throw new Error(`Final PDF review failed:\n${errors.join('\n')}`);
    return { pages: pages.map(({ page, words }) => ({ page, words })), textSha256: digest(text), text: pages.map(x => x.text).join('\n\f\n') };
  } finally { await task.destroy(); }
}

export function currentEvidenceHash(dataRoot) {
  const context = publicationContext(dataRoot);
  return digest(JSON.stringify({ facts: context?.evidenceText ?? '', chronology: careerChronology(dataRoot, context) }));
}

export function reviewReceipt({ pdf, html, reportFile, payloadFile, dataRoot, reportNum, review, gaps }) {
  return { version: REVIEW_VERSION, status: 'passed', reviewedAt: new Date().toISOString(), reportNum: String(Number(reportNum)),
    pdf: { path: pdf, sha256: digest(fs.readFileSync(pdf)) }, html: { path: html, sha256: digest(fs.readFileSync(html)) },
    report: { path: reportFile, sha256: digest(fs.readFileSync(reportFile)) }, payload: { path: payloadFile, sha256: digest(fs.readFileSync(payloadFile)) },
    evidenceSha256: currentEvidenceHash(dataRoot), pages: review.pages, textSha256: review.textSha256, gaps };
}

export function assertCurrentCvReview(pdf, { dataRoot, reportNum }) {
  const receipt = JSON.parse(fs.readFileSync(`${pdf}.review.json`, 'utf8'));
  if (receipt.version !== REVIEW_VERSION || receipt.status !== 'passed' || receipt.reportNum !== String(Number(reportNum))) throw new Error('A current successful final-PDF review is required.');
  const workspace = resolveWorkspaceRootFor(dataRoot);
  for (const [kind, artifact] of Object.entries({ pdf: receipt.pdf, html: receipt.html, report: receipt.report, payload: receipt.payload })) {
    if (!artifact?.path || !pathIsInsideCanonical(artifact.path, workspace) || (kind === 'pdf' && path.resolve(artifact.path) !== path.resolve(pdf)) || digest(fs.readFileSync(artifact.path)) !== artifact.sha256) throw new Error(`Final-PDF review is stale: ${kind} changed or is unavailable.`);
  }
  if (receipt.evidenceSha256 !== currentEvidenceHash(dataRoot)) throw new Error('Final-PDF review is stale: career evidence changed.');
  return receipt;
}

export function reviewedCvForReport(dataRoot, reportNum) {
  const workspace = resolveWorkspaceRootFor(dataRoot);
  const index = resolvePdfIndexPath(resolveTrackerPath(dataRoot));
  const lines = fs.readFileSync(index, 'utf8').split('\n').filter(x => x && !x.startsWith('#')).map(x => x.split('\t'));
  const row = lines.findLast(x => Number(x[0]) === Number(reportNum) && x[5] !== 'cover');
  if (!row) throw new Error(`No indexed CV for report #${reportNum}.`);
  const pdf = path.resolve(workspace, row[1]);
  if (!pathIsInsideCanonical(pdf, workspace)) throw new Error('Indexed CV is outside the workspace.');
  return assertCurrentCvReview(pdf, { dataRoot, reportNum });
}
