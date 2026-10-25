import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listWorkspaceDocuments, readWorkspaceDocument, saveWorkspaceDocument } from '../../src/lib/career-workspace-store.mjs';
import { validateSourceManifest } from '../../src/lib/source-workspace-store.mjs';
import { validateContextManifest } from '../../../lib/context-library.mjs';
import '../helpers/web-ts-alias-loader.mjs';
const { atomicWriteWithBackup } = await import('../../src/lib/core/safe-write.ts');

const ROOT = 'a'.repeat(32), FIRST = 'b'.repeat(32), SECOND = 'c'.repeat(32), CHILD = 'd'.repeat(32);
const id = (value) => `source-${value}`;
const rel = (value) => `data/context-workspace/pages/${value}.md`;
const manifestRel = 'data/context-workspace/index.json';
function manifest() { return { version: 1, rootId: ROOT, pages: [
  { id: ROOT, title: 'Source workspace', parentId: null, order: 0, sourceUrl: 'https://example.com/source-root', sourceEditedAt: '2026-10-20T10:00:00.000Z' },
  { id: FIRST, title: 'Career history', parentId: ROOT, order: 0 },
  { id: SECOND, title: 'Generation guide', parentId: ROOT, order: 1 },
  { id: CHILD, title: 'Fictional employer', parentId: FIRST, order: 0 },
] }; }
function put(root, file, text) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
function fixture(t, data = manifest()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  put(root, manifestRel, JSON.stringify(data, null, 2) + '\n');
  for (const page of data.pages) put(root, rel(page.id), `## Body heading for ${page.title}\n\nPreserve original wording.\n`);
  return root;
}
function readManifest(root) { return JSON.parse(fs.readFileSync(path.join(root, manifestRel), 'utf8')); }
function save(root, document, action, extra = {}, write = atomicWriteWithBackup) {
  return saveWorkspaceDocument({ root, request: { document, revision: readWorkspaceDocument(root, document).revision, action, section: null, ...extra }, write });
}

test('index presents actual source-page hierarchy separately from body headings and local app files', (t) => {
  const root = fixture(t); const index = listWorkspaceDocuments(root);
  assert.equal(index.sourceRootDocumentId, id(ROOT));
  assert.equal(index.sourceError, null);
  const sources = index.documents.filter((d) => d.kind === 'source');
  assert.deepEqual(sources.map((d) => d.id), [id(ROOT), id(FIRST), id(CHILD), id(SECOND)]);
  assert.equal(sources.find((d) => d.id === id(CHILD)).parentDocumentId, id(FIRST));
  assert.ok(sources.every((d) => d.sections.length === 0));
  assert.equal(index.documents.filter((d) => d.kind === 'local').length, 6);
  const doc = readWorkspaceDocument(root, id(ROOT));
  assert.equal(doc.sourceUrl, 'https://example.com/source-root');
  assert.equal(doc.sourceEditedAt, '2026-10-20T10:00:00.000Z');
  assert.equal(doc.content, fs.readFileSync(path.join(root, rel(ROOT)), 'utf8'));
  assert.deepEqual(doc.sections, []);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data/context-workspace')).sort(), ['index.json', 'pages']);
});

test('source body saves preserve manifest and app files, create backups, and reject stale bodies', (t) => {
  const root = fixture(t); put(root, 'modes/_context.md', '# Local facts\n'); put(root, 'cv.md', '# Local CV\n');
  const before = readWorkspaceDocument(root, id(CHILD));
  const manifestBefore = fs.readFileSync(path.join(root, manifestRel), 'utf8');
  const content = '## Changed body\n\n[Original source](https://example.com/evidence)\n';
  const after = saveWorkspaceDocument({ root, request: { document: id(CHILD), revision: before.revision, action: 'replace', section: null, content }, write: atomicWriteWithBackup });
  assert.equal(after.content, content);
  assert.equal(after.selectedDocument, id(CHILD));
  assert.equal(after.selectedSection, null);
  assert.equal(fs.readFileSync(path.join(root, manifestRel), 'utf8'), manifestBefore);
  assert.equal(fs.readFileSync(path.join(root, 'modes/_context.md'), 'utf8'), '# Local facts\n');
  assert.equal(fs.readFileSync(path.join(root, 'cv.md'), 'utf8'), '# Local CV\n');
  assert.ok(fs.readdirSync(path.join(root, 'data/context-workspace/pages')).some((p) => p.startsWith(`${CHILD}.md.bak-`)));
  assert.throws(() => saveWorkspaceDocument({ root, request: { document: id(CHILD), revision: before.revision, action: 'replace', content: 'Stale' }, write: atomicWriteWithBackup }), (e) => e.code === 'stale');
});

