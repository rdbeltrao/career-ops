/** @typedef {{section:string|null, revision:string, content:string, original:string, form:{kind:'add'|'rename',title:string}|null}} RecoveredDraft */
/** @typedef {{getItem:(key:string)=>string|null,setItem:(key:string,value:string)=>void,removeItem:(key:string)=>void}} DraftStorage */

/** @param {unknown} value @returns {value is RecoveredDraft} */
function validDraft(value) {
  if (!value || typeof value !== 'object') return false;
  const item = /** @type {RecoveredDraft} */ (value);
  return (item.section === null || typeof item.section === 'string') &&
    typeof item.revision === 'string' && typeof item.content === 'string' && typeof item.original === 'string' &&
    item.content.length <= 400_000 && item.original.length <= 400_000 &&
    (item.form === null || Boolean(item.form && ['add', 'rename'].includes(item.form.kind) && typeof item.form.title === 'string' && item.form.title.length <= 200));
}

export function createDraftRecovery() {
  /** @type {Map<string, RecoveredDraft|null>} */
  const memory = new Map();
  /** @param {string|undefined} workspace @param {string} document */
  const key = (workspace, document) => `career-ops:workspace-draft:${workspace || 'memory-only'}:${document}`;
  return {
    /** EVIDENCE: sessionStorage is scoped to a browser tab and survives reloads:
     * https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage
     * The opaque server workspace identity prevents reuse across local data roots.
     * Draft recovery never writes a career file or changes its source revision.
     * @param {DraftStorage|null} storage @param {string|undefined} workspace @param {string} document @param {RecoveredDraft} draft
     */
    write(storage, workspace, document, draft) {
      if (!validDraft(draft)) return false;
      const id = key(workspace, document);
      memory.set(id, draft);
      if (!workspace || !storage) return false;
      try { storage.setItem(id, JSON.stringify(draft)); return true; }
      catch { return false; }
    },
    /** @param {DraftStorage|null} storage @param {string|undefined} workspace @param {string} document */
    read(storage, workspace, document) {
      const id = key(workspace, document);
      if (memory.has(id)) return memory.get(id) ?? null;
      if (!workspace || !storage) return null;
      try {
        const raw = storage.getItem(id);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!validDraft(parsed)) return null;
        memory.set(id, parsed);
        return parsed;
      } catch { return null; }
    },
    /** @param {DraftStorage|null} storage @param {string|undefined} workspace @param {string} document */
    clear(storage, workspace, document) {
      const id = key(workspace, document);
      memory.set(id, null);
      if (!workspace || !storage) return;
      try { storage.removeItem(id); } catch { /* Keep an in-memory tombstone when storage is unavailable. */ }
    },
  };
}

// This module survives client-side route changes, retaining recovery even when
// the browser denies session storage. Hard navigation still has beforeunload.
export const workspaceDrafts = createDraftRecovery();
