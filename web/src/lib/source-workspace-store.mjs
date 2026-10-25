import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { WorkspaceError } from './career-workspace.mjs';
import { readWorkspaceFile, validateWorkspaceContent, workspaceFilePath } from './workspace-files.mjs';

export const SOURCE_MANIFEST_PATH = 'data/context-workspace/index.json';
export const MAX_SOURCE_MANIFEST_BYTES = 1_000_000;
export const MAX_SOURCE_PAGES = 5000;
const PAGE_ID = /^[a-f0-9]{32}$/;
const PAGE_USAGES = new Set(['facts', 'preferences', 'reference', 'unconfirmed']);
/** @param {unknown} value */
function validPageId(value) { return typeof value === 'string' && PAGE_ID.test(value); }

/** @typedef {{id:string,title:string,parentId:string|null,order:number,usage?:'facts'|'preferences'|'reference'|'unconfirmed',sourceUrl?:string,sourceEditedAt?:string,importNotes?:string[]}} SourcePage */
/** @typedef {{version:1,rootId:string,pages:SourcePage[]}} SourceManifest */
/** @param {unknown} value */
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** @param {unknown} value */
function validTitle(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 300 && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value;
}
/** @param {unknown} value */
function validImportNotes(value) {
  return Array.isArray(value) && value.length <= 50 && value.every((note) => typeof note === 'string' && note.trim().length > 0 && note.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(note) && Buffer.from(note, 'utf8').toString('utf8') === note);
}
/** @param {unknown} value */
function validSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
}
/** @param {unknown} value */
function validSourceDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  // Date.parse accepts overflowing dates such as February 30. Provenance must
  // retain the actual source date rather than silently rolling into March.
  return new Date(value.slice(0, 10)).toISOString().slice(0, 10) === value.slice(0, 10);
}
function invalidManifest() { return new WorkspaceError('The source-page library index is invalid. Its files were left untouched.', 'invalid_manifest', 409); }

/** Validate the complete graph before trusting any page IDs as file names.
 * @param {unknown} input @returns {SourceManifest}
 */
export function validateSourceManifest(input) {
  if (!isObject(input) || input.version !== 1 || !validPageId(input.rootId) || !Array.isArray(input.pages) || input.pages.length < 1 || input.pages.length > MAX_SOURCE_PAGES) throw invalidManifest();
  const ids = new Set(); const positions = new Set();
  for (const page of input.pages) {
    if (!isObject(page) || !validPageId(page.id) || ids.has(page.id) || !validTitle(page.title) || !(page.parentId === null || validPageId(page.parentId)) || !Number.isSafeInteger(page.order) || page.order < 0) throw invalidManifest();
    if (page.sourceUrl !== undefined && !validSourceUrl(page.sourceUrl)) throw invalidManifest();
    if (page.sourceEditedAt !== undefined && !validSourceDate(page.sourceEditedAt)) throw invalidManifest();
    if (page.importNotes !== undefined && !validImportNotes(page.importNotes)) throw invalidManifest();
    if (page.usage !== undefined && !PAGE_USAGES.has(page.usage)) throw invalidManifest();
    const position = `${page.parentId}:${page.order}`;
    if (positions.has(position)) throw invalidManifest();
    ids.add(page.id); positions.add(position);
  }
  const root = input.pages.find((page) => page.id === input.rootId);
  if (!root || root.parentId !== null) throw invalidManifest();
  for (const page of input.pages) {
    if (page.id !== root.id && (page.parentId === null || !ids.has(page.parentId))) throw invalidManifest();
  }
  // JUDGMENT: iterative traversal bounds stack use for imported deep trees and
  // rejects disconnected cycles as well as orphaned references.
  const children = childrenByParent(input.pages);
  const visited = new Set(); const pending = [{ id: root.id, depth: 0 }];
  while (pending.length) {
    const { id, depth } = pending.pop();
    if (visited.has(id) || depth > 64) throw invalidManifest();
    visited.add(id);
    for (const child of children.get(id) ?? []) pending.push({ id: child.id, depth: depth + 1 });
  }
  if (visited.size !== input.pages.length) throw invalidManifest();
  return input;
}

/** @param {SourcePage[]} pages */
function childrenByParent(pages) {
  /** @type {Map<string|null, SourcePage[]>} */
  const children = new Map();
  for (const page of pages) {
    if (!children.has(page.parentId)) children.set(page.parentId, []);
    children.get(page.parentId).push(page);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.order - b.order);
  return children;
}