test('page metadata changes affect every source revision and do not rewrite bodies or provenance', (t) => {
  const root = fixture(t); const staleSibling = readWorkspaceDocument(root, id(SECOND));
  const before = readWorkspaceDocument(root, id(ROOT));
  const renamed = save(root, id(ROOT), 'rename', { title: 'Renamed source workspace' });
  assert.equal(renamed.title, 'Renamed source workspace');
  assert.equal(renamed.content, before.content);
  assert.equal(renamed.sourceUrl, before.sourceUrl);
  assert.equal(renamed.sourceEditedAt, before.sourceEditedAt);
  assert.notEqual(readWorkspaceDocument(root, id(SECOND)).revision, staleSibling.revision);
  assert.throws(() => saveWorkspaceDocument({ root, request: { document: id(SECOND), revision: staleSibling.revision, action: 'replace', content: 'Old hierarchy' }, write: atomicWriteWithBackup }), (e) => e.code === 'stale');
  assert.ok(fs.readdirSync(path.join(root, 'data/context-workspace')).some((p) => p.startsWith('index.json.bak-')));
});

test('add creates a real empty child page and returns its selected document', (t) => {
  const root = fixture(t); const parentBefore = readWorkspaceDocument(root, id(FIRST));
  const added = save(root, id(FIRST), 'add', { title: 'Another employer' });
  assert.match(added.id, /^source-[a-f0-9]{32}$/);
  assert.equal(added.selectedDocument, added.id);
  assert.equal(added.parentDocumentId, id(FIRST));
  assert.equal(added.title, 'Another employer');
  assert.equal(added.content, '');
  assert.equal(added.order, 1);
  assert.equal(added.sourceUrl, null);
  assert.equal(readWorkspaceDocument(root, id(FIRST)).content, parentBefore.content);
  assert.equal(readManifest(root).pages.length, 5);
  assert.equal(fs.readFileSync(path.join(root, rel(added.id.slice(7))), 'utf8'), '');
});

test('move changes actual sibling order without moving descendants or editing text', (t) => {
  const root = fixture(t); const before = readWorkspaceDocument(root, id(FIRST));
  const moved = save(root, id(FIRST), 'move', { direction: 'down' });
  assert.equal(moved.content, before.content);
  assert.equal(moved.order, 1);
  assert.equal(readWorkspaceDocument(root, id(SECOND)).order, 0);
  assert.equal(readWorkspaceDocument(root, id(CHILD)).parentDocumentId, id(FIRST));
  assert.deepEqual(listWorkspaceDocuments(root).documents.filter((d) => d.kind === 'source').map((d) => d.id), [id(ROOT), id(SECOND), id(FIRST), id(CHILD)]);
  assert.throws(() => save(root, id(ROOT), 'move', { direction: 'up' }), (e) => e.code === 'no_sibling');
  assert.throws(() => save(root, id(FIRST), 'move', { direction: 'down' }), (e) => e.code === 'no_sibling');
});

