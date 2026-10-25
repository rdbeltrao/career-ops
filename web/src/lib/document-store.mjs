import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWrite } from './core/safe-write.ts';
import { acquireDirLock, releaseOrWarn } from './core/dir-lock.mjs';

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
const TOKEN = /^\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class DocumentStoreError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'DocumentStoreError';
    this.status = status;
  }
}

export function documentId(filename) {
  return Buffer.from(filename).toString('base64url');
}

function filenameFromId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,700}$/.test(id)) {
    throw new DocumentStoreError(400, 'Invalid document identifier.');
  }
  const filename = Buffer.from(id, 'base64url').toString('utf8');
  if (documentId(filename) !== id || /[/\\\u0000-\u001f\u007f]/.test(filename) ||
      filename === '.' || filename === '..' || !/\.pdf$/i.test(filename) || Buffer.byteLength(filename) > 255) {
    throw new DocumentStoreError(400, 'Invalid document identifier.');
  }
  return filename;
}

function statOrNull(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Walk fixed directory names one at a time: recursive mkdir must not follow a symlink. */
function safeDirectory(root, segments, create = false) {
  let current = fs.realpathSync(root);
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat = statOrNull(current);
    if (!stat && create) {
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = fs.lstatSync(current);
    }
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new DocumentStoreError(409, 'Document storage contains an unsafe directory.');
    }
  }
  return current;
}

function outputPath(root, id) {
  const filename = filenameFromId(id);
  const output = safeDirectory(root, ['output']);
  if (!output) throw new DocumentStoreError(404, 'Document not found.');
  return { filename, file: path.join(output, filename) };
}

function readRegular(file, missingMessage = 'Document not found.') {
  const stat = statOrNull(file);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new DocumentStoreError(404, missingMessage);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || stat.dev !== opened.dev || stat.ino !== opened.ino) {
      throw new DocumentStoreError(409, 'Document changed while it was being opened. Reload and try again.');
    }
    if (opened.size > MAX_PDF_BYTES) throw new DocumentStoreError(413, 'PDF must be 20 MiB or smaller.');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > MAX_PDF_BYTES) throw new DocumentStoreError(413, 'PDF must be 20 MiB or smaller.');
    return bytes;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') throw new DocumentStoreError(404, missingMessage);
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function readDocument(root, id) {
  const { filename, file } = outputPath(root, id);
  const bytes = readRegular(file);
  return { id, filename, bytes, revision: revisionOf(bytes) };
}

function revisionOf(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function assertRevision(expected, actual) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new DocumentStoreError(428, 'Reload the PDF before saving or deleting it.');
  }
  if (expected !== actual) throw new DocumentStoreError(409, 'This PDF changed since you opened it. Reload before making changes.');
}

function assertToken(token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw new DocumentStoreError(400, 'Invalid recovery identifier.');
}

/**
 * EVIDENCE: PDF 32000 uses a header, final startxref offset and %%EOF marker.
 * This is a bounded envelope check, not a general PDF parser. The visual editor
 * parses the document with PDFium before exporting bytes to this endpoint.
 */
export function assertPdf(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_PDF_BYTES) {
    throw new DocumentStoreError(413, 'PDF must be 20 MiB or smaller.');
  }
  const data = Buffer.from(bytes);
  const tail = data.subarray(Math.max(0, data.length - 2048)).toString('latin1');
  const end = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  const offset = end ? Number(end[1]) : -1;
  const xref = data.subarray(offset, offset + 80).toString('latin1');
  if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n)/.test(data.subarray(0, 16).toString('latin1')) ||
      !end || !Number.isSafeInteger(offset) || offset < 9 || offset >= data.length ||
      !/^(?:xref\b|\d+\s+\d+\s+obj\b)/.test(xref)) {
    throw new DocumentStoreError(422, 'The edited file is not a complete PDF. Export it again before saving.');
  }
}

function historyDirectory(root, id, child, create = false) {
  filenameFromId(id);
  // Base64 expands a valid 255-byte filename beyond the directory-name limit.
  return safeDirectory(root, ['.career-ops-web', 'document-history', revisionOf(id), ...(child ? [child] : [])], create);
}

function readIdentity(directory, key) {
  try {
    const identity = JSON.parse(readRegular(path.join(directory, 'identity.json')).toString('utf8'));
    if (filenameFromId(identity.id) !== identity.filename || revisionOf(identity.id) !== key) throw new Error('identity mismatch');
    return identity;
  } catch {
    throw new DocumentStoreError(409, 'Document recovery history contains an invalid identity.');
  }
}

function historyFiles(root, id, child) {
  const dir = historyDirectory(root, id, child);
  if (!dir) return [];
  return fs.readdirSync(dir).map((filename) => {
    const token = filename.replace(/\.pdf$/, '');
    if (filename !== `${token}.pdf` || !TOKEN.test(token)) throw new DocumentStoreError(409, 'Document recovery history contains an invalid entry.');
    const stat = fs.lstatSync(path.join(dir, filename));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new DocumentStoreError(409, 'Document recovery history contains an unsafe entry.');
    return { id: token, createdAt: new Date(Number(token.slice(0, 13))).toISOString() };
  }).sort((a, b) => b.id.localeCompare(a.id));
}

