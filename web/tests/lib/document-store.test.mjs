import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDocumentStore, readDocument, documentId, listDocumentTrash, MAX_PDF_BYTES } from '../../src/lib/document-store.mjs';

const historyKey = (id) => createHash('sha256').update(id).digest('hex');

function pdf(text = 'Original CV') {
  let body = `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n% ${text}\n`;
  const offset = Buffer.byteLength(body);
  return Buffer.from(`${body}xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`);
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'document-store-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'output'));
  const filename = 'cv-résumé.pdf';
  const file = path.join(root, 'output', filename);
  fs.writeFileSync(file, pdf());
  const id = documentId(filename);
  return { root, file, id, store: createDocumentStore(root) };
}

test('save preserves exact previous bytes and restores a selected version', async (t) => {
  const { store, root, id, file } = fixture(t);
  const original = readDocument(root, id);
  const saved = await store.save(id, pdf('Changed CV'), original.revision);
  assert.notEqual(saved.revision, original.revision);
  assert.equal(saved.versions.length, 1);
  assert.deepEqual(fs.readFileSync(file), pdf('Changed CV'));
  const restored = await store.restoreVersion(id, saved.versions[0].id, saved.revision);
  assert.equal(restored.revision, original.revision);
  assert.equal(restored.versions.length, 2);
  assert.deepEqual(fs.readFileSync(file), original.bytes);
});