test('unchanged body and title are no-op saves and source pages reject section mutations', (t) => {
  const root = fixture(t); const before = readWorkspaceDocument(root, id(FIRST)); let writes = 0;
  const write = () => writes++;
  assert.equal(save(root, id(FIRST), 'replace', { content: before.content }, write).revision, before.revision);
  assert.equal(save(root, id(FIRST), 'rename', { title: before.title }, write).revision, before.revision);
  assert.equal(writes, 0);
  assert.throws(() => save(root, id(FIRST), 'replace', { section: '/invented:1', content: 'Oops' }), (e) => e.code === 'invalid_section');
});

test('malformed manifests, cycles, orphans, duplicate order and unsafe fields are visible errors', (t) => {
  const corruptions = [
    (m) => { m.version = 2; },
    (m) => { m.rootId = SECOND; },
    (m) => { m.pages[1].parentId = CHILD; },
    (m) => { m.pages[3].parentId = 'e'.repeat(32); },
    (m) => { m.pages[2].order = 0; },
    (m) => { m.pages[1].id = '../escape'; },
    (m) => { m.pages[0].sourceUrl = 'javascript:alert(1)'; },
    (m) => { m.pages[0].sourceEditedAt = 'not a date'; },
  ];
  for (const corrupt of corruptions) {
    const root = fixture(t); const m = manifest(); corrupt(m); put(root, manifestRel, JSON.stringify(m));
    const index = listWorkspaceDocuments(root);
    assert.ok(index.sourceError, JSON.stringify(m));
    assert.equal(index.sourceRootDocumentId, null);
    assert.equal(index.documents.filter((d) => d.kind === 'local').length, 6);
    assert.throws(() => readWorkspaceDocument(root, id(ROOT)), (e) => e.code === 'invalid_manifest');
  }
});

test('missing/corrupt page bodies surface errors and are never seeded or overwritten', (t) => {
  const root = fixture(t); fs.unlinkSync(path.join(root, rel(CHILD)));
  const index = listWorkspaceDocuments(root);
  assert.ok(index.sourceError);
  assert.ok(index.documents.find((d) => d.id === id(CHILD)).error);
  assert.throws(() => readWorkspaceDocument(root, id(CHILD)), (e) => e.code === 'missing_source_page');
  put(root, rel(CHILD), Buffer.from([0xc3, 0x28]));
  assert.throws(() => readWorkspaceDocument(root, id(CHILD)), (e) => e.code === 'invalid_encoding');
});

test('source library rejects symlink directories, linked manifests/pages and oversized bodies', (t) => {
  const root = fixture(t); const outside = fixture(t);
  fs.unlinkSync(path.join(root, rel(CHILD))); fs.symlinkSync(path.join(outside, rel(CHILD)), path.join(root, rel(CHILD)));
  assert.throws(() => readWorkspaceDocument(root, id(CHILD)), (e) => e.code === 'unsafe_path');
  fs.unlinkSync(path.join(root, manifestRel)); fs.symlinkSync(path.join(outside, manifestRel), path.join(root, manifestRel));
  assert.ok(listWorkspaceDocuments(root).sourceError);
  const tooLarge = fixture(t); put(tooLarge, rel(CHILD), 'x'.repeat(200001));
  assert.throws(() => readWorkspaceDocument(tooLarge, id(CHILD)), (e) => e.code === 'too_large');
});

