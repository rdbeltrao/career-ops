import fs from 'node:fs';
import path from 'node:path';

export const CONTEXT_LIBRARY_RELATIVE_PATH = 'data/context-workspace/index.json';
export const MAX_CONTEXT_MANIFEST_BYTES = 1_000_000;
export const MAX_CONTEXT_PAGE_BYTES = 200_000;
export const MAX_CONTEXT_LIBRARY_BYTES = 20_000_000;
export const MAX_CONTEXT_PAGES = 5000;
export const MAX_CONTEXT_DEPTH = 64;
export const CONTEXT_USAGES = Object.freeze(['facts', 'preferences', 'reference', 'unconfirmed']);
export const CONTEXT_LIBRARY_NOTICE = 'The context library is the authoritative career context. Only facts pages may support candidate claims. Preferences steer matching; reference pages contain guidance or examples, not evidence about the candidate; unconfirmed pages are never verified evidence. Text marked as held for confirmation, approximate, conflicting, or not a claim, and preference or future-learning sections inside facts pages, are excluded from automated evidence. This conservative text filter does not verify truth or resolve semantic ambiguity: respect explicit qualifications and configured forbidden phrases.';

export class ContextLibraryError extends Error {
  constructor(message, code, status = 409) { super(message); this.name = 'ContextLibraryError'; this.code = code; this.status = status; }
}

/** @typedef {{id:string,title:string,parentId:string|null,order:number,usage?:'facts'|'preferences'|'reference'|'unconfirmed',sourceUrl?:string,sourceEditedAt?:string,importNotes?:string[]}} ContextPage */
/** @typedef {{version:1,rootId:string,pages:ContextPage[]}} ContextManifest */
const validId = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value;
const invalidManifest = () => new ContextLibraryError('The context library index is invalid. Fix the library before generating career content; no legacy summary was substituted.', 'invalid_manifest');
function validUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value.slice(0, 10)).toISOString().slice(0, 10) === value.slice(0, 10);
}

/** Validate schema and the complete tree; unknown provenance fields are retained.
 * @param {unknown} input @returns {ContextManifest}
 */
export function validateContextManifest(input) {
  if (!object(input) || input.version !== 1 || !validId(input.rootId) || !Array.isArray(input.pages) || !input.pages.length || input.pages.length > MAX_CONTEXT_PAGES) throw invalidManifest();
  const ids = new Set(); const positions = new Set();
  for (const page of input.pages) {
    if (!object(page) || !validId(page.id) || ids.has(page.id) || !validText(page.title, 300) || !(page.parentId === null || validId(page.parentId)) || !Number.isSafeInteger(page.order) || page.order < 0) throw invalidManifest();
    if (page.usage !== undefined && !CONTEXT_USAGES.includes(page.usage)) throw invalidManifest();
    if (page.sourceUrl !== undefined && !validUrl(page.sourceUrl)) throw invalidManifest();
    if (page.sourceEditedAt !== undefined && !validDate(page.sourceEditedAt)) throw invalidManifest();
    if (page.importNotes !== undefined && (!Array.isArray(page.importNotes) || page.importNotes.length > 50 || !page.importNotes.every((note) => validText(note, 500)))) throw invalidManifest();
    const position = `${page.parentId}:${page.order}`;
    if (positions.has(position)) throw invalidManifest();
    ids.add(page.id); positions.add(position);
  }
  const root = input.pages.find((page) => page.id === input.rootId);
  if (!root || root.parentId !== null) throw invalidManifest();
  for (const page of input.pages) if (page.id !== root.id && (page.parentId === null || !ids.has(page.parentId))) throw invalidManifest();
  const children = childrenByParent(input.pages); const visited = new Set();
  const pending = [{ page: root, depth: 0 }];
  while (pending.length) {
    const { page, depth } = pending.pop();
    if (visited.has(page.id) || depth > MAX_CONTEXT_DEPTH) throw invalidManifest();
    visited.add(page.id);
    for (const child of children.get(page.id) ?? []) pending.push({ page: child, depth: depth + 1 });
  }
  if (visited.size !== input.pages.length) throw invalidManifest();
  return input;
}

