# Classic and visual CV editing

## Decision and scope

Keep the existing CV Studio at `/pipeline/[id]/cv-studio` as **Classic editor**. Add an explicit **Visual PDF editor** alternative from both the report and Documents. Use the actual BentoPDF paragraph-editing engine, pinned to `4edb1718cc195a59f0cedb473ca96f30c1bb6f43`, with its local PDFium WebAssembly dependency. The PDF itself is opened, edited, and saved; this does not convert a CV to an image or replace it with a different template.

Evidence: <https://www.bentopdf.com/edit-pdf-text> documents existing-text editing and paragraph-local reflow. The source's `src/js/editcore/core.js` exposes paragraph models, preview, commit, rendering, and PDF export. A narrow local wrapper avoids a second frontend framework or document server. The bundled upstream component retains AGPL licensing, notices, and source provenance.

The visual editor shows rendered pages with selectable paragraphs, a manual text field, and a prompt for rewriting the selected paragraph with the user's configured AI CLI. AI returns a proposal for explicit acceptance, using existing rewrite execution and factual-claim checks. Classic remains the option for structural changes and repagination. Changes made directly to a PDF do not alter Classic's source content; the UI must say so before switching workflows.

## File lifecycle

Save replaces the selected generated PDF at the same path after comparing its SHA-256 revision, preserving a recoverable previous version. This preserves existing application/index associations. Removal moves a file into private recoverable storage; restore must never overwrite a new file with the same name. Existing manifest entries remain as missing-file tombstones when removed so application selection cannot silently fall back to another CV. No personal documents are used for tests.

PDF edits run locally. Only selected text and the user's instruction enter the existing AI workflow. The iframe bridge checks origin, source window, session, command shape, and stale selected text. Long rewrites must fail safely when they exceed supported layout bounds. Unsupported PDFs receive an actionable error and a Classic alternative where available.

Unsaved paragraph text and applied PDF bytes are cached on this device, synchronously in memory and then in IndexedDB. Browser Back/Forward and assistant navigation can recover them. A revision mismatch keeps the recovered copy separate for download or discard. A failed editor mutation rolls back its PDF bytes without discarding pending text. Save clears the recovered draft only after the server accepts the revision-checked write.

The assistant can open either editor, propose moving a named PDF to Trash, and propose restoring a removed PDF. Mutations use the existing explicit confirmation cards and the same revision-checked document API as manual actions.

## Tasks and verification

1. **Engine integration.** Own `web/public/vendor/bentopdf/**`, `web/public/pdf-editor/**`, `web/tests/lib/bento-engine*.test.mjs`. Start with a failing synthetic-PDF roundtrip test. Vendor pinned source, licenses, and engine. Render, select, replace, export, reopen, and assert new text is present, old text is absent, and other paragraphs remain intact. Verify overflow and stale selections fail without changing bytes.
2. **Document storage.** Own `web/src/lib/document-store.mjs`, `document-route.mjs`, `web/src/app/api/documents/[id]/route.ts`, corresponding tests. Start with failing save/version/trash/restore tests. Verify revision conflicts, size/type validation, containment/symlinks, origin checks, no-clobber restore, and unchanged association paths.
3. **Editor choice.** Own `web/src/lib/document-editing.mjs`, `web/src/components/documents/**`, `web/src/app/documents/[id]/edit/page.tsx`, report visual route, Documents and GeneratePdfButton entry points. Start with failing routing/selection tests. Preserve Classic URL and functionality. Resolve exact indexed PDFs and expose both editor choices with capability explanations.
4. **Selected-text AI.** Own `web/src/lib/pdf-rewrite.mjs`, `web/src/app/api/documents/[id]/rewrite/route.ts`, associated tests. Start with failing validation/prompt/proposal tests. Reuse configured CLI and existing claim checks. Never apply automatically; stale proposals must not change a different paragraph.
5. **End-to-end acceptance.** Run a scratch-data browser scenario: both editor choices, actual paragraph edit and PDF save/reopen, AI proposal accept/reject with controlled test responses, overflow rejection, version restore, delete/undo, and reload. Inspect desktop/mobile UI. Run web test suite, typecheck, production build, and relevant root checks. Review spec compliance, then code quality; fix findings before delivery.

## Assumptions and limits

- Generated text PDFs are the supported target; scanned/OCR-only and encrypted files are not silently converted.
- Visual editing is bounded to 20 MB and 20 pages. Signed documents are refused to avoid invalidating their signatures.
- An existing PDF paragraph is the initial selection unit. Arbitrary multi-page restructuring stays in Classic.
- Save uses the existing file identity; previous versions live outside `output/` and cannot be attached accidentally.
- User-facing content is never invented for test fixtures; fixtures are explicitly fictional.
- Supporting `superpowers` skills are not installed in this environment. The invoked autonomous-implementation skill's design, TDD, delegated execution, review, and verification stages are followed directly.

## Verification completed

- Full web suite: 2,016 tests, 1,999 passed, 17 intentionally skipped, zero failures. The opt-in browser tests are run separately below.
- TypeScript check and production build passed. The build used a separate `.next-prod` directory while the scratch app was running.
- Bento engine/browser suite: three tests passed, including real PDF text replacement, embedded fonts, two pages, local-only assets, overflow protection, and failed replace/undo/redo rollback.
- Full application browser scenario passed against a fictional temporary data root: Classic and Visual routes, differing tracker/report IDs, manual editing, save/reopen and text extraction, AI accept/reject, version restore, Trash after reload, and draft recovery after Back/Forward and injected engine errors.
- AI responses in the full browser scenario were controlled fixtures. Rewrite validation, factual-claim rejection, stale revisions, and provider-error handling were tested separately; a live paid AI call was not made.
- Desktop and 390-pixel mobile layouts were inspected. Mobile assertions wait for the editor's resize render and verify page bounds as well as document overflow.
- Final independent review closed both draft-loss findings with browser reproductions and found no remaining actionable issues in the reviewed scope.
- Existing Classic-render and Explore test fixtures were updated to respect the application's separate code/data roots; no Classic production rendering behavior changed.

The implementation is isolated on `renato/cv-visual-pdf-editor`. The original checkout's unrelated in-progress edits were preserved.
