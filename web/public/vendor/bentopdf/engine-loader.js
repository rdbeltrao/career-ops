// Adapted from BentoPDF engine-loader.js; AGPL-3.0-only. See SOURCE.md.
import createModule from './engine/editcore.js';
export const ENGINE_BUILD = 'bentopdf-pdfium@051abe5b72a9219e6b86e1f890fa7d4aca0e8f49';
export function createEngineModule(options) {
  const wasm = new URL('./engine/editcore.wasm', import.meta.url);
  return createModule({ ...options, locateFile: (file, prefix) => file.endsWith('.wasm')
    ? (typeof window === 'undefined' ? decodeURIComponent(wasm.pathname) : wasm.href)
    : prefix + file });
}
