# CV template preferences

## Design

Expose the existing HTML CV templates as a gallery beside the CV draft. Let users save a default template, accent color, font and text size. Reuse `cv.template` and `style` in the resolved user profile so CLI and web output share settings. Keep unrelated profile fields and reject malformed documents or stale saves.

Allow optional ATS-specific template overrides. Resolution order is an explicit run choice, saved ATS override, opt-in documented ATS guidance, then the saved default. Only Greenhouse gets automatic guidance initially: its documentation identifies columns, graphics and complex layouts as parsing risks. Other vendors keep the user's default unless configured. ATS guidance is advisory, not a parsing guarantee.

Evidence: https://support.greenhouse.io/hc/en-us/articles/200989175-Unsuccessful-resume-parse and https://help.lever.co/s/article/Understanding-Resume-Parsing. Existing `cv-templates.mjs`, `ats-vendor.mjs`, `theme-style.mjs` and the bundled Next.js route/component guides define implementation conventions.

Previews use synthetic example content rendered through the real builder. They never read or generate candidate facts. Existing PDFs retain their layout until regenerated. Existing content editors continue editing their current document.

## Tasks and acceptance

1. Core preferences (`lib/cv-template-preferences.mjs`, `tests/cv-template-preferences.test.mjs`): begin with failing tests for discovery, precedence, URL detection, validation, profile preservation, missing/malformed configuration and stale revisions. Implement shared preference reads, writes and selection using core template discovery and ATS detection.
2. Gallery (`web/src/components/cv-template-settings.tsx`, CV workspace integration): offer named templates, real previews, style controls, default saving and per-ATS overrides. Loading and save failures must remain visible; no background preference writes. Verify controls with browser scenarios.
3. Web orchestration (`web/src/app/api/cv-templates/route.ts`, `web/src/lib/cv-template-preview.mjs`, `web/src/lib/core/cv-template.mjs`, PDF run route): begin with failing integration tests, expose settings/preview endpoints and pass selected template through canonical rendering using the resolved data/profile paths. Add a discoverable template-settings link at the PDF action.
4. Verification: run focused tests, full core/web suites, TypeScript and production build. Run browser checks against scratch data, including save/reload, style preview, ATS override and malformed-profile behavior. Review specification compliance and code quality independently with bounded review agents.

## Assumptions

“Formats” means visual CV layouts, with PDF remaining the existing downloadable output. No DOCX generator is requested. Template selection provides multiple styles already shipped by the project. Saved settings apply to future generation; changing a style does not rewrite existing CV content or submitted documents.

## Delivery boundary

The working tree already contains unrelated work, including PDF pipeline fixes. Preserve it, avoid broad staging, and do not publish or deploy. Commit only task-owned changes when they can be separated safely.

## Verification completed

- Core suite: 17,752 passed, zero failures, 13 warnings. Ran with an explicit scratch data root to avoid unrelated activity in the live UI logs.
- Web suite: 2,337 passed, zero failures, 39 optional browser scenarios skipped by the default runner. The template browser regression ran separately and passed, including save failure recovery, save/reload, ATS overrides, sample preview scaling and 390px mobile layout.
- Production build and TypeScript passed. The build retains its 10 existing dynamic-filesystem tracing warnings.
- Real settings API checks passed for all eight installed template previews, legacy CSS values, save/reload, profile-field preservation, recoverable backups, stale revisions and malformed-profile protection.
- A real synthetic PDF rendered with the selected ATS layout, a relative profile override in a separate data root, legacy CSS and a serif font. PDF text extraction confirmed exact comma-delimited skills and retained candidate text.
- Independent specification and quality reviews passed after fixing legacy CSS validation, preview environment isolation, ATS payload preparation and absolute profile propagation to child processes.
- Removed the explicitly confirmed demo password placeholder from the example profile; deterministic secret scan is clean.

Existing user edits were preserved. No deployment or publication was performed. Changes remain in the working tree because the shared PDF pipeline already contained uncommitted work on which the integration depends.
