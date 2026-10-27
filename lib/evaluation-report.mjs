/** Report evidence shared with the web mirror (guarded by a parity test). */
import * as yaml from 'js-yaml';
import { loadYaml } from './yaml-document.mjs';

const VERDICTS = new Set(['apply', 'maybe', 'skip']);
const SUMMARY = /^##[ \t]+Machine Summary[ \t]*\r?\n+```(?:yaml|yml)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gim;
const JEV_HEADER = /^\*\*Jev:\*\*[ \t]*(.*)$/gim;
const blank = text => text.replace(/[^\n]/g, ' ');

function withoutArchivedJd(markdown) {
  return String(markdown ?? '').replace(/\r\n/g, '\n')
    .replace(/^##[ \t]+Job Description[^\n]*\n[\s\S]*?(?=^##[ \t]+|$(?![\s\S]))/gim, blank);
}

/** Archived postings and unrelated code fences cannot supply report evidence. */
export function reportEvidence(markdown) {
  return withoutArchivedJd(markdown)
    .replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, blank);
}

export function machineSummary(markdown) {
  const text = withoutArchivedJd(markdown);
  const matches = [...text.matchAll(SUMMARY)];
  if (matches.length !== 1) return { data: null, error: 'Expected exactly one Machine Summary YAML fence.' };
  try {
    const data = loadYaml(matches[0][1], { schema: yaml.JSON_SCHEMA });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a mapping.');
    return { data, error: null };
  } catch {
    return { data: null, error: 'The Machine Summary YAML is invalid.' };
  }
}

const bounded = (value, max) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null;

/** @returns {{fit: number|null, score: number|null, verdict: "apply"|"maybe"|"skip"|null}|null} */
export function parseJevField(value) {
  const text = String(value ?? '').replace(/[`*]/g, '').trim();
  if (!text || /^not run\b/i.test(text)) return null;
  const scoreMatch = text.match(/\b(\d+(?:\.\d+)?)\s*\/\s*5\b/);
  const fitMatch = text.match(/\bfit\s*[:=]?\s*(\d{1,3})(?![\d.])/i)
    || text.match(/\b(\d{1,3})\s*\/\s*100\b/)
    || text.match(/(?:^|[\s(])(\d{1,3})(?=\s*(?:,|\s)\s*(?:apply|maybe|skip)\b)/i);
  const verdict = /** @type {"apply"|"maybe"|"skip"|null} */ (text.match(/\b(apply|maybe|skip)\b/i)?.[1].toLowerCase() ?? null);
  const fit = fitMatch ? bounded(Number(fitMatch[1]), 100) : null;
  const score = scoreMatch ? bounded(Number(scoreMatch[1]), 5) : null;
  return fit !== null || score !== null || verdict ? { fit, score, verdict } : null;
}

function structuredJev(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fit = bounded(value.fit, 100);
  const score = bounded(value.score, 5);
  const verdict = VERDICTS.has(value.verdict) ? value.verdict : null;
  if (fit === null || score === null || !verdict) return null;
  return { fit, score, verdict };
}

/** Structured data wins. Explicit not-run is never filled from an older result. */
export function readReportJev(markdown) {
  const evidence = reportEvidence(markdown);
  const { data } = machineSummary(markdown);
  const header = [...evidence.matchAll(JEV_HEADER)][0]?.[1];
  const url = evidence.match(/^\*\*URL:\*\*[ \t]*(https?:\/\/[^\s<>|]+)/mi)?.[1] ?? null;
  if (data && Object.hasOwn(data, 'jev')) {
    if (data.jev === null) return { url, jev: null, status: 'not-run', reasons: '', source: 'summary' };
    const jev = structuredJev(data.jev);
    const reasons = data.jev?.reasons && typeof data.jev.reasons === 'object'
      ? Object.entries(data.jev.reasons).filter(([, v]) => typeof v === 'string').map(([k, v]) => `${k}: ${v}`).join(', ') : '';
    return { url, jev, status: jev ? 'rated' : 'invalid', reasons, source: 'summary' };
  }
  if (/^not run\b/i.test(header ?? '')) return { url, jev: null, status: 'not-run', reasons: '', source: 'header' };
  const fromHeader = parseJevField(header);
  if (fromHeader) return { url, jev: fromHeader, status: 'rated', reasons: '', source: 'header' };
  // Compatibility for old gate notes. Only explicit Jev passages, never the
  // global Score, arbitrary figures, quoted postings or a neighboring section.
  const lines = evidence.split('\n');
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\bJev\b/i.test(lines[i])) continue;
    const line = lines[i].replace(/[`*]/g, '');
    if (/\bnot run\b|\bno Jev gate\b/i.test(line)) continue;
    const parsed = parseJevField(line);
    if (parsed) candidates.push(parsed);
  }
  const unique = [...new Map(candidates.map(c => [JSON.stringify(c), c])).values()];
  const richest = unique.sort((a, b) => Object.values(b).filter(v => v !== null).length - Object.values(a).filter(v => v !== null).length)[0];
  // Conflicting explicit passages remain unknown; never pick a convenient one.
  const conflict = ['fit', 'score', 'verdict'].some(k => new Set(unique.map(c => c[k]).filter(v => v !== null)).size > 1);
  const merged = richest ? Object.fromEntries(['fit', 'score', 'verdict'].map(k => [k, unique.find(c => c[k] !== null)?.[k] ?? null])) : null;
  return { url, jev: conflict ? null : merged, status: conflict ? 'invalid' : merged ? 'rated' : 'missing', reasons: '', source: 'prose' };
}

