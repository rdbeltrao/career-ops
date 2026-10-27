# CV palettes and test-warning audit

## Design

Replace the single accent-color input with twelve named, coordinated palettes plus a template-default choice. Each palette sets the existing accent_color, secondary_color, tag_color, tag_bg and tag_border theme tokens. Fonts, text size and unrelated profile settings stay independent. Existing custom colors remain visible as a custom palette until the user chooses another; viewing settings never changes saved colors.

Palette colors use dark foregrounds on white paper and pale tag backgrounds. Check foreground contrast against white and each tag background using the WCAG relative-luminance formula and a 4.5:1 minimum: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html. These checks cover palette tokens, not an accessibility certification of every template.

Reuse the current profile writer, theme injection and canonical CV renderer. The core palette registry and browser mirror must have exact parity. Older callers that submit only the original three style controls must preserve existing advanced color tokens. New clients submit all five color tokens when applying or resetting a palette.

## Warning inventory

The previous full suite reported thirteen warnings: nine original upstream-author name/domain/email references in repository scripts and the Vietnamese README; two intentionally disabled H1B live API/token-mint tests; one intentional fallback of 22 example boards to the agent; and one unreachable Git identity fixture leaving snapshot recording untested.

Audit each owning source. Fix real gaps and distinguish expected informational notices from actionable warnings. Do not weaken privacy checks broadly, enable network tests merely to silence a notice, consume service quotas, or hide unavailable coverage.

## Tasks

1. Core palettes and preferences: failing tests first; twelve unique palettes, contrast checks, exact browser/core parity, legacy CSS and old-client preservation, profile save/reload, and full coordinated color roundtrip.
2. Gallery: replace accent picker with accessible named swatch cards, show current custom colors without overwriting them, keep template defaults, preserve font and text-size controls, and verify preview plus explicit save/reload on desktop and mobile.
3. Warning audit: explain all thirteen warnings with source references, repair deterministic Git fixture coverage and privacy false positives where evidence supports it, and keep optional live-service skips visible as informational notices.
4. Review and verification: independent spec and code review, focused checks, full core/web suites, TypeScript, build, browser/API/PDF palette validation using scratch data. Commit the completed logical changes. Publish only within the user's existing authorization.

## Verification evidence

- Core/preferences/real-preview checks: 24 tests passed, including all twelve palettes, contrast ratios, five-token rendering, serif and ATS layouts, older three-key clients, custom CSS and typography preservation.
- Browser regression passed against an isolated server. Manual desktop (1440px) and mobile (390px) checks found no horizontal overflow; explicit save and reload retained the selected palette. The rendered iframe contained the sample text, selected colors and page padding.
- The real API saved, reloaded and previewed every palette against a scratch profile. Unrelated profile fields, typography, margins and advanced colors from older clients survived.
- All twelve real PDFs rendered as one-page samples with expected text and accent colors, independently checked with pdfplumber. The data root, profile and tracker were pinned to disposable directories before importing the renderer.
- TypeScript and the production build passed. The build retains ten existing Turbopack warnings: `Dynamic filesystem access causes tracing of the whole project`.
- Web suite: 2,340 passed, zero failed, 39 optional tests skipped. Full-suite and warning-review outcomes are recorded in the audit report after final verification.
- Independent palette spec and quality reviews passed. The warning spec review found mismatched BRE/literal matching; its regression was reproduced and fixed before final verification.