test('stale and simultaneous saves cannot overwrite newer PDF bytes', async (t) => {
  const { store, id, file } = fixture(t);
  const { revision } = store.metadata(id);
  const results = await Promise.allSettled([store.save(id, pdf('A'), revision), store.save(id, pdf('B'), revision)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
  assert.equal(store.metadata(id).versions.length, 1);
  assert.ok([pdf('A').toString(), pdf('B').toString()].includes(fs.readFileSync(file, 'utf8')));
});

test('delete and restore keep filename association and refuse overwriting a replacement', async (t) => {
  const { store, id, file } = fixture(t);
  const before = store.metadata(id);
  const removed = await store.remove(id, before.revision);
  assert.equal(fs.existsSync(file), false);
  assert.throws(() => store.metadata(id), { status: 404 });
  fs.writeFileSync(file, pdf('Newly generated'));
  await assert.rejects(store.restore(id, removed.restoreToken), { status: 409 });
  assert.deepEqual(fs.readFileSync(file), pdf('Newly generated'));
  fs.unlinkSync(file);
  assert.equal((await store.restore(id, removed.restoreToken)).revision, before.revision);
  await assert.rejects(store.restore(id, removed.restoreToken), { status: 404 });
});

test('invalid PDF, oversized PDF, missing revision and no-op save never change original', async (t) => {
  const { store, id, file } = fixture(t);
  const before = store.metadata(id);
  await assert.rejects(store.save(id, Buffer.from('%PDF-1.7\ninvalid\n%%EOF'), before.revision), { status: 422 });
  await assert.rejects(store.save(id, Buffer.alloc(MAX_PDF_BYTES + 1), before.revision), { status: 413 });
  await assert.rejects(store.save(id, pdf('Changed'), ''), { status: 428 });
  const noOp = await store.save(id, pdf(), before.revision);
  assert.equal(noOp.versions.length, 0);
  assert.deepEqual(fs.readFileSync(file), pdf());
});

test('identifier traversal, noncanonical encodings, file and directory symlinks are rejected', async (t) => {
  const { store, root, id, file } = fixture(t);
  for (const name of ['../outside.pdf', 'nested/cv.pdf', 'cv.txt', '..\\outside.pdf', 'cv.pdf\0']) {
    assert.throws(() => store.metadata(Buffer.from(name).toString('base64url')), { status: 400 });
  }
  assert.throws(() => store.metadata(id + '='), { status: 400 });
  const outside = path.join(root, 'outside.pdf');
  fs.writeFileSync(outside, pdf('Outside'));
  fs.unlinkSync(file);
  fs.symlinkSync(outside, file);
  assert.throws(() => store.metadata(id), { status: 404 });
  fs.unlinkSync(file);
  fs.writeFileSync(file, pdf());
  const revision = store.metadata(id).revision;
  fs.symlinkSync(path.join(root, 'output'), path.join(root, '.career-ops-web'));
  await assert.rejects(store.save(id, pdf('Changed'), revision), { status: 409 });
  assert.deepEqual(fs.readFileSync(outside), pdf('Outside'));
});

test('history corruption and forged version tokens fail closed', async (t) => {
  const { store, root, id } = fixture(t);
  const before = store.metadata(id);
  await assert.rejects(store.restoreVersion(id, '../cv.pdf', before.revision), { status: 400 });
  await assert.rejects(store.restore(id, '../cv.pdf'), { status: 400 });
  const history = path.join(root, '.career-ops-web', 'document-history', historyKey(id));
  fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(path.join(history, 'versions'), 'not a directory');
  assert.throws(() => store.metadata(id), { status: 409 });
});

test('save failure preserves original and recoverable version; temporary files are removed', async (t) => {
  const { store, id, file } = fixture(t);
  const before = store.metadata(id);
  const originalRename = fs.renameSync;
  fs.renameSync = (source, dest) => {
    if (dest === file) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
    return originalRename(source, dest);
  };
  try {
    await assert.rejects(store.save(id, pdf('Changed'), before.revision), /ENOSPC/);
  } finally { fs.renameSync = originalRename; }
  assert.deepEqual(fs.readFileSync(file), pdf());
  assert.equal(store.metadata(id).versions.length, 1);
  assert.equal(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('trash remains discoverable after creating another store and rejects symlinked entries', async (t) => {
  const { store, root, id } = fixture(t);
  assert.deepEqual(listDocumentTrash(root), []);
  const removed = await store.remove(id, store.metadata(id).revision);
  const trash = createDocumentStore(root).trash();
  assert.equal(trash.length, 1);
  assert.equal(trash[0].id, id);
  assert.equal(trash[0].filename, 'cv-résumé.pdf');
  assert.equal(trash[0].restoreToken, removed.restoreToken);
  assert.ok(Number.isFinite(Date.parse(trash[0].deletedAt)));
  const saved = path.join(root, '.career-ops-web', 'document-history', historyKey(id), 'trash', `${removed.restoreToken}.pdf`);
  fs.unlinkSync(saved);
  fs.symlinkSync(path.join(root, 'outside.pdf'), saved);
  assert.throws(() => listDocumentTrash(root), { status: 409 });
});

test('output directory symlink and corrupt history prevent changes', async (t) => {
  const { store, root, id, file } = fixture(t);
  const revision = store.metadata(id).revision;
  const history = path.join(root, '.career-ops-web', 'document-history', historyKey(id), 'versions');
  fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(path.join(history, 'corrupt.json'), '{}');
  await assert.rejects(store.save(id, pdf('Changed'), revision), { status: 409 });
  assert.deepEqual(fs.readFileSync(file), pdf());
  const output = path.join(root, 'output');
  fs.renameSync(output, path.join(root, 'outside'));
  fs.symlinkSync(path.join(root, 'outside'), output);
  assert.throws(() => readDocument(root, id), { status: 409 });
});

test('long valid PDF filenames can be saved and recovered', async (t) => {
  const { root } = fixture(t);
  const filename = `${'a'.repeat(220)}.pdf`;
  fs.writeFileSync(path.join(root, 'output', filename), pdf());
  const id = documentId(filename);
  const store = createDocumentStore(root);
  const saved = await store.save(id, pdf('Long filename edit'), store.metadata(id).revision);
  const removed = await store.remove(id, saved.revision);
  assert.equal(store.trash().find((item) => item.id === id)?.filename, filename);
  assert.equal((await store.restore(id, removed.restoreToken)).filename, filename);
});

export { pdf };
