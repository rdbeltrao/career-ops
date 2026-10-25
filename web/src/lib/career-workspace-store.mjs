import { createHash } from 'node:crypto';
import { inspectOutline, mutateDocument, WorkspaceError } from './career-workspace.mjs';
import { MAX_DOCUMENT_BYTES, readWorkspaceFile, validateWorkspaceContent, workspaceFilePath, workspaceIdForRoot } from './workspace-files.mjs';
import { listSourceDocuments, readSourceDocument, saveSourceDocument } from './source-workspace-store.mjs';

export { MAX_DOCUMENT_BYTES };

// EVIDENCE: AGENTS.md's source-of-truth tiers distinguish facts, targeting and
// derived stories. These labels preserve that boundary without reading new stores.
export const WORKSPACE_DOCUMENTS = Object.freeze([
  { id: 'context', title: 'Application profile', group: 'App summaries', file: 'modes/_context.md', description: 'Career facts and preferences compiled for job matching. This is a local summary, not a copy of the source page hierarchy.' },
  { id: 'achievements', title: 'Professional examples & proof points', group: 'App summaries', file: 'article-digest.md', description: 'A local digest of reusable examples and source references, not the complete approved-achievements source page.' },
  { id: 'profile', title: 'Role preferences & positioning', group: 'App settings', file: 'modes/_profile.md', description: 'Targets, preferences and framing; not evidence of accomplishments.' },
  { id: 'cv', title: 'CV draft', group: 'Documents', file: 'cv.md', description: 'The app’s working résumé, built from career context. This is an output document, not a source page from Notion.' },
  { id: 'stories', title: 'Interview story bank', group: 'Interview preparation', file: 'interview-prep/story-bank.md', description: 'Working interview narratives. Figures and scope still need support from career records.' },
  { id: 'guide', title: 'Writing & workflow rules', group: 'App settings', file: 'modes/_custom.md', description: 'Instructions for how the app writes and runs the job search; not the source workspace’s generation guide.' },
]);

/** @param {unknown} id */
function documentInfo(id) {
  const info = WORKSPACE_DOCUMENTS.find((d) => d.id === id);
  if (!info) throw new WorkspaceError('Unknown workspace document.', 'unknown_document', 404);
  return info;
}

/** @param {string} content @param {boolean} exists */
function revisionOf(content, exists) {
  return createHash('sha256').update(exists ? 'present\0' : 'missing\0').update(content).digest('hex');
}

/** @param {typeof WORKSPACE_DOCUMENTS[number]} info @param {string} content @param {boolean} exists @param {string} workspaceId */
function snapshot(info, content, exists, workspaceId) {
  const { file: _file, ...metadata } = info;
  const { sections, warning } = inspectOutline(content);
  return { ...metadata, kind: 'local', parentDocumentId: null, sourceUrl: null, workspaceId, exists, content, revision: revisionOf(content, exists), sections, ...(warning ? { outlineWarning: warning } : {}) };
}

/** @param {string} root @param {unknown} id */
export function readWorkspaceDocument(root, id) {
  const workspaceId = workspaceIdForRoot(root);
  if (typeof id === 'string' && id.startsWith('source-')) return readSourceDocument(root, id, workspaceId);
  const info = documentInfo(id);
  const { content, exists } = readWorkspaceFile(root, info.file);
  return snapshot(info, content, exists, workspaceId);
}

/** @param {string} root */
export function listWorkspaceDocuments(root) {
  const workspaceId = workspaceIdForRoot(root);
  const sources = listSourceDocuments(root, workspaceId);
  const localDocuments = WORKSPACE_DOCUMENTS.map((info) => {
    const { file: _file, ...metadata } = info;
    try {
      const { content: _content, revision: _revision, ...summary } = readWorkspaceDocument(root, info.id);
      return summary;
    } catch (e) {
      return { ...metadata, kind: 'local', parentDocumentId: null, sourceUrl: null, workspaceId, exists: true, sections: [], error: e instanceof WorkspaceError ? e.message : 'This document could not be read.', code: e instanceof WorkspaceError ? e.code : 'read_failed' };
    }
  });
  return { ...sources, workspaceId, documents: [...sources.documents, ...localDocuments] };
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
  if (typeof request.document === 'string' && request.document.startsWith('source-')) return saveSourceDocument({ root, request, write, workspaceId: workspaceIdForRoot(root) });
  const info = documentInfo(request.document);
  if (typeof request.content === 'string' && Buffer.byteLength(request.content, 'utf8') > MAX_DOCUMENT_BYTES) throw new WorkspaceError('Document is too large (over 200KB).', 'too_large', 413);
  const before = readWorkspaceDocument(root, info.id);
  if (request.revision !== before.revision) throw new WorkspaceError('This document changed elsewhere. Reload before saving; your draft has not been written.', 'stale', 409);
  const mutation = mutateDocument(before.content, request);
  validateWorkspaceContent(mutation.content);
  if (mutation.content !== before.content || !before.exists) {
    const file = workspaceFilePath(root, info.file);
    write(file, mutation.content);
  }
  return { ...snapshot(info, mutation.content, true, before.workspaceId), selectedSection: mutation.selectedSection };
}
