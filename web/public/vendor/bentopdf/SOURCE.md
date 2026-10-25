# BentoPDF visual PDF editor: source and notices

This directory contains BentoPDF's native text-editing interface and PDF engine, used by career-ops' optional visual editor. The classic CV Studio remains available independently.

## Exact upstream sources

- BentoPDF 2.8.10, commit [`4edb1718cc195a59f0cedb473ca96f30c1bb6f43`](https://github.com/alam00000/bentopdf/tree/4edb1718cc195a59f0cedb473ca96f30c1bb6f43), AGPL-3.0-only. JavaScript sources originate in `src/js/editcore/` and `src/js/utils/freetext-script.ts`.
- The bundled `engine/editcore.js` and `engine/editcore.wasm` are extracted from [`vendor/bentopdf-pdfium/bentopdf-pdfium-051abe5b72a9.tgz`](https://github.com/alam00000/bentopdf/blob/4edb1718cc195a59f0cedb473ca96f30c1bb6f43/vendor/bentopdf-pdfium/bentopdf-pdfium-051abe5b72a9.tgz). The WebAssembly binary is unchanged; the JavaScript has only the whitespace cleanup listed below.
- Corresponding C/C++ engine source, dependencies, build scripts, and original notices: [BentoPDF PDFium Viewer, commit `051abe5b72a9219e6b86e1f890fa7d4aca0e8f49`](https://github.com/alam00000/bentopdf-pdfium-viewer/tree/051abe5b72a9219e6b86e1f890fa7d4aca0e8f49). Engine source is in `packages/pdfium/build/code/editcore/`; build scripts are in `packages/pdfium/build/`.
- Local Noto Sans Regular, Bold, Italic and Bold Italic fonts come from `packages/fonts/latin/` at the same engine-source commit. Their SIL Open Font License is retained in `fonts/LICENSE`.

## Local changes

- `engine/editcore.js` has two trailing spaces removed from an otherwise blank line; its executable code is unchanged.
- `engine-loader.js` resolves the supplied JavaScript and WebAssembly files from this directory, with no CDN, package install, or runtime download from a third-party host.
- `core.js` imports `./freetext-script.js` instead of the upstream TypeScript path.
- `freetext-script.js` retains only the upstream `needsFontEmbedding` helper and its regular expression, with TypeScript annotations removed. Its raw NUL is written as a `\u0000` escape, preserving the regular expression while keeping the source searchable.
- `app.js` comes from the pinned `src/js/editcore/app.js`. The original contenteditable editor, embedded-font rendering, caret geometry, live glyph previews, and input-method support are retained. Local changes import the whitespace-preserving paragraph reader, route paragraph opening/commit through the career-ops bridge, keep Enter inside the current paragraph, use local Noto glyphs when an embedded font subset cannot paint new words, map one editable text buffer across live continuation pages, and export a small `careerNative` adapter. Native file opening, export, general design controls, and history controls are hidden or intercepted by the integration; all accepted edits use transactional whole-document snapshots.
- `native.html` is the editor subtree of pinned `src/pages/edit-pdf-text.html`, excluding the surrounding upload page and scripts. `native.css` is pinned `src/css/edit-pdf-text.css`. Both retain the upstream structure and styles; career-ops overrides are in `../../pdf-editor/editor.css`.
- `package.json` declares native ES modules for Node-based verification.
- The career-ops visual interface and message bridge are provided as readable source at [`../../pdf-editor/bridge.mjs`](../../pdf-editor/bridge.mjs), [`../../pdf-editor/model.mjs`](../../pdf-editor/model.mjs), [`../../pdf-editor/index.html`](../../pdf-editor/index.html), [`../../pdf-editor/editor.css`](../../pdf-editor/editor.css), and [`../../pdf-editor/sections.mjs`](../../pdf-editor/sections.mjs), [`../../pdf-editor/pagination.mjs`](../../pdf-editor/pagination.mjs), [`../../pdf-editor/page-engine.mjs`](../../pdf-editor/page-engine.mjs), and [`../../pdf-editor/reflow.mjs`](../../pdf-editor/reflow.mjs). These new integration files are provided under AGPL-3.0-only.
- `SHA256SUMS.json` records hashes for the supplied upstream and locally adapted assets.

No source files are minified beyond the prebuilt upstream Emscripten loader. The full AGPL license is in `LICENSE`; original EmbedPDF, HarfBuzz and PDFium notices are preserved in the adjacent license files and `NOTICE.pdfium-viewer`.

The editor does not rebuild a CV's source document. Direct typing and AI changes reflow paragraph lines and following content across matching PDF pages. Continuation pages are added automatically and marked invisibly so empty generated pages can be reclaimed after later edits; recognized page counters update with the document. Whole CV sections retain their text and supported decorations during reordering. Live typing and AI previews run the same layout operation on an isolated in-memory PDF; accepted edits and undo use complete PDF snapshots. Ambiguous artwork, rotated pages, and linked content that would move are rejected without losing the draft. All layout work is capped at 20 pages and 20 MB. PDF text, images and font data are processed locally; AI requests, storage and document-management actions are handled separately by career-ops.
