/** Persist trusted scorer output independently of the agent's report text. */
import * as yaml from 'js-yaml';
import { machineSummary, prepareEvaluationReport, reportEvidence, withJevHeader, jevHeaderValue } from './evaluation-report.mjs';
import { postingKey } from '../url-key.mjs';

const SUMMARY = /^##[ \t]+Machine Summary[ \t]*\n+```(?:yaml|yml)?[ \t]*\n([\s\S]*?)\n```[ \t]*$/gim;

export function validateJevReceipt(receipt) {
  if (!receipt || !/^https?:\/\/\S+$/i.test(receipt.url ?? '') || !postingKey(receipt.url)) throw new Error('JEV receipt requires a posting URL.');
  const result = receipt.result;
  if (result === null) {
    if (typeof receipt.reason !== 'string' || !receipt.reason.trim() || /^no Jev gate$/i.test(receipt.reason.trim())) {
      throw new Error('JEV receipt requires a concrete not-run reason.');
    }
    return null;
  }
  if (!result || result.error || typeof result.fit !== 'number' || !Number.isFinite(result.fit) || result.fit < 0 || result.fit > 100
    || typeof result.score !== 'number' || !Number.isFinite(result.score) || result.score < 0 || result.score > 5
    || !['apply', 'maybe', 'skip'].includes(result.verdict)) throw new Error('Invalid trusted JEV scorer result.');
  return {
    model: typeof result.model === 'string' ? result.model : null,
    fit: result.fit, score: result.score, verdict: result.verdict,
    blocking: Array.isArray(result.blocking) ? result.blocking.filter(v => typeof v === 'string') : [],
    reasons: result.reasons && typeof result.reasons === 'object' && !Array.isArray(result.reasons)
      ? Object.fromEntries(Object.entries(result.reasons).filter(([, v]) => typeof v === 'string')) : {},
  };
}

export function stampReportJev(markdown, receipt) {
  const result = validateJevReceipt(receipt);
  const text = String(markdown).replace(/\r\n/g, '\n');
  const evidence = reportEvidence(text);
  const url = evidence.match(/^\*\*URL:\*\*[ \t]*(https?:\/\/[^\s<>|]+)/mi)?.[1];
  if (!url || postingKey(url) !== postingKey(receipt.url)) throw new Error('Report URL does not match the JEV receipt posting.');
  const { data, error } = machineSummary(text);
  if (error) throw new Error(error);
  data.jev = result;
  if (typeof receipt.recorded_at === 'string') data.jev_recorded_at = receipt.recorded_at;
  if (result === null) data.jev_not_run_reason = receipt.reason.trim().replace(/[\r\n]+/g, ' ');
  else delete data.jev_not_run_reason;
  // machineSummary already excludes archived JD text; select the same fence.
  const summaryAt = evidence.search(/^##[ \t]+Machine Summary[ \t]*$/im);
  const match = [...text.matchAll(SUMMARY)].find(m => m.index === summaryAt);
  if (!match) throw new Error('No writable Machine Summary found.');
  let next = text.slice(0, match.index) + `## Machine Summary\n\`\`\`yaml\n${yaml.dump(data, { schema: yaml.JSON_SCHEMA, noRefs: true, lineWidth: -1 }).trimEnd()}\n\`\`\`` + text.slice(match.index + match[0].length);
  next = withJevHeader(next, result ? jevHeaderValue(result) : 'not run');
  // Only edit report evidence, never quoted job descriptions or code examples.
  const visible = reportEvidence(next);
  const edits = [];
  for (const m of visible.matchAll(/^\*\*Scoring note:\*\*[ \t]*([^\n]*)/gim)) {
    const parts = m[1].split(',').map(v => v.trim()).filter(v => v && !/^(?:no Jev gate|none)$/i.test(v));
    if (!result && !parts.includes('no Jev gate')) parts.unshift('no Jev gate');
    edits.push({ at: m.index, length: m[0].length, value: `**Scoring note:** ${parts.join(', ') || 'none'}` });
  }
  for (const e of edits.reverse()) next = next.slice(0, e.at) + e.value + next.slice(e.at + e.length);
  // Replace an obsolete gate block, or insert one before Block A.
  const gate = result
    ? `model: ${result.model ?? 'unknown'} | fit: ${result.fit}/100 | jev_score: ${result.score}/5 | verdict: ${result.verdict}\n${Object.entries(result.reasons).map(([k, v]) => `${k}: ${v}`).join(' | ')}\nblocking: ${result.blocking.join(', ') || 'none'}`
    : `not run: ${data.jev_not_run_reason}`;
  const block = `## Calibrated pre-screen (Jev)\n\n${gate}\n\n`;
  const gateMatch = reportEvidence(next).match(/^##[ \t]+Calibrated pre-screen \(Jev\)[^\n]*\n[\s\S]*?(?=^##[ \t]+|$(?![\s\S]))/im);
  if (gateMatch) next = next.slice(0, gateMatch.index) + block + next.slice(gateMatch.index + gateMatch[0].length);
  else {
    const at = reportEvidence(next).search(/^#{2,3}[ \t]+(?:Block[ \t]+)?A(?:[).:—–-]|[ \t]+[—–-])[ \t]*/im);
    if (at < 0) throw new Error('Report has no Block A.');
    next = next.slice(0, at) + block + next.slice(at);
  }
  const prepared = prepareEvaluationReport(next);
  if (!prepared.ok) throw new Error(prepared.error);
  return prepared.markdown;
}
