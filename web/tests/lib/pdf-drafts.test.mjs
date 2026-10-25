import test from 'node:test';
import assert from 'node:assert/strict';
import { createPdfDraftStore, readPdfDraft, writePdfDraft, clearPdfDraft } from '../../src/lib/pdf-drafts.mjs';

function draft(text = 'Unsaved wording', bytes = new Uint8Array([37, 80, 68, 70]).buffer) {
  return {
    revision: 'a'.repeat(64), bytes, pdfDirty: true,
    selection: { paragraphId: '0:2', text: 'Saved wording', pageIndex: 0 }, draft: text,
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function adapter() {
  const records = new Map();
  return { records, read: async (id) => records.get(id) ?? null, write: async (id, value) => { records.set(id, value); }, remove: async (id) => { records.delete(id); } };
}

test('writing exposes memory immediately while persistence is still pending, without copying PDF bytes', async () => {
  const gate = deferred();
  const disk = adapter();
  disk.write = async () => gate.promise;
  const store = createPdfDraftStore(disk);
  const original = draft();
  const pending = store.write('doc-a', original);
  const recovered = await store.read('doc-a');
  assert.equal(recovered.draft, original.draft);
  assert.equal(recovered.bytes, original.bytes);
  original.selection.text = 'Later caller mutation';
  assert.equal((await store.read('doc-a')).selection.text, 'Saved wording');
  gate.resolve();
  assert.equal((await pending).persistent, true);
});

test('fresh store reads persistent records and keeps document identities isolated', async () => {
  const disk = adapter();
  const store = createPdfDraftStore(disk);
  await store.write('doc-a', draft('A'));
  await store.write('doc-b', draft('B'));
  const reopened = createPdfDraftStore(disk);
  assert.equal((await reopened.read('doc-a')).draft, 'A');
  assert.equal((await reopened.read('doc-b')).draft, 'B');
  assert.equal(await reopened.read('missing'), null);
});

test('slow stale disk read cannot overwrite a newer write or resurrect a clear', async () => {
  for (const operation of ['write', 'clear']) {
    const gate = deferred();
    const disk = adapter();
    disk.read = () => gate.promise;
    const store = createPdfDraftStore(disk);
    const loading = store.read('doc');
    const pending = operation === 'write' ? store.write('doc', draft('New')) : store.clear('doc');
    gate.resolve(draft('Stale'));
    const recovered = await loading;
    assert.equal(recovered?.draft ?? null, operation === 'write' ? 'New' : null);
    await pending;
    assert.equal((await store.read('doc'))?.draft ?? null, operation === 'write' ? 'New' : null);
  }
});

test('writes serialize per document and clear cancels queued older persistence', async () => {
  const gate = deferred();
  const started = deferred();
  const disk = adapter();
  const operations = [];
  disk.write = async (id, value) => {
    operations.push(value.draft);
    if (value.draft === 'First') { started.resolve(); await gate.promise; }
    disk.records.set(id, value);
  };
  disk.remove = async (id) => { operations.push('Clear'); disk.records.delete(id); };
  const store = createPdfDraftStore(disk);
  const first = store.write('doc', draft('First'));
  await started.promise;
  const second = store.write('doc', draft('Second'));
  const cleared = store.clear('doc');
  assert.equal(await store.read('doc'), null);
  gate.resolve();
  await Promise.all([first, second, cleared]);
  assert.deepEqual(operations, ['First', 'Clear']);
  assert.equal(disk.records.has('doc'), false);
});

test('late earlier write never replaces latest draft and independent document writes do not wait', async () => {
  const gate = deferred();
  const started = deferred();
  const disk = adapter();
  const write = disk.write;
  disk.write = async (id, value) => {
    if (id === 'a' && value.draft === 'First') { started.resolve(); await gate.promise; }
    await write(id, value);
  };
  const store = createPdfDraftStore(disk);
  const first = store.write('a', draft('First'));
  await started.promise;
  const latest = store.write('a', draft('Latest'));
  await store.write('b', draft('Other'));
  assert.equal(disk.records.get('b').draft, 'Other');
  gate.resolve();
  await Promise.all([first, latest]);
  assert.equal(disk.records.get('a').draft, 'Latest');
});

test('storage errors report memory-only recovery and do not poison later writes or clear', async () => {
  const disk = adapter();
  disk.write = async () => { throw new Error('QuotaExceededError'); };
  disk.remove = async () => { throw new Error('SecurityError'); };
  const store = createPdfDraftStore(disk);
  assert.equal((await store.write('doc', draft())).persistent, false);
  assert.equal((await store.read('doc')).draft, 'Unsaved wording');
  assert.equal((await store.clear('doc')).persistent, false);
  assert.equal(await store.read('doc'), null);
  disk.write = async (id, value) => disk.records.set(id, value);
  assert.equal((await store.write('doc', draft('Retry'))).persistent, true);
  assert.equal(disk.records.get('doc').draft, 'Retry');
});

test('malformed and oversized drafts are refused; corrupt persistent draft is not restored', async () => {
  const disk = adapter();
  const store = createPdfDraftStore(disk);
  for (const invalid of [null, { ...draft(), revision: 'invalid' }, { ...draft(), bytes: 'not bytes' }, { ...draft(), selection: { paragraphId: '0:0', text: '', pageIndex: -1 } }, { ...draft(), bytes: new ArrayBuffer(20 * 1024 * 1024 + 1) }]) {
    assert.throws(() => store.write('doc', invalid), /Invalid PDF draft/);
  }
  disk.records.set('bad', { revision: 'invalid' });
  assert.equal(await store.read('bad'), null);
});

test('a new draft written after clear survives a pending earlier write', async () => {
  const gate = deferred();
  const started = deferred();
  const disk = adapter();
  disk.write = async (id, value) => {
    if (value.draft === 'Before') { started.resolve(); await gate.promise; }
    disk.records.set(id, value);
  };
  const store = createPdfDraftStore(disk);
  const before = store.write('doc', draft('Before'));
  await started.promise;
  const clearing = store.clear('doc');
  const after = store.write('doc', draft('After'));
  gate.resolve();
  await Promise.all([before, clearing, after]);
  assert.equal((await store.read('doc')).draft, 'After');
  assert.equal(disk.records.get('doc').draft, 'After');
});

test('default browser adapter falls back to memory when IndexedDB is unavailable', async () => {
  assert.equal(globalThis.indexedDB, undefined);
  assert.equal((await writePdfDraft('node-only-fallback', draft('Recovered'))).persistent, false);
  assert.equal((await readPdfDraft('node-only-fallback')).draft, 'Recovered');
  assert.equal((await clearPdfDraft('node-only-fallback')).persistent, false);
  assert.equal(await readPdfDraft('node-only-fallback'), null);
});

test('inline recovery preserves styles without sharing mutable run objects', async () => {
  const disk = adapter();
  const store = createPdfDraftStore(disk);
  const value = {...draft('Styled text'),inlineState:{runs:[{text:'Styled ',italic:true,size:10.5},{text:'text',bold:true,size:10.5}],format:{align:0,lineSpacing:1.55}}};
  await store.write('inline',value);
  value.inlineState.runs[0].italic=false;
  const restored=await createPdfDraftStore(disk).read('inline');
  assert.equal(restored.inlineState.runs[0].italic,true);
  assert.equal(restored.inlineState.runs[1].bold,true);
  assert.equal(restored.inlineState.format.lineSpacing,1.55);
  restored.inlineState.runs[0].text='Caller mutation';
  assert.equal((await store.read('inline')).inlineState.runs[0].text,'Styled ');
});

test('invalid or excessively large inline style state is rejected', () => {
  const store=createPdfDraftStore(adapter());
  for(const inlineState of [{runs:'bad'},{runs:[{text:42}]},{runs:[{text:'a'.repeat(12001)}]},{runs:[{text:'text',family:'a'.repeat(140000)}]}]) {
    assert.throws(()=>store.write('inline',{...draft(),inlineState}),/Invalid PDF/);
  }
});
