# Lexical career workspace

## Design and scope

Build a local, Notion-like workspace for career context and CVs. Lexical is the
shared document editor. A nested sidebar, breadcrumbs, search and editable
sections make the existing documents navigable without introducing a competing
source of career facts. The organization follows the supplied Notion workspace:
career context, approved achievements, CVs, and reference material.

The existing Markdown files remain authoritative. Documents are allowlisted by
logical ID: `context` (`modes/_context.md`), `cv` (`cv.md`), `achievements`
(`article-digest.md`), `profile` (`modes/_profile.md`), `stories`
(`interview-prep/story-bank.md`), and `guide` (`modes/_custom.md`). Headings form
child pages; nested headings form nested pages. The outline is derived from the
current file, not stored as another editable copy. New pages, rename and sibling
reordering modify headings and their sections in the original document.

`/context` opens context; `/cv` opens the CV in the same workspace. Existing
Documents and Pipeline destinations retain tailored outputs and applications.
The workspace links to those destinations rather than duplicating their stores.

No personal content or Notion IDs are embedded in system files. No existing user
file is changed by installing or opening the feature. Notion content is not
silently imported, and source notes are not promoted into approved facts.

## Evidence and decisions

- Lexical is MIT and provides React, Markdown, history, lists, links, typeahead
  and draggable-block packages. It leaves menus and persistence to the app:
  https://lexical.dev/docs/intro and https://lexicaljs.org/docs/react/plugins.
- Markdown import/export uses explicit transformers:
  https://lexicaljs.org/docs/packages/lexical-markdown. The editor must preserve
  unsupported source rather than silently normalize it away. Rich editing uses
  the supported subset; unsupported documents have an explicit source fallback.
- `web/AGENTS.md` requires a view over canonical files and plain `.mjs` modules
  for testable logic. Existing safe-write helpers supply backups and atomic writes.
- Source revisions are content hashes. Mutations require the last read revision;
  stale clients receive a conflict with their draft intact. Known document IDs
  are the only writable targets. Symlinks and malformed UTF-8 are refused.
- The nested page model is bounded by Markdown heading levels. Existing fenced
  code, duplicate headings, line endings and untouched document regions must be
  preserved. Unsupported outline constructs remain editable at document level.
- The current Next.js bundled route-handler and client-component guides were
  read before implementation. Lexical is loaded on the client.

## Acceptance criteria

1. Both CV and Context use the same Lexical editor, with formatting, lists,
   headings, links, quotations/callouts, undo/redo, slash menu and block reorder.
2. The sidebar groups canonical documents, expands nested headings, filters
   pages, and provides breadcrumbs and child-page creation/rename/reordering.
3. Saving/reloading retains text, URLs, source labels, nested lists and numbers.
   Unsupported Markdown remains recoverable in source mode and is never silently
   discarded. Opening a document does not write or mark it changed.
4. Section edits preserve every unrelated byte. Stale revisions, invalid files,
   unsafe paths and oversized writes fail without replacing user content.
5. Unsaved drafts survive failed saves; in-app links prompt before leaving.
   Browser history and reload preserve a per-tab draft for explicit recovery with
   its original revision. Save state/errors are announced accessibly. Mobile works.
6. Existing CV save consumers and skill-gap refresh continue to work.
7. Focused tests, browser scenarios against disposable data, web typecheck/build,
   web tests and the full root suite are run. Failures are reported accurately.

## Implementation plan

Each behavior task begins with a failing test. Tasks can share a bounded worker
when they own the same files; ownership never overlaps.

