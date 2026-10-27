# Optional Cover-Letter Implementation Plan

> **For agentic workers:** Use subagent-driven development for bounded implementation and independent review. Each task starts with a failing regression test.

**Goal:** Draft from Context and JD with one optional instruction prompt.

**Architecture:** Keep the existing cover request parser and worker flow. Update the
canonical cover mode and its headless adapter together so no hidden gate survives.

**Tech Stack:** React, Next.js, plain JavaScript modules, Node test runner, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-27-optional-cover-letter-design.md`

## Global Constraints

No new dependencies, candidate-data edits, automatic submissions, or PDF behavior changes.
Scan workspace files before reading. Preserve unrelated working-tree edits.

## Review Focus

- Missing/null/whitespace prompts must draft without validation gates.
- Non-string/array/oversized input must fail without truncation or coercion.
- Extra instructions must not launder new past-experience claims or override safeguards.
- Current Context facts remain authoritative; stale summaries cannot replace them.
- Redrafting retains optional direction and failed runs retain visible retry feedback.

## Task 1: Optional form and request contract

**Files:** `web/src/components/cover-draft-button.tsx`,
`web/src/lib/cover-brief.mjs`, `web/tests/lib/cover-brief.test.mjs`,
`web/tests/lib/cover-draft.browser.test.mjs`.

**Interface:** `parseCoverRequest(...)` returns the existing result shape with
`brief: { instructions: string }`; the job store passes that same record.

- [x] Add failing tests for absent/null/blank/trimmed instructions, malformed and
  oversized inputs, report validation, and one optional form control.
- [x] Implement normalization and replace questionnaire with one textarea.
- [x] Run request regressions and browser empty/custom/redraft/mobile checks.
- [x] Review specification compliance and code quality independently.

## Task 2: Canonical drafting specification and headless prompt

**Files:** `modes/cover.md`, `web/src/lib/run-prompts.mjs`,
`web/tests/lib/run-prompts.test.mjs`, `tests/cover-mode-optional-input.test.mjs`,
`web/tests/lib/context-library-prompts.test.mjs`, `tests/context-evidence-tier.test.mjs`,
`tests/cover-letter-user-inputs.test.mjs`, `test-all.mjs` (existing contract assertions).

**Interface:** `buildPrompt` consumes optional `{ instructions: string }` and
the existing report/Context arguments. No route or renderer contract changes.

- [x] Add failing prompt/mode tests for unattended Context/JD inference, concise
  structure, quoted optional direction, no forced questionnaire, and safeguards.
- [x] Update the canonical mode and adapter consistently, retaining PDF approval.
- [x] Run focused tests, Context integration regressions, web and root suites,
  typecheck, build, and independent final review; fix material findings.
- [x] Commit only task changes as one logical feature commit; leave unrelated work intact.

## Execution evidence

- Request tests: RED 6 failures, then GREEN 8/8. Draft/mode regressions: RED 8
  failures, then GREEN; a later PDF Context-source regression also went RED to GREEN.
- Final focused mode/request/Context checks: 99 passed. Updated legacy source and
  optional-input contract suites: 36 passed with an explicitly disposable data root.
- Browser: 1 passed, exercising blank/custom prompts, active runs, failed and weak
  drafts, retries, redrafting, retained direction, and mobile layout. `/api/run`
  was intercepted; no real AI generation or application submission occurred.
- Web suite: 2,348 passed, 0 failed, 41 skipped environment-gated browser cases.
- Typecheck passed. Production compilation, typecheck, static generation and
  runtime tracing passed. Initial build encountered TS2306 because the existing
  development `.next/dev/types/routes.d.ts` was not a module. The successful
  build temporarily scoped TypeScript inputs to source
  and its own generated types, then restored the original tracked configuration.
- Independent task and final reviews passed with no actionable product findings.
- Initial full repository run: 17,824 passed, 3 failed. Two assertions still
  expected the removed mandatory-answer wording; both were updated and passed.
  The data-root guard also observed live private-data changes during its snapshot
  window; the rerun uses an explicitly disposable data root. No private data was
  edited to resolve that guard.
- Final full repository rerun: **17,826 passed, 0 failed, 0 warnings**, exit 0,
  using an explicitly disposable data root. Final tracked Next.js and TypeScript
  configuration matches its initial state. All changed files scanned clean.
- Completion: keep one local feature commit; no push, merge or pull request was
  needed for the requested local implementation. No deferred review findings.
