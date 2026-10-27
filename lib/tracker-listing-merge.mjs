import { HEADER_ALIASES, detectColumns, isHeaderRow, isSeparatorRow, parseTrackerRow, parseMarkdownLinks, REQ_NUMBER_RE } from '../tracker-parse.mjs';
import { normalizeCompany, resolveCanonicalStateId } from '../tracker-utils.mjs';
import { normalizeUrl, postingUrlRelation, postingLanguageKey } from '../url-key.mjs';

const PLACEHOLDER = /^(?:see report|unknown|pending|tbd|n\/?a|none|null|[-—–?]*)$/i;
const textKey = (value) => String(value ?? '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');

// EVIDENCE: pipeline-groups.mjs already groups presentation-only title variants
// this way; retaining every meaningful word keeps seniority and team distinct.
function roleKey(value) {
  return textKey(value)
    .replace(/\(\s*(?:[mfwxd]\s*[/|]\s*){1,2}[mfwxd]\s*\)/g, ' ')
    .replace(/[(),\-–—]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function linkedinPosting(value) {
  try {
    const url = new URL(value);
    return /^(?:[a-z]+\.)?linkedin\.com$/.test(url.hostname) && /^\/jobs\/view\//.test(url.pathname);
  } catch { return false; }
}

export function parseListingSelection(keep, nums) {
  const raw = Array.isArray(nums) ? nums : String(nums ?? '').split(',');
  const valid = (value) => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
  if (!valid(keep) || raw.length < 2 || !raw.every(valid)) throw new Error('Choose at least two positive tracker numbers and a valid --keep number.');
  const selected = raw.map(String);
  if (new Set(selected).size !== selected.length) throw new Error('Tracker numbers must not repeat.');
  if (!selected.includes(String(keep))) throw new Error('The --keep number must be included in --nums.');
  return { keep: String(keep), nums: selected };
}

/** Explicitly merged source aliases, retained in ordinary readable Markdown. */
export function parseMergedListingSources(notes) {
  return parseMarkdownLinks(String(notes ?? '')).flatMap(({ label, target }) => {
    const match = /^Merged listing #([1-9]\d*)$/.exec(label);
    return match && normalizeUrl(target) ? [{ num: match[1], url: target }] : [];
  });
}

/**
 * Merge explicit same-opening selections in the first tracker table only.
 * Every untouched line stays byte-for-byte; removed rows are archived in Notes.
 */
export function mergeListingContent(content, { keep, nums, states }) {
  const selection = parseListingSelection(keep, nums);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(eol);
  // The core parser uses pipe positions. Protect Markdown's escaped literal
  // pipes before delegating to it, then restore their exact original spelling.
  let escapedPipe = '\uE000';
  while (content.includes(escapedPipe)) escapedPipe += '\uE000';
  const protect = (line) => line.replace(/\\\|/g, escapedPipe);
  const restore = (value) => String(value ?? '').split(escapedPipe).join('\\|');
  const headerIndex = lines.findIndex((line, index) => line.startsWith('|') && isSeparatorRow(lines[index + 1] ?? ''));
  if (headerIndex < 0 || !isHeaderRow(protect(lines[headerIndex]))) throw new Error('Tracker header and separator are missing or malformed.');
  const header = protect(lines[headerIndex]).split('|').map((cell) => cell.trim());
  const labels = header.slice(1, header.at(-1) === '' ? -1 : undefined);
  const columns = detectColumns([protect(lines[headerIndex])]);
  const mappedFields = labels.map((label) => HEADER_ALIASES[label.toLowerCase()]).filter(Boolean);
  if (new Set(mappedFields).size !== mappedFields.length || columns.notes == null) throw new Error('Tracker needs unambiguous column labels and a Notes column.');
  const rows = [];
  for (let index = headerIndex + 2; index < lines.length && lines[index].startsWith('|'); index++) {
    const protectedLine = protect(lines[index]);
    const parts = protectedLine.split('|').map((cell) => cell.trim());
    const rawNum = parts[columns.num];
    if (!selection.nums.includes(String(Number(rawNum)))) continue;
    const width = labels.length + (parts.at(-1) === '' ? 2 : 1);
    const row = parseTrackerRow(protectedLine, columns);
    if (!row || !/^[1-9]\d*$/.test(rawNum) || parts.length !== width) throw new Error(`Tracker #${rawNum} is malformed; nothing was merged.`);
    for (const key of Object.keys(row)) if (typeof row[key] === 'string') row[key] = restore(row[key]);
    rows.push({ ...row, index, parts });
  }
  for (const num of selection.nums) {
    const matches = rows.filter((row) => String(row.num) === num);
    if (matches.length !== 1) throw new Error(matches.length ? `Tracker #${num} is ambiguous; nothing was merged.` : `Tracker #${num} no longer exists; refresh the pipeline.`);
  }
  const target = rows.find((row) => String(row.num) === selection.keep);
  const company = normalizeCompany(target.company);
  const role = roleKey(target.role);
  const status = resolveCanonicalStateId(target.status, states);
  if (!company || PLACEHOLDER.test(textKey(target.company)) || PLACEHOLDER.test(role) || !status) throw new Error('Unknown company, role or status cannot be merged safely.');
  for (const row of rows) {
    if (normalizeCompany(row.company) !== company || roleKey(row.role) !== role) throw new Error('Selected listings must have the same company and full role title.');
    if (resolveCanonicalStateId(row.status, states) !== status) throw new Error('Selected listings have conflicting statuses.');
    if (textKey(row.location) !== textKey(target.location)) throw new Error('Selected listings have conflicting locations.');
    if (textKey(row.via) !== textKey(target.via)) throw new Error('Selected listings have conflicting channels.');
  }
  // The original Notes snapshots stay inline, so every recognized requisition
  // ID remains evidence even after several merges. Checking only the first
  // match would hide a conflicting ID in an earlier source's Notes snapshot.
  const requisitions = new Set(rows.flatMap((row) =>
    [...row.notes.matchAll(new RegExp(REQ_NUMBER_RE.source, 'gi'))].map((match) => match[1].toUpperCase()),
  ));
  if (requisitions.size > 1) throw new Error('Selected listings have conflicting requisition IDs.');
  // JUDGMENT: only an explicit merge may fold LinkedIn repost IDs together.
  // Include previous source aliases in every comparison: retaining a LinkedIn
  // primary URL must not bridge two employer requisitions over successive merges.
  const urls = [...new Set(rows.flatMap((row) =>
    [row.url, ...parseMergedListingSources(row.notes).map((source) => source.url)]
      .map(normalizeUrl).filter(Boolean),
  ))];
  for (let i = 0; i < urls.length; i++) for (let j = i + 1; j < urls.length; j++) {
    const a = urls[i], b = urls[j];
    const relation = postingUrlRelation(a, b);
    const samePage = postingLanguageKey(a).key === postingLanguageKey(b).key;
    if (relation === 'one-sided-language' || (relation === 'distinct' && (samePage || (!linkedinPosting(a) && !linkedinPosting(b))))) throw new Error('Selected listings have conflicting employer posting URLs.');
  }
  const removed = rows.filter((row) => row !== target);
  const snapshots = removed.map((row) => {
    const url = normalizeUrl(row.url);
    const marker = url ? `[Merged listing #${row.num}](<${url.replace(/>/g, '%3E')}>)` : `Merged listing #${row.num}`;
    const fields = labels.map((label, index) => `${restore(label)}: ${restore(row.parts[index + 1])}`);
    return `${marker}: ${fields.join('; ')}`;
  });
  target.parts[columns.notes] = [restore(target.parts[columns.notes]), ...snapshots].filter(Boolean).join(' · ');
  const targetCells = target.parts.slice(1, target.parts.at(-1) === '' ? -1 : undefined).map(restore);
  const updated = `| ${targetCells.join(' | ')} |`;
  const removedIndices = new Set(removed.map((row) => row.index));
  const next = lines.flatMap((line, index) => removedIndices.has(index) ? [] : [index === target.index ? updated : line]).join(eol);
  return { content: next, kept: selection.keep, merged: removed.map((row) => String(row.num)) };
}