| Task | Files | Acceptance and verification |
| --- | --- | --- |
| 1. Outline parsing | `web/src/lib/career-workspace.mjs`, `web/tests/lib/career-workspace.test.mjs` | Failing tests for nested/duplicate headings, fences and CRLF; green after parser. |
| 2. Section mutations | Same files | Failing tests for replace, add, rename, sibling move and preserving unrelated bytes. |
| 3. Safe document access | `web/src/lib/career-workspace-store.mjs`, `web/tests/lib/career-workspace-store.test.mjs` | Failing temporary-directory tests for allowlist, missing/malformed files, symlinks, size, conflicts, backup failure and overridden roots. |
| 4. Workspace API | `web/src/app/api/workspace/route.ts`, route tests under `web/tests/lib/` | GET index/document; POST revision-checked mutation; structured error/status assertions. |
| 5. Markdown bridge | `web/src/lib/editor-markdown.mjs`, `web/tests/lib/editor-markdown.test.mjs` | Failing round-trip tests for supported content and unsupported fallback; no initial normalization save. |
| 6. Lexical editing controls | `web/src/components/editor/*` | Shared client editor, accessible toolbar, lists/links/callouts/history and source toggle. Browser tests verify editing. |
| 7. Slash and block controls | Same editor directory | Keyboard slash menu, block drag/reorder with keyboard equivalent; browser regression. |
| 8. Workspace interface | `web/src/components/career-workspace/*` | Nested sidebar, search, breadcrumbs, save/conflict states and dirty-navigation protection. Browser tests start failing before UI work. |
| 9. Page operations | Same workspace directory | New child, rename and reorder actions use backend operations and keep selection coherent. Browser regression. |
| 10. Routes and navigation | `web/src/app/context/page.tsx`, `web/src/components/cv-editor.tsx`, `web/src/lib/nav-items.ts` | Existing `/cv` entry works; Context shared across desktop/mobile navigation. |
| 11. Integration verification | `web/tests/lib/career-workspace.browser.test.mjs` | Real browser on disposable data: formatting/save/reload, child pages, conflict, source fallback, mobile and screenshots. |
| 12. Review and finish | This plan, relevant documentation | Spec review then code review; fix findings; full suites/typecheck/build; atomic commits on `renato/lexical-career-workspace`. |

## Execution notes

The autonomous-implementation skill's named superpowers helper skills are not
installed. Their design/plan/execute/review sequence is followed using the
available tools and bounded subagents. Implementation tests use fictional data.

All twelve tasks are implemented. The spec review added conservative outline
handling, explicit discard handling, and per-tab draft recovery scoped to an
opaque workspace identity. The subsequent code review found and verified fixes
for link controls accepting changes during a pending save and for HTML
processing instructions, declarations and CDATA being mistaken for pages. Fast
slash-command input exposed a stale menu range; a live-selection range fix also
passed independent checks for fragmented text, surrounding prose and URLs.

Validation recorded on 2026-10-25:

- Backend: 25 tests pass, including byte-preserving mutations, missing and invalid
  files, root isolation, symlinks, stale revisions, backups and HTML boundaries.
- Full web suite: `2029` tests, `2011` passed, `0` failed, `18` skipped. Browser
  tests are opt-in and run separately against a disposable local data root.
- Workspace browser scenario passes on desktop and mobile: section save/reload,
  child creation/rename/reorder, unsaved navigation, stale-save protection,
  unsupported table preservation, shared CV route, history/reload recovery and
  retained revision conflicts. No browser errors.
- Editor verification: `11/11` passes, including both production-browser cases
  for formatting, links, rapid keyboard/mouse slash selection, block reordering,
  pasted unsafe links, and a delayed save. No skipped editor checks in this run.
- Typecheck and production build pass. Production dependency audit:
  `found 0 vulnerabilities`. Spec review and subsequent code review are complete.
- Full root suite: `17596 passed, 9 failed, 13 warnings` across 878 discovered
  suites. Existing failures are listed below; this is not a passing root-suite
  result. Failing owners/tests are unchanged from the pre-feature baseline.

Root-suite failures (verbatim labels, with local personal paths omitted):

1. `SYSTEM_PATHS coverage gap — a new file is unregistered and update-system will not ship it:`
   — existing `verify-block-b-context.mjs` is missing from the update manifest.
2. `Absolute path: fork/scripts/daily.sh:8`.
3. `Absolute path: fork/scripts/daily.sh:9`.
4. `Absolute path: fork/scripts/daily.sh:10`.
5. `tests/direct-eval-jd-archive.test.mjs — node:test suite failed (exit 1)`.
   The existing paid-model guard rejects the mocked model name.
6. `doctor: any other launch failure was misdiagnosed:` followed by
   `✗ Playwright chromium is installed but failed to launch: Target page, context or browser has been closed`.
   The existing classifier fails to strip ANSI prefixes in the fake-browser log.
7. `CLI: every source is labelled mtime`. The fixture omits the context file while
   requiring every source to have an mtime basis.
8. `tests/split-root.test.mjs — node:test suite failed (exit 1)`. Same mocked-model
   restriction as item 5. An isolated mock-only rerun allowing fixture models
   passes all 11 archive/split-root assertions.
9. `the test run changed the real data root`: the guard observed log/report changes
   during concurrent activity. The guard identifies changes, not their writer;
   all workspace browser writes target an explicitly marked fictional fixture.

The first web-suite run encountered four stale tests already fixed in upstream
commit `abab4feb`; isolated reruns and the final full web suite pass. The first
development browser run encountered a hydration error and refresh loop with two
Next development servers sharing generated files. Production-build browser
verification avoids that test-environment conflict.
