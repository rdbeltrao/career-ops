# BentoPDF visual PDF editor: source and notices

This directory contains BentoPDF's PDF text-editing engine, used by career-ops' optional visual editor. The classic CV Studio remains available independently.

## Exact upstream sources

- BentoPDF 2.8.10, commit [`4edb1718cc195a59f0cedb473ca96f30c1bb6f43`](https://github.com/alam00000/bentopdf/tree/4edb1718cc195a59f0cedb473ca96f30c1bb6f43), AGPL-3.0-only. JavaScript sources originate in `src/js/editcore/` and `src/js/utils/freetext-script.ts`.
- The bundled `engine/editcore.js` and `engine/editcore.wasm` are extracted unchanged from [`vendor/bentopdf-pdfium/bentopdf-pdfium-051abe5b72a9.tgz`](https://github.com/alam00000/bentopdf/blob/4edb1718cc195a59f0cedb473ca96f30c1bb6f43/vendor/bentopdf-pdfium/bentopdf-pdfium-051abe5b72a9.tgz).
- Corresponding C/C++ engine source, dependencies, build scripts, and original notices: [BentoPDF PDFium Viewer, commit `051abe5b72a9219e6b86e1f890fa7d4aca0e8f49`](https://github.com/alam00000/bentopdf-pdfium-viewer/tree/051abe5b72a9219e6b86e1f890fa7d4aca0e8f49). Engine source is in `packages/pdfium/build/code/editcore/`; build scripts are in `packages/pdfium/build/`.
- Local Noto Sans Regular, Bold, Italic and Bold Italic fonts come from `packages/fonts/latin/` at the same engine-source commit. Their SIL Open Font License is retained in `fonts/LICENSE`.

## Local changes

- `engine-loader.js` resolves the supplied JavaScript and WebAssembly files from this directory, with no CDN, package install, or runtime download from a third-party host.
- `core.js` imports `./freetext-script.js` instead of the upstream TypeScript path.
- `freetext-script.js` retains only the upstream `needsFontEmbedding` helper and its regular expression, with TypeScript annotations removed.
- `package.json` declares native ES modules for Node-based verification.
- The career-ops visual interface and message bridge are provided as readable source at [`../../pdf-editor/bridge.mjs`](../../pdf-editor/bridge.mjs), [`../../pdf-editor/model.mjs`](../../pdf-editor/model.mjs), [`../../pdf-editor/index.html`](../../pdf-editor/index.html), and [`../../pdf-editor/editor.css`](../../pdf-editor/editor.css). These new integration files are provided under AGPL-3.0-only.
- `SHA256SUMS.json` records hashes for the supplied upstream and locally adapted assets.

No source files are minified beyond the prebuilt upstream Emscripten loader. The full AGPL license is in `LICENSE`; original EmbedPDF, HarfBuzz and PDFium notices are preserved in the adjacent license files and `NOTICE.pdfium-viewer`.

The editor does not automatically paginate or rebuild a CV's source document. It changes existing PDF paragraph content and rejects detectable paragraph overlaps and page overflow. PDF text, images and font data are processed locally; AI requests, storage and document-management actions are handled separately by career-ops.