export function listDocumentTrash(root) {
  const dir = safeDirectory(root, ['.career-ops-web', 'document-history']);
  if (!dir) return [];
  const documents = [];
  for (const key of fs.readdirSync(dir)) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new DocumentStoreError(409, 'Document recovery history contains an invalid directory.');
    const directory = safeDirectory(root, ['.career-ops-web', 'document-history', key]);
    if (!safeDirectory(root, ['.career-ops-web', 'document-history', key, 'trash'])) continue;
    const { id, filename } = readIdentity(directory, key);
    for (const item of historyFiles(root, id, 'trash')) {
      documents.push({ id, filename, restoreToken: item.id, deletedAt: item.createdAt });
    }
  }
  return documents.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

async function withDocumentLock(root, id, action) {
  const directory = historyDirectory(root, id, null, true);
  for (const suffix of ['document.lock', 'document.lock.recover']) {
    const existing = statOrNull(path.join(directory, suffix));
    if (existing?.isSymbolicLink()) throw new DocumentStoreError(409, 'Document storage contains an unsafe lock.');
  }
  const lock = await acquireDirLock(path.join(directory, 'document.lock'), {
    timeoutMs: 3000, maxWaitMs: 5000, retryMs: 30, staleMs: 30000,
    owner: { purpose: 'document-edit' },
  });
  try {
    const identityPath = path.join(directory, 'identity.json');
    if (statOrNull(identityPath)) readIdentity(directory, revisionOf(id));
    else atomicWrite(identityPath, JSON.stringify({ id, filename: filenameFromId(id) }) + '\n');
    return await action();
  }
  finally { releaseOrWarn(lock); }
}

function saveSnapshot(root, id, bytes) {
  const dir = historyDirectory(root, id, 'versions', true);
  const token = `${Date.now()}-${randomUUID()}`;
  const file = path.join(dir, `${token}.pdf`);
  try { fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') {
      try { fs.rmSync(file, { force: true }); } catch { /* Preserve the original write error. */ }
    }
    throw error;
  }
}

export function createDocumentStore(root) {
  function metadata(id) {
    const { filename, revision } = readDocument(root, id);
    return { id, filename, revision, versions: historyFiles(root, id, 'versions') };
  }
  function replace(id, bytes, expected) {
    const original = readDocument(root, id);
    assertRevision(expected, original.revision);
    assertPdf(bytes);
    // Validate prior recovery state before changing any document bytes. A
    // malformed history must not turn a successful write into an error reply.
    historyFiles(root, id, 'versions');
    if (revisionOf(bytes) === original.revision) return metadata(id);
    saveSnapshot(root, id, original.bytes);
    // Existing manifest rows keep their exact filename. A deleted indexed file
    // remains a rejected lookup instead of falling back to another role's CV.
    atomicWrite(outputPath(root, id).file, bytes);
    return metadata(id);
  }
  return {
    metadata,
    read: (id) => readDocument(root, id),
    trash: () => listDocumentTrash(root),
    save: (id, bytes, revision) => withDocumentLock(root, id, () => replace(id, bytes, revision)),
    remove: (id, revision) => withDocumentLock(root, id, () => {
      const original = readDocument(root, id);
      assertRevision(revision, original.revision);
      const trash = historyDirectory(root, id, 'trash', true);
      const restoreToken = `${Date.now()}-${randomUUID()}`;
      fs.renameSync(outputPath(root, id).file, path.join(trash, `${restoreToken}.pdf`));
      return { id, filename: original.filename, restoreToken };
    }),
    restore: (id, restoreToken) => withDocumentLock(root, id, () => {
      assertToken(restoreToken);
      const dir = historyDirectory(root, id, 'trash');
      if (!dir) throw new DocumentStoreError(404, 'Deleted document not found.');
      const saved = path.join(dir, `${restoreToken}.pdf`);
      assertPdf(readRegular(saved, 'Deleted document not found.'));
      const { file } = outputPath(root, id);
      // JUDGMENT: link is atomic and fails if a new file already occupies the
      // original name; rename would silently overwrite that newer document.
      try { fs.linkSync(saved, file); }
      catch (error) {
        if (error.code === 'EEXIST') throw new DocumentStoreError(409, 'A PDF already uses this filename. It was not overwritten.');
        throw error;
      }
      fs.unlinkSync(saved);
      return metadata(id);
    }),
    restoreVersion: (id, versionId, revision) => withDocumentLock(root, id, () => {
      assertToken(versionId);
      const dir = historyDirectory(root, id, 'versions');
      if (!dir) throw new DocumentStoreError(404, 'Saved version not found.');
      const bytes = readRegular(path.join(dir, `${versionId}.pdf`), 'Saved version not found.');
      return replace(id, bytes, revision);
    }),
  };
}
