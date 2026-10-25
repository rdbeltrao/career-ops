/**
 * Local recovery for unsaved visual PDF edits. PDF byte buffers are immutable
 * snapshots owned by the caller; metadata is copied without cloning up to
 * 20 MiB every time a user types another character in the paragraph field.
 *
 * @typedef {{revision:string, bytes:ArrayBuffer, pdfDirty:boolean,
 * selection:{paragraphId:string,text:string,pageIndex:number}|null, draft:string}} PdfDraft
 * @typedef {{persistent:boolean, superseded?:boolean}} PersistenceResult
 */

const MAX_BYTES = 20 * 1024 * 1024;

function assertId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,700}$/.test(id)) throw new Error('Invalid PDF draft identifier.');
}

/** @param {unknown} value @returns {PdfDraft} */
function copyDraft(value) {
  const record = /** @type {PdfDraft} */ (value);
  const selection = record?.selection;
  if (!record || !/^[a-f0-9]{64}$/.test(record.revision) || !(record.bytes instanceof ArrayBuffer) ||
      record.bytes.byteLength === 0 || record.bytes.byteLength > MAX_BYTES || typeof record.pdfDirty !== 'boolean' ||
      typeof record.draft !== 'string' || record.draft.length > 12000 ||
      (selection !== null && (!selection || typeof selection.paragraphId !== 'string' || !/^\d+:\d+$/.test(selection.paragraphId) ||
        typeof selection.text !== 'string' || selection.text.length > 12000 || !Number.isInteger(selection.pageIndex) || selection.pageIndex < 0))) {
    throw new Error('Invalid PDF draft.');
  }
  return { revision: record.revision, bytes: record.bytes, pdfDirty: record.pdfDirty,
    selection: selection ? { ...selection } : null, draft: record.draft };
}

/**
 * @param {{read:(id:string)=>Promise<unknown>,write:(id:string,record:PdfDraft)=>Promise<unknown>,remove:(id:string)=>Promise<unknown>}} storage
 */
export function createPdfDraftStore(storage) {
  /** @type {Map<string,PdfDraft|null>} */
  const memory = new Map();
  const generations = new Map();
  /** @type {Map<string,Promise<PersistenceResult>>} */
  const queues = new Map();
  const current = (id) => { const value = memory.get(id); return value ? copyDraft(value) : null; };
  const advance = (id) => {
    const next = (generations.get(id) ?? 0) + 1;
    generations.set(id, next);
    return next;
  };

  function persist(id, generation, operation) {
    const previous = queues.get(id) ?? Promise.resolve();
    const pending = previous.then(async () => {
      // A clear or newer write supersedes work that has not reached storage.
      // Already-running writes finish before the queued clear/newer write.
      if (generations.get(id) !== generation) return { persistent: true, superseded: true };
      try { await operation(); return { persistent: true }; }
      catch { return { persistent: false }; }
    });
    queues.set(id, pending);
    void pending.then(() => { if (queues.get(id) === pending) queues.delete(id); });
    return pending;
  }

  return {
    /** @param {string} id @returns {Promise<PdfDraft|null>} */
    async read(id) {
      assertId(id);
      if (memory.has(id)) return current(id);
      const generation = generations.get(id) ?? 0;
      let loaded;
      try {
        const value = await storage.read(id);
        loaded = value == null ? null : copyDraft(value);
      } catch { loaded = null; }
      // An in-flight read must never resurrect a cleared draft or replace
      // text typed while IndexedDB was responding.
      if ((generations.get(id) ?? 0) !== generation || memory.has(id)) return current(id);
      if (loaded) memory.set(id, loaded);
      return loaded ? copyDraft(loaded) : null;
    },
    /** @param {string} id @param {PdfDraft} record @returns {Promise<PersistenceResult>} */
    write(id, record) {
      assertId(id);
      const snapshot = copyDraft(record);
      // Deliberately before any await or promise callback: a router unmount
      // immediately after this call still leaves the draft available.
      memory.set(id, snapshot);
      return persist(id, advance(id), () => storage.write(id, snapshot));
    },
    /** @param {string} id @returns {Promise<PersistenceResult>} */
    clear(id) {
      assertId(id);
      memory.set(id, null); // Durable-in-this-tab tombstone fences pending reads.
      return persist(id, advance(id), () => storage.remove(id));
    },
  };
}

/** Browser adapter, opened lazily so importing this module during SSR is safe. */
function indexedDbStorage() {
  /** @type {Promise<IDBDatabase>|null} */
  let opening = null;
  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error('IndexedDB is unavailable.')); return; }
      let settled = false;
      const timer = setTimeout(() => fail(new Error('Draft storage did not open.')), 3000);
      function fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
      let request;
      try { request = globalThis.indexedDB.open('career-ops-pdf-drafts', 1); }
      catch (error) { fail(error); return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts');
      };
      request.onerror = () => fail(request.error ?? new Error('Draft storage could not open.'));
      request.onblocked = () => fail(new Error('Draft storage is blocked by another tab.'));
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        settled = true;
        clearTimeout(timer);
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
    });
    void opening.catch(() => { opening = null; });
    return opening;
  }

  /** @param {IDBTransactionMode} mode @param {(store:IDBObjectStore)=>IDBRequest} action */
  async function transact(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('drafts', mode);
      const request = action(transaction.objectStore('drafts'));
      // EVIDENCE: request success is not transaction commit. Report persistent
      // recovery only after complete, including quota and abort failures.
      // https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event
      transaction.oncomplete = () => resolve(request.result ?? null);
      transaction.onabort = () => reject(transaction.error ?? new Error('Draft storage write was aborted.'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Draft storage failed.'));
    });
  }
  return {
    read: (id) => transact('readonly', (store) => store.get(id)),
    write: (id, record) => transact('readwrite', (store) => store.put(record, id)),
    remove: (id) => transact('readwrite', (store) => store.delete(id)),
  };
}

const defaultStore = createPdfDraftStore(indexedDbStorage());
export const readPdfDraft = defaultStore.read;
export const writePdfDraft = defaultStore.write;
export const clearPdfDraft = defaultStore.clear;
