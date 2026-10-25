import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleDocumentRequest } from '../../src/lib/document-route.mjs';
import { createDocumentStore, documentId, MAX_PDF_BYTES } from '../../src/lib/document-store.mjs';

function pdf(text = 'CV') {
  const start = `%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%${text}\n`;
  return Buffer.from(`${start}xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Root 1 0 R /Size 2 >>\nstartxref\n${Buffer.byteLength(start)}\n%%EOF\n`);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'document-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'output'));
  fs.writeFileSync(path.join(root, 'output', 'cv.pdf'), pdf());
  const id = documentId('cv.pdf');
  const store = createDocumentStore(root);
  const call = (method, init = {}, query = '') => handleDocumentRequest(new Request(`http://localhost:3000/api/documents/${id}${query}`, {
    method, ...init, headers: { host: 'localhost:3000', origin: 'http://localhost:3000', ...init.headers },
  }), id, { store });
  return { root, id, store, call };
}

test('GET bytes and ETag describe the same revision; PUT writes and returns history', async (t) => {
  const { call } = fixture(t);
  const loaded = await call('GET', {}, '?format=pdf');
  assert.equal(loaded.status, 200);
  assert.equal(loaded.headers.get('content-type'), 'application/pdf');
  assert.equal(loaded.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await loaded.arrayBuffer()), pdf());
  const saved = await call('PUT', { headers: { 'content-type': 'application/pdf', 'if-match': loaded.headers.get('etag') }, body: pdf('Changed') });
  assert.equal(saved.status, 200);
  const meta = await saved.json();
  assert.equal(meta.filename, 'cv.pdf');
  assert.equal(meta.versions.length, 1);
  assert.notEqual(saved.headers.get('etag'), loaded.headers.get('etag'));
});

test('cross-origin writes and malformed requests are refused without changing PDF', async (t) => {
  const { store, call, root } = fixture(t);
  const rev = store.metadata(documentId('cv.pdf')).revision;
  assert.equal((await call('PUT', { headers: { origin: 'https://evil.example', 'content-type': 'application/pdf', 'if-match': rev }, body: pdf('Bad') })).status, 403);
  assert.equal((await call('DELETE', { headers: { 'sec-fetch-site': 'cross-site', 'if-match': rev } })).status, 403);
  assert.equal((await call('PUT', { headers: { 'content-type': 'text/plain', 'if-match': rev }, body: pdf('Bad') })).status, 415);
  assert.equal((await call('PUT', { headers: { 'content-type': 'application/pdf', 'content-length': String(MAX_PDF_BYTES + 1), 'if-match': rev }, body: pdf('Bad') })).status, 413);
  assert.equal((await call('PUT', { headers: { 'content-type': 'application/pdf' }, body: pdf('Bad') })).status, 428);
  assert.equal((await call('POST', { headers: { 'content-type': 'application/json' }, body: '{bad' })).status, 400);
  assert.deepEqual(fs.readFileSync(path.join(root, 'output', 'cv.pdf')), pdf());
});

test('DELETE then POST restore recovers document; stale delete conflicts', async (t) => {
  const { store, id, call } = fixture(t);
  assert.equal((await call('DELETE', { headers: { 'if-match': '0'.repeat(64) } })).status, 409);
  const deleted = await call('DELETE', { headers: { 'if-match': store.metadata(id).revision } });
  assert.equal(deleted.status, 200);
  const { restoreToken } = await deleted.json();
  assert.equal((await call('GET')).status, 404);
  const restored = await call('POST', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'restore', restoreToken }) });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).filename, 'cv.pdf');
});
