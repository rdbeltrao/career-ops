/** @typedef {{id:string,path:string,content:string,revision:string,exists:boolean}} ConfigSnapshot */
/** @typedef {{content:string,original:string,revision:string,exists:boolean}} ConfigDraft */

export function createConfigDraftRecovery() {
  /** @type {Map<string,ConfigDraft>} */
  const drafts = new Map();
  /** @param {ConfigSnapshot} file */
  const key = (file) => file.path && file.id ? JSON.stringify([file.path, file.id]) : null;
  return {
    /** @param {ConfigSnapshot} file @param {string} content */
    write(file, content) {
      const id = key(file);
      if (!id) return;
      if (content === file.content) drafts.delete(id);
      else drafts.set(id, { content, original: file.content, revision: file.revision, exists: file.exists });
    },
    /** @param {ConfigSnapshot} file */
    read(file) {
      const id = key(file);
      return id ? drafts.get(id) ?? null : null;
    },
    /** @param {ConfigSnapshot} file */
    clear(file) {
      const id = key(file);
      if (id) drafts.delete(id);
    },
  };
}

// EVIDENCE: Next client transitions replace pages without reloading the tab
// (next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md).
// Keep recovery in module memory, like workspace-drafts, without persisting YAML
// in browser storage. The server's resolved path isolates data roots/overrides;
// the original revision remains intact so restoring cannot bypass conflicts.
export const configDrafts = createConfigDraftRecovery();
