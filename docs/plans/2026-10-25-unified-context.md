# Unified career context

## Requested behavior

Context is one editable page hierarchy. Saved pages supply job matching, CV
generation and their fact checks directly. There is no Source pages/App files
switch and no separate summary that must be updated to make edits effective.
CV draft remains an output, outside the context tree.

## Design

- Read the current `data/context-workspace/index.json` and Markdown bodies on each
  request. Preserve titles, ancestry, order, original snapshots and draft guards.
- The shared core reader is authoritative whenever the manifest exists. Missing
  bodies, invalid metadata, unsafe paths and over-limit input fail visibly; they
  never cause a fallback to an older profile. Legacy installations without a
  library keep their existing file-based behavior.
- Page purpose is stored as optional `usage`: `facts`, `preferences`, `reference`
  or `unconfirmed`. It inherits from the nearest ancestor, defaulting to facts
  for ordinary newly authored libraries. The page editor exposes this purpose
  without creating separate navigation sections.
- Prompts receive the ordered hierarchy with page citations and purpose labels.
  Facts support candidate claims, preferences guide matching, and reference or
  unresolved material supplies context without verifying achievements. Explicit
  uncertainty markers remain visible and are conservatively excluded from the
  deterministic evidence pool. The filter is not semantic verification.
- The fact gate uses the same fresh library, including its filtered evidence.
  Old CVs and compiled summaries cannot substantiate a removed or changed claim.
  Stored allowlists cannot restore claims removed from current Context. Keep
  forbidden-phrase and warning policy; record settled facts in the pages.
- Imported pages receive purposes based on their existing stated content. Current
  local search preferences are preserved as a child page within the same tree.
  This migration changes metadata and adds a page; it does not rewrite career
  facts, original snapshots, the existing CV, or the old profile files.

## Work and verification

1. Add a core library reader and tests for ordering, inheritance, fresh edits,
   role boundaries, uncertainty markers, missing bodies and unsafe paths.
2. Remove split navigation, retain draft guards and persistent drawer behavior,
   and verify purpose changes use revision protection and backups.
3. Wire app prompts, direct matching loaders, CV generation and deterministic
   fact/skill checks to the reader. Test without a legacy CV or context summary.
4. Apply the backed-up metadata/preference migration to the private library.
5. Run focused tests, full web tests, core regression suite, typecheck, production
   build and browser scenarios against disposable fictional data. Inspect the
   real Context read-only. Review implementation and record limitations.

## Evidence and boundaries

The existing app evaluation already uses `context-evidence.mjs`; the shared
reader is the integration point. `web/AGENTS.md` requires core orchestration or
schema parity tests. The existing workspace manifest and safe backup writer
already support the hierarchy and optimistic revision checks. No model calls,
application submissions, Notion writes or paid API runs are needed to verify
this change.

## Migration and validation

- Kept the existing 65-page hierarchy and every original body/snapshot intact.
  Assigned purposes from the pages' stated contents: 10 career-fact pages, two
  preference pages, 53 reference pages and one unconfirmed template page after
  adding the current preference page. The four existing targeting sections were
  copied beneath Interests; the old profile was unchanged. Backed up the manifest
  and added a backed-up procedural authority rule to the local house rules.
- The complete context is about 280 KB. Web workers pass large prompts through
  standard input, with a 680 KB Unicode fixture proving exact delivery and
  retained permission restrictions. Unsupported CLI adapters refuse oversized
  requests explicitly rather than truncating context.
- First full web run: 2,185 tests, 2,158 passed, 27 skipped, zero failures.
  Production build passed. Store/manifest parity checks: 17 passed.
- Full core suite: 17,648 passed, five failures, 13 warnings. Two failures caused
  by the new core dependency and updated gate message were repaired; their 24
  focused tests then passed. Three failures are in unchanged files:
  - `doctor: any other launch failure was misdiagnosed:` followed by
    `Playwright chromium is installed but failed to launch: Target page, context or browser has been closed`
  - `raw NUL byte in tracked text file(s): web/public/vendor/bentopdf/freetext-script.js:1`
  - `hand-rolled recursive directory walkers found.` The reported function is
    `web/src/lib/document-store.mjs: historyFiles()`.
  Full run log: `/tmp/unified-context-root-tests.log`.
- Final integration retained the newer ATS/API and saved-scan job-description
  prefetch behavior. A combined Context/prefetch regression and the related
  suites passed all 72 tests. The full web suite after integration passed 2,180
  of 2,208 tests, with 28 skips and no failures. Production build and typecheck
  passed. No paid model runs were made.
- Final review covered fresh evidence, uncertainty boundaries, stale allowlists,
  complete large-input transport and broken-library rejection. No actionable
  findings remained after the fixes and targeted regression checks.
- Final production-browser run passed all five scenarios, covering the unified
  hierarchy, draft recovery/conflicts, purpose changes, mobile navigation,
  invalid libraries and local link titles. Rich/source switching and edit/undo
  preserve original source bytes without an automatic save. At 1280 px both
  move buttons remain together and the page has no horizontal overflow.
