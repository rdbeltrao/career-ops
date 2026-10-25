import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listWorkspaceDocuments, readWorkspaceDocument, saveWorkspaceDocument, MAX_DOCUMENT_BYTES } from '../../src/lib/career-workspace-store.mjs';
import '../helpers/web-ts-alias-loader.mjs';
const { atomicWriteWithBackup } = await import('../../src/lib/core/safe-write.ts');

function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-workspace-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function put(root, rel, text) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }

test('index/read use only allowlisted documents and never write missing files', (t) => {
  const root = fixture(t);
  const index = listWorkspaceDocuments(root);
  assert.deepEqual(index.documents.map((d) => d.id), ['context', 'achievements', 'profile', 'cv', 'stories', 'guide']);
  assert.ok(index.documents.every((d) => d.exists === false));
  assert.deepEqual(fs.readdirSync(root), []);
  assert.throws(() => readWorkspaceDocument(root, '../secrets'), /document/i);
  assert.throws(() => readWorkspaceDocument(root, '__proto__'), /document/i);
});

test('saves use provided root, backup canonical file, and reject stale revisions', (t) => {
  const root = fixture(t); put(root, 'modes/_context.md', '# Context\n\nOriginal.\n');
  const before = readWorkspaceDocument(root, 'context');
  const request = { document: 'context', revision: before.revision, action: 'replace', content: '# Context\n\nChanged.\n' };
  const after = saveWorkspaceDocument({ root, request, write: atomicWriteWithBackup });
  assert.equal(after.content, request.content);
  assert.notEqual(after.revision, before.revision);
  const backup = fs.readdirSync(path.join(root, 'modes')).find((f) => f.startsWith('_context.md.bak-'));
  assert.equal(fs.readFileSync(path.join(root, 'modes', backup), 'utf8'), before.content);
  assert.throws(() => saveWorkspaceDocument({ root, request: { ...request, content: 'Stale overwrite' }, write: atomicWriteWithBackup }), (e) => e.code === 'stale' && e.status === 409);
  assert.equal(readWorkspaceDocument(root, 'context').content, after.content);
});

test('missing and existing empty document revisions differ and no-op saves do not write', (t) => {
  const root = fixture(t);
  const missing = readWorkspaceDocument(root, 'cv'); put(root, 'cv.md', '');
  const empty = readWorkspaceDocument(root, 'cv'); assert.notEqual(missing.revision, empty.revision);
  let writes = 0;
  saveWorkspaceDocument({ root, request: { document: 'cv', revision: empty.revision, action: 'replace', content: '' }, write: () => writes++ });
  assert.equal(writes, 0);
  assert.throws(() => saveWorkspaceDocument({ root, request: { document: 'cv', revision: missing.revision, action: 'replace', content: 'Hello' }, write: () => writes++ }), (e) => e.status === 409);
});

test('bad UTF-8 and unreadable shapes are errors rather than missing defaults', (t) => {
  const root = fixture(t); put(root, 'cv.md', Buffer.from([0xc3, 0x28]));
  assert.throws(() => readWorkspaceDocument(root, 'cv'), /UTF-8/i);
  const index = listWorkspaceDocuments(root);
  assert.ok(index.documents.find((d) => d.id === 'cv').error);
  fs.mkdirSync(path.join(root, 'article-digest.md'));
  assert.throws(() => readWorkspaceDocument(root, 'achievements'), /regular file/i);
});

test('symlink files and intermediate directories are never read or overwritten', (t) => {
  const root = fixture(t); const other = fixture(t); put(other, 'cv.md', 'Outside');
  fs.symlinkSync(path.join(other, 'cv.md'), path.join(root, 'cv.md'));
  fs.symlinkSync(other, path.join(root, 'modes'), 'dir');
  assert.throws(() => readWorkspaceDocument(root, 'cv'), /symlink/i);
  assert.throws(() => readWorkspaceDocument(root, 'context'), /symlink/i);
  assert.equal(fs.readFileSync(path.join(other, 'cv.md'), 'utf8'), 'Outside');
});

test('oversized content and invalid mutations never invoke writer', (t) => {
  const root = fixture(t); const before = readWorkspaceDocument(root, 'cv'); let writes = 0;
  const write = () => writes++;
  assert.throws(() => saveWorkspaceDocument({ root, request: { document: 'cv', revision: before.revision, action: 'replace', content: 'é'.repeat(MAX_DOCUMENT_BYTES) }, write }), (e) => e.status === 413);
  assert.throws(() => saveWorkspaceDocument({ root, request: { document: 'cv', action: 'replace', content: 'No revision' }, write }), (e) => e.status === 400);
  assert.equal(writes, 0);
});

test('backup/write failure surfaces without pretending success', (t) => {
  const root = fixture(t); put(root, 'cv.md', '# Original\n'); const before = readWorkspaceDocument(root, 'cv');
  assert.throws(() => saveWorkspaceDocument({ root, request: { document: 'cv', revision: before.revision, action: 'replace', content: '# Changed\n' }, write: () => { throw new Error('backup failed: ENOSPC'); } }), /backup failed: ENOSPC/);
  assert.equal(readWorkspaceDocument(root, 'cv').content, before.content);
});

test('unpaired Unicode surrogates cannot be silently replaced during UTF-8 writes', (t) => {
  const root = fixture(t); const before = readWorkspaceDocument(root, 'cv'); let writes = 0;
  assert.throws(() => saveWorkspaceDocument({ root, request: { document: 'cv', revision: before.revision, action: 'replace', content: 'Bad \ud800 text' }, write: () => writes++ }), (e) => e.code === 'invalid_encoding');
  assert.equal(writes, 0);
});

test('opaque workspace identity follows the canonical root across reads, saves and aliases', (t) => {
  const first = fixture(t); const second = fixture(t); const links = fixture(t);
  const alias = path.join(links, 'alias'); fs.symlinkSync(first, alias, 'dir');
  const index = listWorkspaceDocuments(first);
  const doc = readWorkspaceDocument(first, 'cv');
  assert.match(index.workspaceId, /^[a-f0-9]{64}$/);
  assert.equal(doc.workspaceId, index.workspaceId);
  assert.ok(index.documents.every((d) => d.workspaceId === index.workspaceId));
  assert.notEqual(readWorkspaceDocument(second, 'cv').workspaceId, doc.workspaceId);
  assert.equal(readWorkspaceDocument(alias, 'cv').workspaceId, doc.workspaceId);
  assert.equal(listWorkspaceDocuments(alias).workspaceId, index.workspaceId);
  const saved = saveWorkspaceDocument({ root: first, request: { document: 'cv', revision: doc.revision, action: 'replace', content: '# Fictional candidate\n' }, write: atomicWriteWithBackup });
  assert.equal(saved.workspaceId, doc.workspaceId);
  assert.equal(JSON.stringify(index).includes(first), false, 'responses do not expose absolute data root');
  put(first, 'article-digest.md', Buffer.from([0xc3, 0x28]));
  assert.equal(listWorkspaceDocuments(first).documents.find((d) => d.id === 'achievements').workspaceId, doc.workspaceId);
});