export function evaluationSections(markdown) {
  const evidence = reportEvidence(markdown);
  return new Set([...evidence.matchAll(/^#{2,3}[ \t]+(?:Block[ \t]+)?([A-G])(?:[).:—–-]|[ \t]+[—–-])[ \t]*/gim)].map(m => m[1].toUpperCase()));
}

/** Legacy gate notes must not become evaluations through merge/reconciliation. */
export function evaluationReportState(markdown) {
  const evidence = reportEvidence(markdown);
  const sections = evaluationSections(markdown);
  if (sections.size >= 6 && sections.has('B') && sections.has('G')) return 'complete';
  if (/^needs_confirmation:/mi.test(evidence)
    || /(?:stopp?ed|paus(?:ed|ing)|hard stop|haven['’]t started|have not (?:started|evaluated)|before (?:i )?evaluat|before Block A|agency confirmation|which agency)/i.test(evidence.slice(0, 3500))) return 'needs-review';
  return 'incomplete';
}

/** Insert/replace only the presentation header; all report evidence stays intact. */
export function withJevHeader(markdown, value) {
  const text = String(markdown).replace(/\r\n/g, '\n');
  let line = `**Jev:** ${value}`;
  // Remove recognized report fields only outside archived text/code, never
  // rewrite a verbatim JD. New canonical field belongs beside the first Score.
  const evidence = reportEvidence(text);
  const headerMatch = [...evidence.matchAll(JEV_HEADER)][0];
  const header = headerMatch?.[0];
  const firstSection = text.search(/^##[ \t]+/m);
  const headerAt = headerMatch?.index ?? -1;
  if (header) {
    const oldValue = header.replace(/^\*\*Jev:\*\*[ \t]*/i, '');
    if (JSON.stringify(parseJevField(oldValue)) === JSON.stringify(parseJevField(value))) line = header;
  }
  if (header && (firstSection < 0 || headerAt < firstSection)) return text.slice(0, headerAt) + line + text.slice(headerAt + header.length);
  const without = header ? text.slice(0, headerAt) + text.slice(headerAt + header.length + (text[headerAt + header.length] === '\n' ? 1 : 0)) : text;
  const remaining = reportEvidence(without);
  const score = remaining.match(/^\*\*Score:\*\*[^\n]*$/mi);
  if (score) {
    const end = score.index + score[0].length;
    return without.slice(0, end) + `\n${line}` + without.slice(end);
  }
  const title = remaining.match(/^# [^\n]*$/m);
  if (!title) return `${line}\n${without}`;
  const end = title.index + title[0].length;
  return without.slice(0, end) + `\n\n${line}` + without.slice(end);
}

export function jevHeaderValue(jev) {
  return `${jev.score !== null ? `${jev.score}/5 ` : ''}(fit ${jev.fit ?? 'unknown'}, ${jev.verdict ?? 'unknown'})`;
}

/** New writes require a finished report and explicit, consistent Jev evidence. */
export function prepareEvaluationReport(markdown) {
  if (/^needs_confirmation:/mi.test(reportEvidence(markdown)) || evaluationSections(markdown).size !== 7 || evaluationReportState(markdown) !== 'complete') return { ok: false, error: 'The evaluation is incomplete or awaiting confirmation; blocks A–G are required. Nothing was saved.' };
  const { data, error } = machineSummary(markdown);
  if (error) return { ok: false, error };
  if (!data.company || !data.role || bounded(data.score, 5) === null || typeof data.final_decision !== 'string' || !data.final_decision.trim()) {
    return { ok: false, error: 'The Machine Summary requires company, role, numeric score and final_decision.' };
  }
  if (!Object.hasOwn(data, 'jev')) return { ok: false, error: 'The Machine Summary must record jev, or explicit jev: null with a not-run reason.' };
  const evidence = reportEvidence(markdown);
  const headers = [...evidence.matchAll(JEV_HEADER)];
  if (headers.length > 1) return { ok: false, error: 'The report has conflicting or duplicate Jev headers.' };
  const header = headers[0]?.[1];
  if (data.jev === null) {
    if (parseJevField(header)) return { ok: false, error: 'The Jev header disagrees with jev: null in Machine Summary.' };
    if (!/\bnot run:\s*\S|\*\*Scoring note:\*\*[^\n]*\bno Jev gate\b/i.test(evidence)) {
      return { ok: false, error: 'Jev was not run; the report must state the not-run reason.' };
    }
    return { ok: true, markdown: withJevHeader(markdown, 'not run') };
  }
  const jev = structuredJev(data.jev);
  if (!jev) return { ok: false, error: 'Invalid Jev result: fit must be 0–100, score 0–5 and verdict apply, maybe or skip.' };
  const parsedHeader = parseJevField(header);
  if (header !== undefined && (!parsedHeader || ['fit', 'score', 'verdict'].some(k => parsedHeader[k] !== jev[k]))) {
    return { ok: false, error: 'The Jev header disagrees with the Machine Summary.' };
  }
  return { ok: true, markdown: withJevHeader(markdown, jevHeaderValue(jev)) };
}
