# Test warning audit — 2026-10-27

The previous full run (`/tmp/career-ops-main-push-final.log`) reported 17,752 passing assertions, zero failures, and 13 warnings. All 13 warnings were investigated. One exposed a real test-coverage gap; the remaining 12 were public project references or expected test modes.

## Inventory and disposition

| Count | Source | What the warning meant | Verdict and change |
| --- | --- | --- | --- |
| 6 | `.github/scripts/ci-approve.mjs`, `.github/scripts/direction-gate.mjs`, `.github/scripts/gfi-handoff.mjs`, `.github/scripts/triage.bundle.mjs`, `.github/workflows/direction-gate.yml`, `.github/workflows/gfi-handoff.yml` | The privacy check found the upstream maintainer's given name in project governance comments, maintainer-decision messages, and the generated triage policy. | Reviewed public upstream policy references, not candidate data. Preserve their attribution and approve only the exact reviewed matching lines in these exact paths. |
| 3 | `README.vi.md` | The privacy check separately found the upstream author's given name, public portfolio domain, and public contact address. | Reviewed author credits, project article links, the public Product Hunt badge, and public contact information in the Vietnamese README. Preserve the credits and approve only the exact reviewed matching lines. |
| 1 | `tests/plugins/h1b-sponsor.test.mjs` | Optional live API tests were disabled because `H1B_API_TEST` was not enabled. | Expected opt-in integration skip. Print an informational `SKIPPED` notice that explicitly says live service behavior remains unverified. Do not enable network tests to silence it. |
| 1 | `tests/plugins/h1b-sponsor.test.mjs` | Optional live token mint was disabled because `H1B_MINT_TEST` was not enabled. | Expected opt-in integration skip. Print an informational `SKIPPED` notice retaining the two-keys-per-address-per-day budget warning and the unverified mint coverage. No keys were minted. |
| 1 | `tests/providers/example-portals-routable.test.mjs` | 22 enabled template boards use `scan_method` and are handed to the agent instead of fetched through a provider. | Supported fallback behavior, not a missing route. Keep the count and explanation visible as information. Unknown providers and new silently skipped entries still fail. |
| 1 | `tests/updater-branch-guard.test.mjs` | Git inferred an operating-system identity despite the fixture clearing configured names and identity environment variables. The missing-identity snapshot check therefore never exercised its failure case. | Real coverage gap. Set `user.useConfigOnly=true` in the disposable repository, assert that the unpinned negative control cannot commit, and verify that the updater's pinned snapshot identity still records the staged update. Unexpected negative-control success now fails the test. |
| **13** | | | **All prior warnings accounted for.** |

## Privacy-check boundary

The deterministic secrets scanner reported no issues in the seven public-reference files before they were inspected. No upstream source files or credits were edited.

`tests/helpers/public-upstream-references.mjs` records SHA-256 digests for each reviewed file, diagnostic pattern, and matching line. The privacy check exempts a match only when every matching line in that exact file was reviewed. It does not add a whole-file or basename allowance. A changed line, new candidate statement, unrelated diagnostic pattern, or similarly named nested path remains reportable. Line endings are normalized so the same reviewed lines work in both LF and CRLF checkouts.

The existing diagnostic patterns use Git basic regular expressions, including wildcard dots in the domain patterns. The scanner explicitly requests that mode with `git grep -G`. Approval uses the same wildcard meaning for the reviewed subset of ASCII letters, `@`, and dots, and fails closed for any other syntax. This prevents an approved literal domain elsewhere in a file from hiding a new near-domain statement that Git also matches.

The existing privacy-pattern inventory and older allowances are unchanged. This work narrows the treatment of the nine reviewed warnings; it does not claim to detect arbitrary new personal information beyond the existing patterns.

## Verification

- New privacy regression: initial missing-helper run failed; all 59 final assertions passed. Candidate-data injection and edited references fail approval for every reviewed case. A separate CRLF regression first produced nine failures and then passed after line-ending normalization. Review also found a literal-versus-BRE mismatch: ten near-domain injections first reproduced the exemption bug and then passed after matching semantics were aligned, with real Git BRE controls for ASCII, control-character, and Unicode wildcard matches.
- Missing-identity regression: first reproduced `no-identity negative control unexpectedly created a commit without a configured identity`; after making the fixture deterministic, all 27 branch-guard assertions passed.
- H1B sponsor suite: 169 assertions passed, zero failures, zero warnings. Both optional integration skips remain explicit in the output.
- Example portal reachability suite: four assertions passed, zero failures, zero warnings. The 22 agent handoffs remain explicit in the output.
- No production updater behavior changed. Git's documented [`user.useConfigOnly`](https://git-scm.com/docs/git-config#Documentation/git-config.txt-useruseConfigOnly) setting disables identity guessing for the negative control.

## Remaining coverage limits

The optional H1B live API and token mint paths were not run. They retain their opt-in gates and remain unverified against the live service in this run. Agent handoff reachability does not prove that every external board can be fetched successfully. The portal suite also retains its pre-existing single-entry `KNOWN_SILENT` ratchet for Vinted; it is outside the 13 warnings and still rejects any additional silently skipped entry.

## Combined verification

The final combined run passed 17,820 assertions with zero failures and zero warnings across 898 discovered suites plus the inline checks. Both optional H1B skips and the 22-board agent handoff remain visible as informational output.

The web suite passed 2,340 tests with zero failures and 39 optional skips. TypeScript and the production build passed; the build retains ten pre-existing Turbopack warnings, `Dynamic filesystem access causes tracing of the whole project`, separate from the thirteen test warnings audited here. Independent spec and code-quality reviews passed after the BRE matching regression was fixed.
