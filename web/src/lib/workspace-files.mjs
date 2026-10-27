import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { WorkspaceError } from './career-workspace.mjs';

export const MAX_DOCUMENT_BYTES = 200_000;

/** @param {string} root */
export function canonicalWorkspaceRoot(root) {
  try {
    const base = fs.realpathSync(root);
    if (fs.statSync(base).isDirectory()) return base;
  } catch { /* The caller receives a path-free error below. */ }
  throw new WorkspaceError('The career data directory is unavailable.', 'data_root_unavailable', 500);
}

/** @param {string} root */
export function workspaceIdForRoot(root) {
  // JUDGMENT: draft recovery must not cross data roots when a local port is
  // reused. Canonicalize aliases and hash without exposing the filesystem path.
  return createHash('sha256').update('career-workspace-root\0').update(canonicalWorkspaceRoot(root)).digest('hex');
}

/**
 * EVIDENCE: user-layer paths may be outside the checkout. Reject links beneath
 * the configured root, while allowing OS aliases for the root itself.
 * @param {string} root @param {string} relative
 */
export function workspaceFilePath(root, relative) {
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) {
    throw new WorkspaceError('Invalid workspace path.', 'unsafe_path', 409);
  }
  let current = canonicalWorkspaceRoot(root);
  for (let i = 0; i < parts.length; i++) {
    // EVIDENCE: user data is resolved at runtime, potentially outside the app.
    // Annotations exclude data from build traces, not these containment checks.
    // https://github.com/vercel/next.js/pull/95144
    current = path.join(/* turbopackIgnore: true */ current, parts[i]);
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

/** @param {string} root @param {string} relative @param {number} [maxBytes] */
export function readWorkspaceFile(root, relative, maxBytes = MAX_DOCUMENT_BYTES) {
  const file = workspaceFilePath(root, relative);
  let bytes;
  try {
    if (fs.statSync(/* turbopackIgnore: true */ file).size > maxBytes) throw new WorkspaceError('Workspace file is too large.', 'too_large', 413);
    bytes = fs.readFileSync(/* turbopackIgnore: true */ file);
  } catch (e) {
    if (e?.code === 'ENOENT') return { file, content: '', exists: false };
    throw e;
  }
  if (bytes.byteLength > maxBytes) throw new WorkspaceError('Workspace file is too large.', 'too_large', 413);
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw new WorkspaceError('Workspace file is not valid UTF-8; it was left untouched.', 'invalid_encoding', 409);
  return { file, content, exists: true };
}

/** @param {unknown} content @param {number} [maxBytes] */
export function validateWorkspaceContent(content, maxBytes = MAX_DOCUMENT_BYTES) {
  if (typeof content !== 'string') throw new WorkspaceError('Document content must be text.', 'invalid_content');
  if (Buffer.byteLength(content, 'utf8') > maxBytes) throw new WorkspaceError('Workspace file is too large.', 'too_large', 413);
  if (Buffer.from(content, 'utf8').toString('utf8') !== content) throw new WorkspaceError('Document contains an invalid Unicode character; it was left untouched.', 'invalid_encoding');
  return content;
}
