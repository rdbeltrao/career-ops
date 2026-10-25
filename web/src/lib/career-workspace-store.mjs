import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectOutline, mutateDocument, WorkspaceError } from './career-workspace.mjs';

export const MAX_DOCUMENT_BYTES = 200_000;

// EVIDENCE: AGENTS.md's source-of-truth tiers distinguish facts, targeting and
// derived stories. These labels preserve that boundary without reading new stores.
export const WORKSPACE_DOCUMENTS = Object.freeze([
  { id: 'context', title: 'Career context', group: 'Context', file: 'modes/_context.md', description: 'Career facts and experience. Context remains the source of truth.' },
  { id: 'achievements', title: 'Approved achievements', group: 'Context', file: 'article-digest.md', description: 'Recorded proof points and their sources. Preserve confirmation labels.' },
  { id: 'profile', title: 'Preferences & positioning', group: 'Context', file: 'modes/_profile.md', description: 'Targets, preferences and framing; not evidence of accomplishments.' },
  { id: 'cv', title: 'Base CV', group: 'CVs', file: 'cv.md', description: 'Your reusable CV. Tailored versions stay with their applications.' },
  { id: 'stories', title: 'Professional examples', group: 'Reference', file: 'interview-prep/story-bank.md', description: 'Accumulated stories. Unverified figures remain unverified.' },
  { id: 'guide', title: 'Writing & workflow guide', group: 'Reference', file: 'modes/_custom.md', description: 'Your procedural and writing rules; never candidate facts.' },
]);

/** @param {unknown} id */
function documentInfo(id) {
  const info = WORKSPACE_DOCUMENTS.find((d) => d.id === id);
  if (!info) throw new WorkspaceError('Unknown workspace document.', 'unknown_document', 404);
  return info;
}

/** @param {string} root */
function canonicalRoot(root) {
  let base;
  try { base = fs.realpathSync(root); }
  catch (e) { throw new WorkspaceError('The career data directory is unavailable.', 'data_root_unavailable', 500); }
  if (!fs.statSync(base).isDirectory()) throw new WorkspaceError('The career data root is not a directory.', 'data_root_unavailable', 500);
  return base;
}

/** @param {string} root */
function workspaceIdForRoot(root) {
  // JUDGMENT: browser draft recovery must not cross data roots when a local
  // server port is reused. Hash the real root without exposing its filesystem path.
  return createHash('sha256').update('career-workspace-root\0').update(canonicalRoot(root)).digest('hex');
}

/**
 * Reject links at every component under the configured root, including missing
 * final files behind an existing linked directory. Root itself may be reached
 * through an OS alias such as macOS /tmp; it is canonicalized once first.
 * @param {string} root @param {string} relative
 */
function documentPath(root, relative) {
  const base = canonicalRoot(root);
  let current = base;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (e) { if (e?.code === 'ENOENT') continue; throw e; }
    if (stat.isSymbolicLink()) throw new WorkspaceError('Workspace documents cannot use symlink files or directories.', 'unsafe_path', 409);
    if (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
      throw new WorkspaceError('The workspace document must be a regular file inside ordinary directories.', 'invalid_file', 409);
    }
  }
  return current;
}

/** @param {string} content @param {boolean} exists */
function revisionOf(content, exists) {
  return createHash('sha256').update(exists ? 'present\0' : 'missing\0').update(content).digest('hex');
}

/** @param {typeof WORKSPACE_DOCUMENTS[number]} info @param {string} content @param {boolean} exists @param {string} workspaceId */
function snapshot(info, content, exists, workspaceId) {
  const { file: _file, ...metadata } = info;
  const { sections, warning } = inspectOutline(content);
  return { ...metadata, workspaceId, exists, content, revision: revisionOf(content, exists), sections, ...(warning ? { outlineWarning: warning } : {}) };
}

/** @param {string} root @param {unknown} id */
export function readWorkspaceDocument(root, id) {
  const info = documentInfo(id);
  const workspaceId = workspaceIdForRoot(root);
  const file = documentPath(root, info.file);
  let bytes;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_DOCUMENT_BYTES) throw new WorkspaceError('Document is too large (over 200KB).', 'too_large', 413);
    bytes = fs.readFileSync(file);
  } catch (e) {
    if (e?.code === 'ENOENT') return snapshot(info, '', false, workspaceId);
    throw e;
  }
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new WorkspaceError('Document is too large (over 200KB).', 'too_large', 413);
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw new WorkspaceError('Document is not valid UTF-8; it was left untouched.', 'invalid_encoding', 409);
  return snapshot(info, content, true, workspaceId);
}

/** @param {string} root */
export function listWorkspaceDocuments(root) {
  const workspaceId = workspaceIdForRoot(root);
  return { workspaceId, documents: WORKSPACE_DOCUMENTS.map((info) => {
    const { file: _file, ...metadata } = info;
    try {
      const { content: _content, revision: _revision, ...summary } = readWorkspaceDocument(root, info.id);
      return summary;
    } catch (e) {
      return { ...metadata, workspaceId, exists: true, sections: [], error: e instanceof WorkspaceError ? e.message : 'This document could not be read.', code: e instanceof WorkspaceError ? e.code : 'read_failed' };
    }
  }) };
}

/** @typedef {import('./career-workspace.mjs').WorkspaceMutation & {document:string,revision:string}} SaveRequest */
/**
 * EVIDENCE: personalization-file.mjs uses a single synchronous read/merge/write
 * with an injected backup writer. Keep that convention, plus revision checks so
 * stale browser drafts cannot replace intervening CLI or editor changes.
 * @param {{root:string,request:SaveRequest,write:(file:string,content:string)=>unknown}} options
 */
export function saveWorkspaceDocument({ root, request, write }) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new WorkspaceError('Invalid document request.', 'invalid_request');
  if (typeof request.revision !== 'string' || !/^[a-f0-9]{64}$/.test(request.revision)) throw new WorkspaceError('A document revision is required before saving.', 'invalid_revision');
  const info = documentInfo(request.document);
  if (typeof request.content === 'string' && Buffer.byteLength(request.content, 'utf8') > MAX_DOCUMENT_BYTES) throw new WorkspaceError('Document is too large (over 200KB).', 'too_large', 413);
  const before = readWorkspaceDocument(root, info.id);
  if (request.revision !== before.revision) throw new WorkspaceError('This document changed elsewhere. Reload before saving; your draft has not been written.', 'stale', 409);
  const mutation = mutateDocument(before.content, request);
  if (Buffer.byteLength(mutation.content, 'utf8') > MAX_DOCUMENT_BYTES) throw new WorkspaceError('Document is too large (over 200KB).', 'too_large', 413);
  if (Buffer.from(mutation.content, 'utf8').toString('utf8') !== mutation.content) throw new WorkspaceError('Document contains an invalid Unicode character; it was left untouched.', 'invalid_encoding', 400);
  if (mutation.content !== before.content || !before.exists) {
    const file = documentPath(root, info.file);
    write(file, mutation.content);
  }
  return { ...snapshot(info, mutation.content, true, before.workspaceId), selectedSection: mutation.selectedSection };
}
