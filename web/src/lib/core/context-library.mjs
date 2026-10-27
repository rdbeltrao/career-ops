import { pathToFileURL } from "node:url";
import { resolveRootScript } from "./code-root.mjs";

/** @typedef {{text:string,evidenceText:string,notice:string,source:'library',pages?:Array<{breadcrumb:string[],relativePath:string,usage:string,content:string,evidenceText:string}>}} ContextLibrary */

/**
 * Use the engine's reader at request time, following core/cv-template.mjs.
 * Only an absent index selects the legacy path; a broken library must never
 * quietly send stale career facts to an AI worker.
 * @param {string} codeRoot
 * @param {string} dataRoot
 * @returns {Promise<ContextLibrary|null>}
 */
export async function readAppContextLibrary(codeRoot, dataRoot) {
  // Only the core reader checks every ancestor before deciding the index is absent.
  const modulePath = resolveRootScript(codeRoot, "lib/context-library");
  const core = await import(/* webpackIgnore: true */ pathToFileURL(modulePath).href);
  return core.readContextLibrary(dataRoot);
}

/** @param {ContextLibrary|null} library @param {boolean} hasCv */
export function candidateContextReady(library, hasCv) {
  return library ? Boolean(library.evidenceText.trim()) : hasCv;
}