/** @param {string} root */
function loadManifest(root) {
  const source = readWorkspaceFile(root, SOURCE_MANIFEST_PATH, MAX_SOURCE_MANIFEST_BYTES);
  if (!source.exists) return null;
  let value;
  try { value = JSON.parse(source.content); } catch { throw invalidManifest(); }
  return { ...source, manifest: validateSourceManifest(value) };
}

/** @param {unknown} document */
function pageIdFromDocument(document) {
  if (typeof document !== 'string' || !/^source-[a-f0-9]{32}$/.test(document)) throw new WorkspaceError('Unknown workspace document.', 'unknown_document', 404);
  return document.slice(7);
}
/** @param {string} id */
function pagePath(id) { return `data/context-workspace/pages/${id}.md`; }
/** @param {SourcePage} page @param {SourcePage[]} pages */
function effectiveUsage(page, pages) {
  const byId = new Map(pages.map((item) => [item.id, item]));
  let current = page;
  while (current) {
    if (current.usage) return current.usage;
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return 'facts';
}
/** @param {SourcePage} page @param {string} workspaceId @param {SourcePage[]} pages */
function metadata(page, workspaceId, pages) {
  return { id: `source-${page.id}`, title: page.title, kind: 'source', group: 'Context', description: 'Part of the career context used for job matching and CV generation.', usage: effectiveUsage(page, pages), declaredUsage: page.usage ?? null, workspaceId, parentDocumentId: page.parentId === null ? null : `source-${page.parentId}`, order: page.order, sourceUrl: page.sourceUrl ?? null, sourceEditedAt: page.sourceEditedAt ?? null, importNotes: page.importNotes ?? [], sections: [] };
}
/** @param {SourcePage} page @param {string} content @param {string} manifestText @param {string} workspaceId @param {SourcePage[]} pages */
function snapshot(page, content, manifestText, workspaceId, pages) {
  // EVIDENCE: title and hierarchy live in the manifest, separate from the body.
  // Include its exact bytes so a stale tab cannot undo any intervening tree edit.
  const revision = createHash('sha256').update('source-page-v1\0').update(page.id).update('\0').update(manifestText).update('\0').update(content).digest('hex');
  return { ...metadata(page, workspaceId, pages), exists: true, content, revision };
}
/** @param {string} root @param {SourcePage} page @param {string} manifestText @param {string} workspaceId @param {SourcePage[]} pages */
function readPage(root, page, manifestText, workspaceId, pages) {
  const body = readWorkspaceFile(root, pagePath(page.id));
  if (!body.exists) throw new WorkspaceError('This source page is listed in the library, but its document is missing. Nothing was created or overwritten.', 'missing_source_page', 409);
  return snapshot(page, body.content, manifestText, workspaceId, pages);
}
/** @param {unknown} error */
function errorInfo(error) {
  return { error: error instanceof WorkspaceError ? error.message : 'The source-page library could not be read.', code: error instanceof WorkspaceError ? error.code : 'read_failed' };
}

/** @param {string} root @param {unknown} document @param {string} workspaceId */
export function readSourceDocument(root, document, workspaceId) {
  const id = pageIdFromDocument(document);
  const source = loadManifest(root);
  const page = source?.manifest.pages.find((candidate) => candidate.id === id);
  if (!page) throw new WorkspaceError('Unknown workspace document.', 'unknown_document', 404);
  return readPage(root, page, source.content, workspaceId, source.manifest.pages);
}

/** @param {string} root @param {string} workspaceId */
export function listSourceDocuments(root, workspaceId) {
  let source;
  try { source = loadManifest(root); }
  catch (error) { return { documents: [], sourceRootDocumentId: null, sourceError: errorInfo(error) }; }
  if (!source) return { documents: [], sourceRootDocumentId: null, sourceError: null };
  const children = childrenByParent(source.manifest.pages);
  const pending = [source.manifest.pages.find((page) => page.id === source.manifest.rootId)];
  const documents = []; let sourceError = null;
  while (pending.length) {
    const page = pending.pop();
    try {
      const { content: _content, revision: _revision, ...summary } = readPage(root, page, source.content, workspaceId, source.manifest.pages);
      documents.push(summary);
    } catch (error) {
      sourceError ??= errorInfo(error);
      documents.push({ ...metadata(page, workspaceId, source.manifest.pages), exists: true, ...errorInfo(error) });
    }
    pending.push(...(children.get(page.id) ?? []).toReversed());
  }
  return { documents, sourceRootDocumentId: `source-${source.manifest.rootId}`, sourceError };
}

/** @param {unknown} title */
function mutationTitle(title) {
  if (!validTitle(title)) throw new WorkspaceError('Use a page title between 1 and 300 characters, without line breaks.', 'invalid_title');
  return title.trim();
}
/** @param {SourceManifest} manifest */
function serializeManifest(manifest) {
  validateSourceManifest(manifest);
  return validateWorkspaceContent(JSON.stringify(manifest, null, 2) + '\n', MAX_SOURCE_MANIFEST_BYTES);
}

/**
 * All reads, revision checks and writes are synchronous, like local documents.
 * Only the existing injected backup writer persists user content.
 * @param {{root:string,workspaceId:string,request:import('./career-workspace.mjs').WorkspaceMutation & {document:string,revision:string,usage?:string},write:(file:string,content:string)=>unknown}} options
 */
export function saveSourceDocument({ root, workspaceId, request, write }) {
  const id = pageIdFromDocument(request.document);
  const source = loadManifest(root);
  const page = source?.manifest.pages.find((candidate) => candidate.id === id);
  if (!page) throw new WorkspaceError('Unknown workspace document.', 'unknown_document', 404);
  const before = readPage(root, page, source.content, workspaceId, source.manifest.pages);
  if (request.revision !== before.revision) throw new WorkspaceError('This document or its page hierarchy changed elsewhere. Reload before saving; your draft has not been written.', 'stale', 409);
  if (request.section !== undefined && request.section !== null) throw new WorkspaceError('Source-page headings are content, not separate pages. Edit the whole page.', 'invalid_section');
  let selectedPage = page; let content = before.content; let manifestText = source.content;
  if (request.action === 'replace') {
    content = validateWorkspaceContent(request.content);
    if (content !== before.content) write(workspaceFilePath(root, pagePath(id)), content);
  } else if (request.action === 'usage') {
    if (!PAGE_USAGES.has(request.usage)) throw new WorkspaceError('Choose how this page is used: career facts, job preferences, reference material or unconfirmed notes.', 'invalid_usage');
    if (request.usage !== before.usage) {
      page.usage = /** @type {SourcePage['usage']} */ (request.usage);
      manifestText = serializeManifest(source.manifest);
      write(workspaceFilePath(root, SOURCE_MANIFEST_PATH), manifestText);
    }
  } else if (request.action === 'rename') {
    const title = mutationTitle(request.title);
    if (title !== page.title) {
      page.title = title;
      manifestText = serializeManifest(source.manifest);
      write(workspaceFilePath(root, SOURCE_MANIFEST_PATH), manifestText);
    }
  } else if (request.action === 'move') {
    if (request.direction !== 'up' && request.direction !== 'down') throw new WorkspaceError('Choose whether to move the page up or down.', 'invalid_direction');
    const siblings = source.manifest.pages.filter((candidate) => candidate.parentId === page.parentId).sort((a, b) => a.order - b.order);
    const position = siblings.findIndex((candidate) => candidate.id === id);
    const other = siblings[position + (request.direction === 'up' ? -1 : 1)];
    if (!other) throw new WorkspaceError('There is no sibling page in that direction.', 'no_sibling');
    [page.order, other.order] = [other.order, page.order];
    manifestText = serializeManifest(source.manifest);
    write(workspaceFilePath(root, SOURCE_MANIFEST_PATH), manifestText);
  } else if (request.action === 'add') {
    const title = mutationTitle(request.title);
    const siblings = source.manifest.pages.filter((candidate) => candidate.parentId === id);
    const order = Math.max(-1, ...siblings.map((candidate) => candidate.order)) + 1;
    let newId; let file;
    do {
      newId = randomUUID().replaceAll('-', '');
      file = workspaceFilePath(root, pagePath(newId));
    } while (source.manifest.pages.some((candidate) => candidate.id === newId) || fs.existsSync(file));
    selectedPage = { id: newId, title, parentId: id, order };
    source.manifest.pages.push(selectedPage);
    manifestText = serializeManifest(source.manifest);
    // JUDGMENT: publish the child body before its manifest reference. A failure
    // cannot leave a referenced missing page; remove only our new empty body.
    write(file, '');
    try { write(workspaceFilePath(root, SOURCE_MANIFEST_PATH), manifestText); }
    catch (error) {
      try {
        const created = readWorkspaceFile(root, pagePath(newId));
        if (created.exists && created.content === '') fs.unlinkSync(created.file);
      } catch { /* Preserve the original write error. */ }
      throw error;
    }
    content = '';
  } else {
    throw new WorkspaceError('Unknown document action.', 'invalid_action');
  }
  return { ...snapshot(selectedPage, content, manifestText, workspaceId, source.manifest.pages), selectedSection: null, selectedDocument: `source-${selectedPage.id}` };
}
