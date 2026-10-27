# Provider and model configuration

## Design

Config selects an installed AI tool and keeps a provider/model choice for each
tool. Empty values deliberately inherit that tool's own configuration. Claude
Code, Codex, Gemini CLI, and OpenCode support explicit models. OpenCode supports
provider-qualified model IDs; Codex supports configured providers and local
Ollama/LM Studio providers. Other tools retain their existing defaults.

Choices are saved in the resolved user data root at `data/ai-settings.json`.
This follows the existing User Layer boundary and avoids editing global CLI
configuration or storing credentials. The browser keeps its existing appearance
preferences and CLI compatibility value only after a successful save. Saved
server settings take precedence over stale browser CLI choices.

Every web AI subprocess reads the saved model for the CLI actually running at
the shared spawn boundary, before prompt transport and permission fencing.
Arguments remain structured arrays; no shell command is constructed. Invalid
saved settings stop a run and remain available for repair instead of silently
falling back to a different model. Existing missing-CLI fallback remains intact.

Assumptions: authentication stays in the installed tools; model suggestions do
not establish account access; custom model IDs are supported; scanner schedules
do not call models and need no model setting. Existing Claude-only application
automation retains its documented tool constraint.

Evidence: [Claude model configuration](https://code.claude.com/docs/en/model-config),
[Codex CLI](https://developers.openai.com/codex/cli/reference),
[OpenCode CLI](https://opencode.ai/docs/cli/), and the installed tools' help.

## Tasks and acceptance

1. Add `web/src/lib/ai-settings.mjs`, `ai-settings-store.mjs`, and their tests.
   Begin with failing tests. Verify strict schema validation, custom IDs,
   per-tool flags, prompt preservation, missing versus corrupt files, and data
   root parity using scratch directories.
2. Add Config provider/model fields in `web/src/components/config-form.tsx`
   and `ai-model-fields.tsx`. Begin with failing wiring tests. Verify per-tool
   choices survive tool switches and reload; save errors never claim success;
   default mode clearly inherits the tool's own settings.
3. Add `/api/ai-settings`; integrate `clis.ts`, `saved-cli.ts`, `/api/clis`,
   and `spawn-cli.mjs`. Begin with failing spawn integration tests. Verify saved
   overrides reach Claude CV generation and all shared workers before fencing,
   while credentials and global settings remain untouched.
4. Review specification compliance and code quality. Run the full web and root
   test suites, TypeScript checks, a production build, and browser scenarios
   with intercepted AI launches so verification consumes no model credits.

## Delivery constraint

The shared checkout already contains unrelated edits. Preserve them, and stage
only this feature's files when preparing the feature commit.

## Verification

- Full web suite: 2,307 passed, 37 skipped, zero failed (2,344 tests).
- Targeted settings, API, worker, CLI synchronization and UI wiring checks:
  55 passed. TypeScript check and isolated production build passed.
- Browser checks against a disposable data root passed: Claude model save and
  reload, independent Claude/Codex selections, OpenRouter custom model save and
  reload, failed-save preservation, invalid-load save blocking, appearance save
  with no installed tool, and mobile viewport layout. No model API was called.
- Independent specification and code-quality reviews passed after repairing the
  appearance-save regression identified in review.
- Root `node test-all.mjs --quick --jobs 4`: 17,729 passed, 5 failed,
  13 warnings. Failures were updater registration for the separate listing-merge
  work, its missing core-script argv probe, the separate `needs_review` state
  classification, a web subprocess run while tests were being edited, and the
  real-data-root guard detecting writes to the running UI's log. The full web
  subprocess was rerun independently from the repository root and passed as
  recorded above. Root failures were not hidden or fixed as unrelated changes.