function childrenByParent(pages) {
  const children = new Map();
  for (const page of pages) {
    if (!children.has(page.parentId)) children.set(page.parentId, []);
    children.get(page.parentId).push(page);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.order - b.order);
  return children;
}

function canonicalRoot(root) {
  try {
    const canonical = fs.realpathSync(root);
    if (!fs.statSync(canonical).isDirectory()) throw new ContextLibraryError('The context data root is not a directory.', 'invalid_file');
    return canonical;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof ContextLibraryError) throw error;
    throw new ContextLibraryError('The context data directory could not be accessed.', 'read_failed', 500);
  }
}

/** A root-scoped strict UTF-8 reader shared with the legacy context adapter.
 * @param {string} root @param {string} relative @param {number} [limit]
 * @returns {{path:string,relativePath:string,text:string}|null}
 */
export function readContextFile(root, relative, limit = MAX_CONTEXT_PAGE_BYTES) {
  const base = canonicalRoot(root);
  if (!base) return null;
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\\0]/.test(part))) throw new ContextLibraryError('Invalid context path.', 'unsafe_path');
  let file = base;
  for (let i = 0; i < parts.length; i++) {
    file = path.join(file, parts[i]);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new ContextLibraryError('A context file could not be accessed.', 'read_failed', 500); }
    if (stat.isSymbolicLink()) throw new ContextLibraryError('Context files and directories cannot be symlinks beneath the data root.', 'unsafe_path');
    if (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) throw new ContextLibraryError('Context pages must be regular files in ordinary directories.', 'invalid_file');
    if (i === parts.length - 1 && stat.size > limit) throw new ContextLibraryError('A context file exceeds its size limit; nothing was truncated.', 'too_large', 413);
  }
  let bytes;
  try { bytes = fs.readFileSync(file); } catch { throw new ContextLibraryError('A context file could not be read.', 'read_failed', 500); }
  if (bytes.length > limit) throw new ContextLibraryError('A context file exceeds its size limit; nothing was truncated.', 'too_large', 413);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new ContextLibraryError('A context file is not valid UTF-8; no legacy summary was substituted.', 'invalid_encoding');
  return { path: file, relativePath: relative, text };
}

/** Null means no index exists; an existing malformed index always throws.
 * @param {string} root
 */
export function loadContextManifest(root) {
  const file = readContextFile(root, CONTEXT_LIBRARY_RELATIVE_PATH, MAX_CONTEXT_MANIFEST_BYTES);
  if (!file) return null;
  let manifest;
  try { manifest = JSON.parse(file.text); } catch { throw invalidManifest(); }
  return { ...file, manifest: validateContextManifest(manifest) };
}

