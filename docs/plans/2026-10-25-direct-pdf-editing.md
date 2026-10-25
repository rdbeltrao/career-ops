# Direct editing and section movement in generated PDFs

## Corrected interaction

The previous editor used a paragraph form beside a rendered PDF. Replace that interaction with the pinned BentoPDF native editor: click text and type on the page, preserve its style runs, and see reflow while typing. Keep Classic as an explicit alternative. Do not add another manual text field outside the page.

Evidence: <https://www.bentopdf.com/edit-pdf-text> documents native in-place editing. The pinned upstream `src/js/editcore/app.js` implements contenteditable spans, extracted document fonts, IME handling, live PDF glyph rendering, and paragraph/object movement. Reusing that UI avoids implementing an incomplete substitute. Its AGPL source, local modifications, and asset hashes remain available with the application.

The app keeps its own Save PDF, revision checks, versions, Trash, and browser recovery. Native file-open, download, external navigation, and drop handlers must not bypass that lifecycle. The native editor's page navigation replaces the previous vertically stacked preview.

## Sections and AI

Recognize main CV section headings and group their text, bullets, rules, and contained decorative objects. A section may span multiple pages; it remains one logical section. Dragging its handle to another section's insertion point reorders the grouped content and shifts intervening content. Ambiguous geometry or unsupported page structures must produce a specific error without partially moving objects. Page-local fragments must never be presented as whole-section movement.

The engine spike verified same-document cross-page PDFium object transfer with embedded fonts and a colored divider: after save/reopen, text and divider moved together and unrelated content stayed intact. Production movement must snapshot first, pin involved pages, resolve all handles before mutation, regenerate both source and destination pages, and roll back all changes on failure.

Select a paragraph or section, enter an AI instruction, and preview the proposed replacements on the page. Reject restores the exact prior state; Accept applies all targeted paragraphs atomically. Missing, duplicate, stale, or unexpected target IDs are rejected. Fact checks and the configured read-only AI CLI remain mandatory. No provider call is necessary for browser verification; controlled proposals exercise acceptance and rejection while server tests exercise validation.

## Spacing and recovery

The spacing bug reproduces with a fictional Helvetica Neue italic paragraph. Bento's paragraph model and pageTextJson can omit whitespace objects that the raw PDFium character stream retains. Reconcile whitespace against the same original non-whitespace sequence and preserve run styles; never guess word boundaries or insert a space between every run.

Each inline input immediately emits a draft with original paragraph identity, text, and serializable style runs. Cache that before navigation; commit PDF bytes on blur or Save. Recovery restores the on-page editor and styling. AI previews are transient and do not replace a manual recovery draft. Failed edits and failed saves preserve pending content.

## Implementation and acceptance

1. `web/public/pdf-editor/model.mjs` and text-model tests: reproduce missing spaces with synthetic PDF, reconcile whitespace, preserve punctuation/non-space scripts and mixed styles, save/reopen without duplicate content.
2. `web/public/pdf-editor/sections.mjs` and section tests: grouping, decorations, cross-page layout plan, no overlap or partial movement, ambiguous layouts rejected. Test section order and actual saved object geometry.
3. Native Bento UI, adapter, bridge, CSS and engine browser tests: direct typing, live preview, page navigation, section drag/drop, grouped undo/redo, atomic AI preview/accept/reject, local-only resources, failed mutation rollback.
4. `web/src/components/documents/visual-pdf-editor.tsx`, message validation and draft store: remove paragraph form, full-width document canvas, compact AI controls, style-faithful recovery, Save flushes inline edits, Classic stays accessible. Start with failing message/recovery tests.
5. `web/src/lib/pdf-rewrite.mjs` and tests: bounded section targets, exact target IDs, per-target fact checks, stale revision/provider/malformed-response handling, legacy paragraph requests supported.
6. Real browser acceptance on fictional data: click/type directly on the PDF, retain spaces and styling, drag a section with its divider across pages, inspect saved PDF and untouched content, undo/redo, reject/accept AI previews, recover an uncommitted inline draft after navigation, save/version restore/Trash regression. Inspect desktop/mobile screenshots. Run web suite, typecheck, build, and independent review; fix findings before completion.

Supporting `superpowers` skills are unavailable; the explicitly invoked autonomous-implementation workflow is followed directly with bounded subagents, red/green tests, saved design, independent review, and commits. This work starts from `origin/main` on `renato/cv-direct-editing` and preserves other checkouts.
