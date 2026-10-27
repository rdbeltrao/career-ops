# Runtime filesystem tracing

## Diagnosis and design

Ten Turbopack diagnostics identify one deployment-tracing problem across four modules: one CV Studio HTML read; five document-store output/history/lock paths; three workspace path/stat/read operations; and one PDF-worker fallback input path. These are intentional runtime reads from a configurable data root, which may be outside the checkout. They must remain available at runtime and must not expand build-time dependencies to the whole app.

The previous production build contains 56,654 trace entries across 94 manifests, including eight references each to AGENTS.md and next.config.mjs and 2,125 project test-source references. This is real over-tracing, not merely noisy diagnostics. It is not evidence that a deployment or disclosure occurred.

Use narrowly placed `turbopackIgnore` annotations on the dynamic runtime path accesses identified by the compiler, preserving validation, containment, symlink checks, locks and errors. Do not disable tracing globally, change the bundler, exclude actual dependencies, or relocate user data. Next's upstream fix documents the annotation semantics: https://github.com/vercel/next.js/pull/95144. Read the installed Next output guide before implementation.

## Tasks and acceptance

1. Reproduce with an artifact regression against the existing production build; it must reject unrelated instructions, configuration and test sources in deployment manifests.
2. Annotate the four owning modules and explain the runtime-data boundary. Rebuild; all ten diagnostics must disappear and the real artifact regression must pass.
3. Verify document history/restore, workspace reads and PDF-worker inputs against scratch roots, including existing unsafe-path and malformed-file cases. Run TypeScript and full suites.
4. Independent spec review followed by quality review; record measured trace changes, tests and remaining limits. Commit and push within existing main authorization.

## Original warning inventory

| Module | Count | Runtime operations incorrectly treated as build dependencies |
| --- | --- | --- |
| `web/src/lib/cv-studio/server.ts` | 1 | Reading validated tailored HTML in `loadStudio`. |
| `web/src/lib/document-store.mjs` | 5 | Joining the selected output PDF path; listing version history; checking each version entry; listing recovery directories; checking document lock paths. |
| `web/src/lib/workspace-files.mjs` | 3 | Walking a workspace path; checking document size; reading document bytes. |
| `web/src/lib/pdf-worker-inputs.mjs` | 1 | Resolving legacy candidate inputs under the configured data root. |

## Verified result

All ten diagnostics disappeared after annotating those runtime accesses. The artifact regression still found thirteen unrelated CV test files in the ingest route; the same runtime boundary needed an annotation on its temporary upload filename (`cv${ext}`). The final route change affects that upload path only; canonical procedure loading remains unchanged.

The final artifact check reports 34,756 trace entries across the same 94 manifests, down from 56,654. Project instructions, Next configuration source and project test sources each have zero remaining entries. These are manifest-entry counts, not a measurement of deployment bytes.

The artifact test runs automatically through npm's postbuild hook and honors `BUILD_DIST`; an explicit `CAREER_OPS_TRACE_BUILD` can check existing builds. It uses the core `listTree` walker so nested checkouts and symlinks are handled by the repository's shared policy. See https://docs.npmjs.com/cli/v11/using-npm/scripts/ for lifecycle hooks.

The regression first failed against the prior production build with `Unrelated project files included in deployment traces` (2,141 entries), then caught the thirteen residual upload-path entries, and now passes. The full suite also caught a forbidden recursive readdir in the first test implementation; replacing it with `listTree` passed all twenty walker tests. No guard was weakened.

Web verification: 2,342 passed, zero failed, 39 optional skips, including the production artifact test. TypeScript passed. The final fresh production build ran its automatic postbuild artifact check successfully and emitted zero warnings. Production CV Studio and workspace reads loaded synthetic files from a scratch root outside the checkout; PDF save, version history, version restore, deletion and recovery also passed through the compiled HTTP routes, preserving exact recovered bytes.

Final full suite: 17,821 assertions passed, zero failed, zero warnings across 898 discovered suites plus inline checks. Independent spec and quality reviews passed. Optional external-service tests retain their existing opt-in gates. No live candidate files, credentials or application records were read for this QA or changed.