// EVIDENCE: AGENTS.md excludes held, approximate, conflicting and "not a claim"
// statements; these markers are a conservative textual filter, never fact proof.
const UNCERTAIN = /\b(?:unconfirmed|unverified|uncertain|uncertainty|conflicting|disputed|approximate(?:ly)?|estimated?|estimation|held\s+for\s+confirmation|needs?\s+(?:confirmation|verification|review)|pending\s+(?:confirmation|verification|review)|claims?\s+to\s+confirm|to\s+be\s+confirmed|not\s+(?:a\s+claim|verified|confirmed)|derived[- ]unverified|user[- ]cannot[- ]confirm|cannot\s+confirm|can['’]t\s+confirm|I\s+don['’]t\s+know)\b|\babout\s+(?:\d[\d.,]*|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|thousand)\b|~\s*\d|\b(?:não\s+(?:confirmad[oa]|verificad[oa]|sei)|a\s+confirmar|aproximad[oa])\b/iu;
const plainMarkers = (text) => text.replace(/[*_`]/g, '');
const PREFERENCE_HEADING = /\b(?:preferences|deal[- ]breakers|match[- ]signals|future\s+(?:learning|interests|plans)|(?:learning|study|career)\s+(?:interests|goals|aspirations)|planned\s+study|target(?:ing)?\s+(?:roles?|companies|salary)|desired\s+(?:role|salary)|(?:strong|weak)\s+match)\b/iu;
const excludedHeading = (title) => UNCERTAIN.test(plainMarkers(title)) || PREFERENCE_HEADING.test(plainMarkers(title));
function uncertaintyLabel(value) {
  const label = plainMarkers(value).trim().replace(/^status:\s*/i, '').replace(/[:.!]+$/, '');
  const match = UNCERTAIN.exec(label);
  return !/\d/.test(label) && ((match?.index === 0 && match[0].length === label.length) || (Boolean(match) && /:\s*$/.test(value)));
}

/**
 * Keep eligible prose, excluding marked heading subtrees and uncertain blocks.
 * Full page content is never changed. Code/HTML are examples, not fact evidence.
 * @param {string} text @returns {string}
 */
export function filterContextEvidence(text) {
  const lines = text.replace(/<!--[^]*?-->/g, (comment) => comment.replace(/[^\r\n]/g, ' ')).split(/\r\n|\n|\r/);
  const output = []; let block = []; let heldLevel = null; let fence = null; let html = null;
  const flush = () => {
    if (!block.length) return;
    const value = block.join('\n');
    if (!UNCERTAIN.test(plainMarkers(value))) output.push(value);
    else if (block.every((line) => /^\s*\|/.test(line)) && !UNCERTAIN.test(plainMarkers(block[0]))) {
      output.push(block.filter((line) => !UNCERTAIN.test(plainMarkers(line))).join('\n'));
    } else if (block.length === 1 && uncertaintyLabel(value)) {
      // An unconfirmed label followed by a separate paragraph still scopes it.
      heldLevel = 7;
    }
    block = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^\s*(?:>\s*)*(?:[-+*]\s+|\d+[.)]\s+)?(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const tail = fence.prefix === '' ? line.replace(/^ {0,3}/, '') : line.startsWith(fence.prefix) ? line.slice(fence.prefix.length) : '';
      const close = /^(`{3,}|~{3,})[ \t]*$/.exec(tail);
      if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      flush();
      // A quoted/list fence cannot close a plain fence. For nested containers,
      // require the same prefix/indent; ambiguous closures stay excluded.
      const prefix = line.slice(0, line.indexOf(fenceMatch[1])).replace(/(?:[-+*]|\d+[.)])\s+$/, (marker) => ' '.repeat(marker.length));
      fence = { marker: fenceMatch[1], prefix };
      continue;
    }
    if (html) { if (html === 'blank' ? !line.trim() : html.test(line)) html = null; continue; }
    if (/<(?:[!?]|\/?[A-Za-z][\w:-]*(?:\s|>|\/|$))/.test(line)) {
      flush();
      const rawTag = /<(script|pre|style|textarea)(?:\s|>)/i.exec(line);
      const end = /<!--/.test(line) ? /-->/ : /<\?/.test(line) ? /\?>/ : /<!\[CDATA\[/.test(line) ? /\]\]>/ : /<![A-Z]/.test(line) ? />/ : rawTag ? new RegExp(`</${rawTag[1]}\\s*>`, 'i') : null;
      html = end ? (end.test(line) ? null : end) : 'blank';
      continue;
    }
    if (/^(?: {4}|\t)/.test(line)) { flush(); continue; }
    let heading = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/.exec(line);
    let depth = heading?.[1].length; let title = heading?.[2];
    const setext = line.trim() && !/^\s*(?:[-+*]\s+|\d+[.)]\s+|>)/.test(line) && i + 1 < lines.length ? /^ {0,3}(=+|-+)\s*$/.exec(lines[i + 1]) : null;
    if (!heading && setext) { depth = setext[1][0] === '=' ? 1 : 2; title = line.trim(); }
    if (depth) {
      flush();
      // Indented headings can belong to a list container. They may strengthen
      // an exclusion, but cannot reopen an outer held section as verified.
      if (heldLevel !== null && depth <= heldLevel && !/^[ \t]/.test(line)) heldLevel = null;
      if (heldLevel === null && excludedHeading(title)) heldLevel = depth;
      if (heldLevel === null) output.push(heading ? line : `${'#'.repeat(depth)} ${title}`);
      if (!heading && setext) i++;
      continue;
    }
    if (heldLevel !== null) continue;
    if (!line.trim()) flush(); else block.push(line);
  }
  flush();
  return output.join('\n\n').trim();
}