test('failed child manifest save leaves no referenced missing page or abandoned empty child', (t) => {
  const root = fixture(t); const before = fs.readFileSync(path.join(root, manifestRel), 'utf8');
  const initialPages = fs.readdirSync(path.join(root, 'data/context-workspace/pages')).sort();
  const write = (file, content) => { if (file.endsWith('index.json')) throw new Error('manifest backup failed: ENOSPC'); return atomicWriteWithBackup(file, content); };
  assert.throws(() => save(root, id(FIRST), 'add', { title: 'Failed child' }, write), /manifest backup failed: ENOSPC/);
  assert.equal(fs.readFileSync(path.join(root, manifestRel), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data/context-workspace/pages')).sort(), initialPages);
});

test('manifest identifiers are strings and provenance dates are real calendar dates', (t) => {
  for (const corrupt of [
    (m) => { m.rootId = [ROOT]; },
    (m) => { m.pages[0].id = [ROOT]; },
    (m) => { m.pages[1].parentId = [ROOT]; },
    (m) => { m.pages[0].sourceEditedAt = '2026-02-30'; },
    (m) => { m.pages[0].sourceEditedAt = '2026-02-30T10:00:00Z'; },
  ]) {
    const root = fixture(t); const m = manifest(); corrupt(m); put(root, manifestRel, JSON.stringify(m));
    assert.throws(() => readWorkspaceDocument(root, id(ROOT)), (e) => e.code === 'invalid_manifest');
  }
});

test('manifest parse, encoding and size failures remain visible without dropping local documents', (t) => {
  for (const [bytes, code] of [['{broken', 'invalid_manifest'], [Buffer.from([0xc3, 0x28]), 'invalid_encoding'], [' '.repeat(1_000_001), 'too_large']]) {
    const root = fixture(t); put(root, manifestRel, bytes);
    const index = listWorkspaceDocuments(root);
    assert.equal(index.sourceError.code, code);
    assert.equal(index.documents.filter((d) => d.kind === 'local').length, 6);
  }
  const root = fixture(t); const outside = fixture(t);
  fs.rmSync(path.join(root, 'data/context-workspace/pages'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'data/context-workspace/pages'), path.join(root, 'data/context-workspace/pages'));
  assert.throws(() => readWorkspaceDocument(root, id(ROOT)), (e) => e.code === 'unsafe_path');
  fs.rmSync(path.join(root, 'data'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'data'), path.join(root, 'data'));
  assert.equal(listWorkspaceDocuments(root).sourceError.code, 'unsafe_path');
});

test('invalid source mutations and exceeded page limits never invoke the writer', (t) => {
  const root = fixture(t); let writes = 0; const write = () => writes++;
  for (const [action, extra, code] of [
    ['replace', { content: '\ud800' }, 'invalid_encoding'],
    ['replace', { content: 'a'.repeat(200001) }, 'too_large'],
    ['replace', { content: 42 }, 'invalid_content'],
    ['rename', { title: 'Bad\nname' }, 'invalid_title'],
    ['add', { title: '' }, 'invalid_title'],
    ['move', { direction: 'left' }, 'invalid_direction'],
    ['remove', {}, 'invalid_action'],
  ]) assert.throws(() => save(root, id(ROOT), action, extra, write), (e) => e.code === code);
  const m = manifest(); m.pages[3].order = Number.MAX_SAFE_INTEGER; put(root, manifestRel, JSON.stringify(m));
  assert.throws(() => save(root, id(FIRST), 'add', { title: 'No valid order' }, write), (e) => e.code === 'invalid_manifest');
  m.pages = [m.pages[0], ...Array.from({ length: 4999 }, (_, index) => ({ id: index.toString(16).padStart(32, '0'), title: 'Fictional page', parentId: ROOT, order: index }))];
  put(root, manifestRel, JSON.stringify(m));
  assert.throws(() => save(root, id(ROOT), 'add', { title: 'No space in library' }, write), (e) => e.code === 'invalid_manifest');
  assert.equal(writes, 0);
});

test('source conversion notes remain visible and survive metadata edits', (t) => {
  const m = manifest(); m.pages[1].importNotes = ['Columns were flattened.', 'Toggle content was expanded.'];
  const root = fixture(t, m);
  assert.deepEqual(readWorkspaceDocument(root, id(FIRST)).importNotes, m.pages[1].importNotes);
  assert.deepEqual(listWorkspaceDocuments(root).documents.find((d) => d.id === id(FIRST)).importNotes, m.pages[1].importNotes);
  assert.deepEqual(save(root, id(FIRST), 'rename', { title: 'Updated title' }).importNotes, m.pages[1].importNotes);
  assert.deepEqual(readWorkspaceDocument(root, id(ROOT)).importNotes, []);
  for (const notes of ['Not an array', [42], ['x'.repeat(501)], Array(51).fill('Note'), ['Bad\nline']]) {
    m.pages[1].importNotes = notes; put(root, manifestRel, JSON.stringify(m));
    assert.throws(() => readWorkspaceDocument(root, id(ROOT)), (e) => e.code === 'invalid_manifest');
  }
});

test('page purpose inherits through the tree and changes with revision protection', (t) => {
  const m = manifest(); m.pages[0].usage = 'reference'; m.pages[1].usage = 'facts';
  const root = fixture(t, m);
  assert.equal(readWorkspaceDocument(root, id(ROOT)).usage, 'reference');
  assert.equal(readWorkspaceDocument(root, id(CHILD)).usage, 'facts');
  const before = readWorkspaceDocument(root, id(CHILD));
  const changed = save(root, id(FIRST), 'usage', { usage: 'preferences' });
  assert.equal(changed.usage, 'preferences');
  assert.equal(readWorkspaceDocument(root, id(CHILD)).usage, 'preferences');
  assert.equal(readWorkspaceDocument(root, id(CHILD)).content, before.content);
  assert.throws(() => saveWorkspaceDocument({ root, request: { document: id(CHILD), revision: before.revision, action: 'usage', usage: 'facts' }, write: atomicWriteWithBackup }), (e) => e.code === 'stale');
  save(root, id(CHILD), 'usage', { usage: 'unconfirmed' });
  save(root, id(FIRST), 'usage', { usage: 'facts' });
  assert.equal(readWorkspaceDocument(root, id(CHILD)).usage, 'unconfirmed');
  assert.equal(save(root, id(FIRST), 'add', { title: 'New career record' }).usage, 'facts');
  assert.ok(fs.readdirSync(path.join(root, 'data/context-workspace')).some((p) => p.startsWith('index.json.bak-')));
});

test('unknown page purposes are rejected without writing and ordinary pages default to facts', (t) => {
  const root = fixture(t); let writes = 0;
  assert.equal(readWorkspaceDocument(root, id(ROOT)).usage, 'facts');
  for (const usage of ['instructions', '', null, 42]) {
    assert.throws(() => save(root, id(FIRST), 'usage', { usage }, () => writes++), (e) => e.code === 'invalid_usage');
    const m = manifest(); m.pages[1].usage = usage; put(root, manifestRel, JSON.stringify(m));
    assert.throws(() => readWorkspaceDocument(root, id(ROOT)), (e) => e.code === 'invalid_manifest');
    put(root, manifestRel, JSON.stringify(manifest()));
  }
  assert.equal(writes, 0);
});

test('workspace manifest validation agrees with the core context reader', () => {
  const variants = [manifest()];
  for (const usage of ['facts', 'preferences', 'reference', 'unconfirmed', 'invalid', null, 42]) {
    const m = manifest(); m.pages[1].usage = usage; variants.push(m);
  }
  for (const corrupt of [
    (m) => { m.pages[2].order = 0; },
    (m) => { m.pages[1].parentId = CHILD; },
    (m) => { m.pages[0].sourceEditedAt = '2026-02-30'; },
    (m) => { m.pages[0].sourceUrl = 'javascript:alert(1)'; },
    (m) => { m.pages[0].importNotes = ['Bad\nline']; },
  ]) { const m = manifest(); corrupt(m); variants.push(m); }
  for (const depth of [64, 65]) {
    const pages = Array.from({ length: depth + 1 }, (_, index) => ({ id: index.toString(16).padStart(32, '0'), title: 'Page', parentId: index ? (index - 1).toString(16).padStart(32, '0') : null, order: 0 }));
    variants.push({ version: 1, rootId: pages[0].id, pages });
  }
  const accepts = (validate, input) => { try { validate(input); return true; } catch { return false; } };
  for (const value of variants) assert.equal(accepts(validateSourceManifest, value), accepts(validateContextManifest, value), JSON.stringify(value));
});