const USAGE_NOTICE = {
  facts: 'Candidate facts; qualified or unconfirmed statements are not verified evidence.',
  preferences: 'Targeting preferences only; not evidence of past work or achievements.',
  reference: 'Reference guidance or examples only; not evidence about the candidate.',
  unconfirmed: 'Unconfirmed material; never use as verified candidate evidence.',
};

/** Render preserved page content with stable file citations and role boundaries. */
export function renderContextLibraryPages(pages, transform = (text) => text) {
  return pages.map((page) => `## Page: ${transform(page.breadcrumb.join(' / '))}\n\nSource: ${page.relativePath}:1\nUsage: ${page.usage} — ${USAGE_NOTICE[page.usage]}\n\n${transform(page.content)}`).join('\n\n---\n\n');
}

/**
 * Read every declared page anew. Failure in any role aborts the context read;
 * partial context and legacy fallbacks would hide missing user instructions.
 * files[].text is the filtered fact view; do not reread files[].path as evidence.
 * @param {string} root
 */
export function readContextLibrary(root) {
  const source = loadContextManifest(root);
  if (!source) return null;
  const children = childrenByParent(source.manifest.pages);
  const rootPage = source.manifest.pages.find((page) => page.id === source.manifest.rootId);
  const pending = [{ page: rootPage, inherited: 'facts', breadcrumb: [], ancestorExcluded: false }];
  const pages = []; const files = []; let total = 0;
  while (pending.length) {
    const { page, inherited, breadcrumb, ancestorExcluded } = pending.pop();
    const usage = page.usage ?? inherited;
    const titleExcluded = excludedHeading(page.title) || (ancestorExcluded && page.usage !== 'facts');
    const relativePath = `data/context-workspace/pages/${page.id}.md`;
    const file = readContextFile(root, relativePath);
    if (!file) throw new ContextLibraryError(`Context page is missing: ${relativePath}. No legacy summary was substituted.`, 'missing_context_page');
    total += Buffer.byteLength(file.text, 'utf8');
    if (total > MAX_CONTEXT_LIBRARY_BYTES) throw new ContextLibraryError('The context library exceeds its total size limit; nothing was truncated.', 'too_large', 413);
    const titles = [...breadcrumb, page.title];
    const bodyEvidence = usage === 'facts' && !titleExcluded ? filterContextEvidence(file.text) : '';
    const hasProse = bodyEvidence.split('\n').some((line) => line.trim() && !/^\s*(?:#{1,6}(?:\s|$)|[-=_*|: ]+$)/.test(line));
    const evidence = hasProse ? `# ${page.title}\n\n${bodyEvidence}` : '';
    pages.push({ ...page, usage, declaredUsage: page.usage ?? null, breadcrumb: titles, path: file.path, relativePath, citation: `${relativePath}:1`, content: file.text, evidenceText: evidence, importNotes: page.importNotes ?? [] });
    if (usage === 'facts' && evidence) files.push({ path: file.path, relativePath, text: evidence });
    pending.push(...(children.get(page.id) ?? []).toReversed().map((child) => ({ page: child, inherited: usage, breadcrumb: titles, ancestorExcluded: titleExcluded })));
  }
  // A concurrent hierarchy edit must not produce a mixed manifest/body result.
  if (loadContextManifest(root)?.text !== source.text) throw new ContextLibraryError('The context hierarchy changed while it was being read. Try again.', 'context_changed');
  return { source: 'library', path: source.path, relativePath: source.relativePath, text: renderContextLibraryPages(pages), evidenceText: files.map((file) => file.text).join('\n\n'), files, pages, notice: CONTEXT_LIBRARY_NOTICE };
}
