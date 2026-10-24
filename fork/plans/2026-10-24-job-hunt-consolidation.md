# job-hunt 2.0 Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `rdbeltrao/career-ops` fork the single job-search system: Jev-scored pre-screens, a structured candidate context that every evaluation and draft reads, drafts bound by the factual rules, and job-hunt's LinkedIn fetch feeding the pipeline.

**Architecture:** career-ops keeps its shape (markdown prompts in `modes/`, deterministic `.mjs` scripts, the LLM decides the Global score). We add one deterministic scorer (`jev-score.mjs`) that every path calls before the LLM, one new user-layer context file (`modes/_context.md`) plus two documented `profile.yml` blocks that every loader injects, prompt edits in the draft modes, and a Python feeder in job-hunt that writes pipeline rows and JD files into the career-ops data root.

**Tech Stack:** Node 22 (built-in `fetch`, `node:test`), existing deps only (`js-yaml`, `playwright`, `undici`, `dotenv`); Python 3.12 + `uv` + `pytest` in job-hunt; OpenRouter decisions API (`typesafe/jev-1.13`) with chat-completions fallback.

**Spec:** `fork/specs/2026-10-24-job-hunt-consolidation-design.md`

## Global Constraints

- Node engine stays `^22.13.0 || >=23.4.0`; no new npm dependency.
- Personal data never enters the career-ops checkout. The data root is `~/Projects/job-hunt-private` (`CAREER_OPS_DATA_DIR`). Every new user-layer file is declared in `USER_PATHS` (`update-system.mjs`) and `DATA_CONTRACT.md`.
- Scripts resolve paths through `path-resolver.mjs` (`getCareerOpsRoot()`, `getProfilePath()`), never `__dirname`, for anything in the user layer.
- Scores: the LLM Global score stays 1-5 and holistic (`modes/_shared.md`). Jev reports `fit` 0-100, `verdict` apply|maybe|skip, and its own `score` 1-5 computed as `round(1 + 4 * fit / 100, 1)`. The two are shown side by side and never averaged.
- Jev `skip` with a blocking answer is a hard stop before Block A unless the run says "evaluate anyway"; blocking answers are `seniority_match` in {below, above}, `location_ok` = no, `language_blocker` = missing, `stack_fit` = required_mismatch.
- Pipeline rows: new labeled segment `| jev: {fit} {verdict} — {reasons}` rides last, after `rank:`. Never filters, reorders or deletes a row. Idempotent on `| jev: `.
- Machine Summary gains `jev:` (object or `null`). Report header gains `**Jev:** {score}/5 (fit {fit}, {verdict})` or `**Jev:** not run` directly under `**Score:**`.
- `modes/_context.md` is a targeting source, never evidence: it is not added to `verify-cv-facts.mjs` sources.
- Interests and preferences carry `confirmed_on`; older than 90 days means the mode says so and asks before they decide a verdict or a draft paragraph.
- Drafts never send, submit, connect or post. Jev never submits anything. The Notion sync writes only local files after a shown diff.
- Tests: `node --test <file>` per task; `node test-all.mjs --quick` and `npm run lint` before any merge. Python: `uv run pytest`.
- Commit messages in plain prose, conventional prefix (`feat:`, `fix:`, `docs:`, `test:`).

## Review Focus

1. A pipeline row with no JD anywhere (no feeder file, ATS API returns nothing): `jev-rank.mjs` must leave the row un-annotated and count it, never write `jev: 0`. Pinned in Task A5.
2. OpenRouter answers HTTP 404 "No allowed providers are available": `jev-score.mjs` must fall back to chat completions, mark `fallback: true`, and keep going for the rest of a batch. Pinned in Task A3.
3. A JD longer than 6000 characters: the state sent to Jev is cut at 6000 with `[truncated]`, never the whole posting. Pinned in Task A3.
4. `modes/_context.md` absent (fresh install): every loader and `jev-score.mjs` must run as before, with a one-line notice, not fail. Pinned in Tasks A3 and B4.
5. Feeder run twice on the same `out/jobs.jsonl`: `data/pipeline.md` gains no duplicate rows and `data/jd-index.tsv` no duplicate URLs. Pinned in Task D1.

---

## File ownership (parallel tracks)

Four tracks run in parallel on their own branches and never edit the same file. The orchestrator merges in the order A, B, C and then registers C's new modes in the router (Task M1).

| Track | Branch | Owns (create or modify) |
|---|---|---|
| A: Jev core | `feat/jev-score` | `lib/openrouter-key.mjs`, `lib/jev-criteria.mjs`, `lib/jd-store.mjs`, `jev-score.mjs`, `jev-rank.mjs`, `config/jev-criteria.example.yml`, `calibrate.mjs`, `docs/JEV.md`, `tests/jev-*.test.mjs`, `tests/jd-store.test.mjs`, `tests/openrouter-key.test.mjs`, `tests/fixtures/jev/` |
| B: context + loaders | `feat/context-layer` | `config/profile.example.yml`, `modes/_context.template.md`, `render-context.mjs`, `notion-sync-apply.mjs`, `modes/notion-sync.md`, `modes/_shared.md`, `modes/oferta.md`, `modes/auto-pipeline.md`, `modes/triage.md`, `modes/pipeline.md`, `modes/_brief.template.md`, `batch/batch-prompt.md`, `batch/batch-runner.sh`, `openrouter-runner.mjs`, `openai-eval.mjs`, `gemini-eval.mjs`, `ollama-eval.mjs`, `web/src/lib/run-prompts.mjs`, `web/src/lib/machine-summary.mjs`, `.agents/skills/career-ops/SKILL.md`, `AGENTS.md`, `DATA_CONTRACT.md`, `update-system.mjs`, `doctor.mjs`, `tests/render-context.test.mjs`, `tests/notion-sync-apply.test.mjs`, `tests/context-loaders.test.mjs` |
| C: drafts + LinkedIn modes | `feat/drafts-linkedin` | `modes/apply.md`, `modes/cover.md`, `modes/email.md`, `modes/contacto.md`, `modes/interview-prep.md`, `modes/followup.md`, `modes/_writing.md`, `modes/network.md`, `modes/engage.md`, `network-plan.mjs`, `templates/outreach.md`, `templates/posts.md`, `data-static/ats-notes.md`, `docs/LINKEDIN.md`, `tests/network-plan.test.mjs`, `tests/draft-modes-context.test.mjs` |
| D: feeder (job-hunt repo) | `feat/pipeline-export` in `~/Projects/job-hunt` | `jobs/pipeline_md.py`, `jobs/cli.py`, `README.md`, `tests/test_pipeline_md.py` |
| O: orchestrator | data root and merges | everything under `~/Projects/job-hunt-private`, `.env` and `config/local-paths.txt` in the checkout, router entries for `network` and `engage`, tracker import |

## Shared interface contracts (read before any track starts)

**C1. `jev-score.mjs` CLI.**
`node jev-score.mjs --job <file.json | -> [--context <path>] [--criteria <path>] [--format json|markdown|segment] [--model <id>] [--timeout-ms N]`
- Job JSON: `{ "url", "title", "company", "location", "workplace", "seniority", "description", "salary"?, "posted_date"? }`. Unknown keys ignored.
- Context default: `{DATA_ROOT}/modes/_context.md`; when absent, the context is `cv.md` followed by the `profile.yml` text, and stderr gets `jev-score: modes/_context.md not found, using cv.md + profile.yml`.
- Criteria default: `{DATA_ROOT}/config/jev-criteria.yml`, else `config/jev-criteria.example.yml` in the checkout.
- stdout `json` (default):
  ```json
  { "model": "typesafe/jev-1.13", "fit": 79, "score": 4.2, "verdict": "apply",
    "reasons": { "seniority_match": "match", "location_ok": "yes", "language_blocker": "none", "team_type": "product", "stack_fit": "stack_agnostic" },
    "confidences": { "seniority_match": 0.91 }, "probabilities": {},
    "blocking": [], "fallback": false, "error": null }
  ```
  `fit` is `null` when Jev gave no usable number; `score` is then `null`. `blocking` lists `"{key}={label}"` strings for blocking answers.
- `markdown` prints the pre-screen block (C3). `segment` prints the pipeline segment text without the leading `| ` (C4).
- Exit codes: 0 scored; 2 no API key (stderr names `OPENROUTER_API_KEY`); 1 API or parse failure (`error` filled, other fields null).
- `--self-test` runs the in-memory suite with no network.

**C2. Key resolution (`lib/openrouter-key.mjs`).** `resolveOpenRouterKey({ env = process.env, codeRoot, dataRoot, keychain = defaultKeychain }) -> { key: string|null, source: string }`. Order: `env.OPENROUTER_API_KEY_JOB_SEARCH`, `env.OPENROUTER_API_KEY`, `.env` at `codeRoot`, `.env` at `dataRoot` (same two names, in that order), macOS Keychain via `security find-generic-password -a $USER -s <name> -w` for the two names. `source` is one of `env`, `code-env`, `data-env`, `keychain`, `none`. Never logs the key.

**C3. Pre-screen block (markdown, injected into prompts).**
```
## Calibrated pre-screen (Jev)

model: typesafe/jev-1.13 | fit: 79/100 | jev_score: 4.2/5 | verdict: apply
seniority_match: match (0.91) | location_ok: yes (0.88) | language_blocker: none (0.95) | team_type: product (0.70) | stack_fit: stack_agnostic (0.66)
blocking: none
```
When not run: `## Calibrated pre-screen (Jev)\n\nnot run: {reason}`.

**C4. Pipeline segment.** `jev: {fit} {verdict} — {reasons}` where reasons is `seniority {v}, location {v}, language {v}, {team_type}, stack {v}` with underscores turned into spaces, capped at 140 characters through `sanitizeMarkdownField` from `scan.mjs`. Label constant `| jev: `. Order after `rank:`.

**C5. Machine Summary `jev:` block (YAML, in `batch/batch-prompt.md` schema).**
```yaml
jev:
  model: "typesafe/jev-1.13"
  fit: 79
  score: 4.2
  verdict: "apply"
  blocking: []
  reasons:
    seniority_match: "match"
    location_ok: "yes"
    language_blocker: "none"
    team_type: "product"
    stack_fit: "stack_agnostic"
```
`jev: null` when not run.

**C6. JD store (`lib/jd-store.mjs`) and feeder files.**
- JD file: `{DATA_ROOT}/jds/feeder/{source}-{source_id}.json`, body is the job object of C1 plus `source`, `source_id`, `first_seen`, `search_name`.
- Index: `{DATA_ROOT}/data/jd-index.tsv`, header `url\tpath\tsource\tsource_id\tfirst_seen`, `path` relative to the data root, append-only, one row per URL.
- `readJdForUrl(url, { dataRoot }) -> job|null` matches the URL string exactly, then with a trailing slash added or removed.
- `writeJd(job, { dataRoot }) -> { path, appended: boolean }` (used by tests and by a later Node port of the feeder; the Python feeder writes the same files).

**C7. Feeder pipeline row (Python, `jobs/pipeline_md.py`).**
`- [ ] {url} | {company} | {title} | {location} | {salary} | posted: {YYYY-MM-DD} | note: {source} {search_name}`
- Positional cells: when `salary` is empty the row stops after `{location}`; when `location` is empty and `salary` is not, the location cell is present and empty.
- Field sanitising mirrors `sanitizeMarkdownField`: collapse whitespace and newlines to one space, `|` to `/`, `[` and `]` escaped with a backslash. The URL gets `|` as `%7C`.
- `posted:` omitted when `posted_date` is empty; `note:` always present.

**C8. `profile.yml` blocks (documented in `config/profile.example.yml`).**
```yaml
dealbreakers:
  - "German required"
preferences:
  confirmed_on: "2026-10-17"
  hard_rules: ["..."]
  minus: ["..."]
  neutral: ["..."]
  plus: ["..."]
  no_penalty: ["..."]
interests:
  recorded_on: "2025-01-01"
  confirmed_on: "2026-10-17"
  role_balance: "about 75% people management, 25% hands-on"
  team_size: "6 to 10 engineers directly, or several teams through leads"
  team_type: ["customer-facing product teams"]
  domains: ["marketplaces", "health"]
  ways_of_working: ["remote-first", "continuous delivery"]
  learning: ["..."]
```

**C9. `render-context.mjs`.** `node render-context.mjs [--profile <path>] [--today YYYY-MM-DD] [--section preferences|interests|dq|all]` prints markdown: `## Preferences (confirmed {date}{, STALE: reconfirm before deciding})`, `## Interests (recorded {date}, confirmed {date}{, STALE ...})`, `## Hard DQ` (one bullet per `dealbreakers` and `preferences.hard_rules` entry). Export `renderContext(profileObject, { today }) -> string` and `isStale(dateStr, today, days = 90) -> boolean`.

**C10. Headless Jev gate in `batch/batch-runner.sh`.** New flags `--min-jev N` (skip the worker when Jev `fit` < N) and `--skip-jev-verdict skip|maybe` (skip the worker when the verdict is in the list). Both default off. When `jev-score.mjs` is missing or exits 2, the runner logs one line and spawns the worker as today. The pre-screen block (C3) is appended to the resolved system prompt as `## Runtime pre-screen: jev` for every spawned worker.

---

## Track A: Jev core

### Task A1: OpenRouter key resolution

**Files:**
- Create: `lib/openrouter-key.mjs`
- Test: `tests/openrouter-key.test.mjs`

**Interfaces:**
- Produces: `resolveOpenRouterKey(opts)` per C2; `parseDotEnv(text) -> Record<string,string>` (same regex as `openrouter-runner.mjs` `loadEnvFile`).

- [ ] **Step 1: Write the failing tests**

```js
test('env wins and names its source', () => {
  const r = resolveOpenRouterKey({ env: { OPENROUTER_API_KEY: 'k1' }, codeRoot: tmp(), dataRoot: tmp(), keychain: () => null });
  assert.deepEqual(r, { key: 'k1', source: 'env' });
});
test('OPENROUTER_API_KEY_JOB_SEARCH beats OPENROUTER_API_KEY', ...);   // key 'k2', source 'env'
test('code-root .env is read before data-root .env', ...);              // source 'code-env'
test('keychain is last and is asked for both names', ...);             // keychain stub records calls, source 'keychain'
test('nothing found returns null and source none', ...);
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/openrouter-key.test.mjs` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/openrouter-key.mjs`**

`defaultKeychain(name)` runs `execFileSync('security', ['find-generic-password', '-a', os.userInfo().username, '-s', name, '-w'])` inside try/catch and returns the trimmed stdout or `null`; on non-darwin it returns `null` without spawning.

- [ ] **Step 4: Run to verify pass** — `node --test tests/openrouter-key.test.mjs` Expected: PASS
- [ ] **Step 5: Commit** — `git add lib/openrouter-key.mjs tests/openrouter-key.test.mjs && git commit -m "feat: resolve the OpenRouter key from env, .env files and the macOS Keychain"`

### Task A2: Criteria file

**Files:**
- Create: `config/jev-criteria.example.yml`, `lib/jev-criteria.mjs`
- Test: `tests/jev-criteria.test.mjs`

**Interfaces:**
- Produces: `loadCriteria({ dataRoot, codeRoot, path? }) -> { preamble, questions, reasonQuestions, blockingAnswers, maxDescriptionChars, source }`; `validateCriteria(obj) -> string[]` (list of problems, empty when valid).
- YAML shape (port of job-hunt `jobs/scoring/criteria.py`, generic wording): `preamble: str`, `max_description_chars: 6000`, `questions: { fit: {type: noul, instructions}, verdict: {type: choice, instructions, criteria: {apply, maybe, skip}}, seniority_match: {... criteria: {below, match, above}}, location_ok: {... {yes, no, unclear}}, language_blocker: {... {none, missing, partial}}, team_type: {... {product, platform_infra, unclear}}, stack_fit: {... {required_match, desired_match, stack_agnostic, required_mismatch}} }`, `reason_questions: [seniority_match, location_ok, language_blocker, team_type, stack_fit]`, `blocking_answers: { seniority_match: [below, above], location_ok: [no], language_blocker: [missing], stack_fit: [required_mismatch] }`.

- [ ] **Step 1: Failing tests**: example file loads with `source` ending in `jev-criteria.example.yml`; a data-root file wins; `validateCriteria` rejects a missing `verdict` question and a `choice` question without `criteria`; the example's keys equal the list above.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Write the YAML (generic: "the candidate's level", "the profile's core stack", no personal facts) and the loader** using `loadYaml` from `lib/yaml-document.mjs`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat: add the Jev criteria file and loader`

### Task A3: `jev-score.mjs`

**Files:**
- Create: `jev-score.mjs`
- Test: `tests/jev-score.test.mjs`, fixtures `tests/fixtures/jev/answers-apply.json`, `answers-skip.json`, `answers-no-fit.json`, `error-404-providers.json`, `chat-fallback.json`

**Interfaces:**
- Consumes: A1 `resolveOpenRouterKey`, A2 `loadCriteria`.
- Produces: `buildState(profileText, job, criteria) -> object` (job description cut at `maxDescriptionChars` + `\n[truncated]`); `parseAnswers(data, criteria) -> result` (C1 shape minus `error`); `scoreToFive(fit) -> number|null` (`round(1 + 4*fit/100, 1)`); `blockingAnswers(reasons, criteria) -> string[]`; `isProviderBlocked(status, bodyText) -> boolean` (404 and body contains "allowed providers", case-insensitive); `scoreJob({ profileText, job, criteria, apiKey, fetchImpl = fetch, model, timeoutMs }) -> Promise<result>` which posts to `https://openrouter.ai/api/alpha/decisions` with `{ model, state, questions }` and, when `isProviderBlocked`, posts to `https://openrouter.ai/api/v1/chat/completions` with `response_format: { type: 'json_schema', json_schema: { name: 'jev_fallback', strict: true, schema } }` (schema from the criteria: `fit` integer 0-100, one enum per choice question, `*_confidence` numbers, `reasoning` string) and sets `fallback: true`, `model` to the chat model (`JOB_HUNT_SCORE_MODEL` or `anthropic/claude-haiku-5.5`); `formatPrescreenMarkdown(result) -> string` (C3); `formatJevSegment(result) -> string` (C4, empty string when `fit` is null); `loadContextText({ dataRoot, contextPath? }) -> { text, source }` (C1 fallback).
- CLI per C1, flags validated with `validateFlags` from `lib/cli-flags.mjs`.

- [ ] **Step 1: Failing tests** (fetch stubbed):
  - `buildState` truncates a 7000-char description to 6000 plus `[truncated]`.
  - `parseAnswers(answers-apply)` gives `fit 79`, `score 4.2`, `verdict apply`, five reasons, confidences, `blocking []`.
  - `parseAnswers(answers-skip)` gives `blocking ['seniority_match=below', 'location_ok=no']`.
  - `parseAnswers(answers-no-fit)` gives `fit null`, `score null`.
  - `scoreJob` with a fetch stub answering 404 + "No allowed providers are available" then a chat completion fixture returns `fallback true` and the chat model id.
  - `formatJevSegment` on apply fixture equals `jev: 79 apply — seniority match, location yes, language none, product, stack agnostic`.
  - `formatPrescreenMarkdown` on the no-fit fixture still prints the five reasons and `fit: n/a`.
  - `loadContextText` with no `_context.md` returns cv.md + profile text and `source 'cv+profile'`.
  - CLI: `node jev-score.mjs --self-test` exits 0; `--job` with no key exits 2 (run with `env: { PATH }` only and an empty temp data root).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Timeout 60 s via `AbortSignal.timeout`. User-Agent from `user-agent.mjs` `DEFAULT_USER_AGENT`. No retries.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat: add jev-score, a calibrated typed pre-screen through OpenRouter`

### Task A4: JD store

**Files:**
- Create: `lib/jd-store.mjs`
- Test: `tests/jd-store.test.mjs`

**Interfaces:** per C6. `readIndex(dataRoot) -> Map<url, row>`; `writeJd(job, { dataRoot })` creates `jds/feeder/`, writes the JSON, appends the index row only when the URL is new.

- [ ] **Step 1: Failing tests**: write then read back by exact URL; read matches with and without trailing slash; a second `writeJd` for the same URL does not append a second index row; a missing index returns `null`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat: add the feeder JD store and index`

### Task A5: `jev-rank.mjs`

**Files:**
- Create: `jev-rank.mjs`
- Test: `tests/jev-rank.test.mjs`

**Interfaces:**
- Consumes: `parsePendingEntries`, `applyAnnotations`, `selectBatch` from `rank-pipeline.mjs` (skip rows that already contain `| jev: `, not `| rank: `; write a local `parsePendingJev(text)` that mirrors `parsePendingEntries` with the `jev` label); `readJdForUrl` (A4); `scoreJob`, `formatJevSegment`, `loadContextText` (A3); `withPipelineLock` from `pipeline-lock.mjs`; `fetchJdViaKnownApi` from `browser-extract.mjs` as the JD fallback.
- CLI: `node jev-rank.mjs [--limit N] [--dry-run] [--no-fetch] [--self-test]`. Default limit 50, ceiling 500. Summary line: `jev-rank: {scored} scored, {noJd} without JD, {failed} failed, {skipped} already annotated`.
- JD resolution order per row: jd-store, then `fetchJdViaKnownApi(url)` unless `--no-fetch`, else count as `noJd` and leave the row unchanged.

- [ ] **Step 1: Failing tests** (fetch and scorer injected): a row with a stored JD gets the segment appended after an existing `| rank: ` segment; a row with no JD and `--no-fetch` is unchanged and counted; a scorer failure leaves the row unchanged; a row already carrying `| jev: ` is skipped; `--dry-run` writes nothing.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat: add jev-rank, a zero-token Jev pass over pending pipeline rows`

### Task A6: Jev in `calibrate.mjs`

**Files:**
- Modify: `calibrate.mjs`
- Test: `tests/calibrate-jev.test.mjs`

**Interfaces:**
- Produces: `--jev` flag. For each tracker row with a report link, read the report's Machine Summary `jev.score` and `jev.verdict` (regex on the YAML fence, same as `web/src/lib/machine-summary.mjs` `FENCE`); print a second table "Jev score bands" with the same band and sample-floor rules as the existing score table, and a verdict table (apply / maybe / skip) with positive-outcome counts. JSON output gains `jev: { bands, verdicts }`.

- [ ] **Step 1: Failing test**: a temp data root with two reports (one `jev: {score: 4.2, verdict: apply}`, one `jev: null`) and a tracker; `--json --jev` lists one row in band 4.0-4.4 and one `not_run`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (read-only, advisory, no change to existing output without `--jev`). **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat: report Jev bands and verdicts in calibrate`

### Task A7: Docs and syntax gate

**Files:**
- Create: `docs/JEV.md` (what Jev is, the seven questions, the CLI, the segment, the Machine Summary block, the fallback, the key resolution, how to tune `config/jev-criteria.yml`).
- Modify: `docs/SCRIPTS.md` (add `jev-score.mjs`, `jev-rank.mjs`).

- [ ] **Step 1:** Write the docs. **Step 2:** `npm run lint` passes; `node test-all.mjs --only jev` passes. **Step 3:** Commit `docs: describe the Jev pre-screen`.

---

## Track B: context layer, loaders, Jev wiring

### Task B1: Profile schema and `render-context.mjs`

**Files:**
- Modify: `config/profile.example.yml` (add the three C8 blocks, commented like the other optional blocks, each with a sentence on purpose; `dealbreakers` gets the gate's wording from `modes/oferta.md` "Dealbreaker gate")
- Create: `render-context.mjs`, `modes/_context.template.md`
- Test: `tests/render-context.test.mjs`

**Interfaces:** per C9. `_context.template.md` carries the section headings from the design doc (Target role; Location and language; Preferences confirmed on {date}; Deal-breakers; Experience summary; Technical profile with the four tiers; Strengths beyond the stack; Management competencies; Signals of a strong match; Signals of a weak match; Education and extras) with one-line placeholders and a header comment "targeting source, never evidence".

- [ ] **Step 1: Failing tests**: `knownKeysFromExample` (from `validate-profile.mjs`) now includes `preferences`, `interests`, `dealbreakers`; `isStale('2026-01-01', '2026-10-24')` true, `('2026-09-01', '2026-10-24')` false; `renderContext` prints `STALE` only for stale dates and lists every hard rule under `## Hard DQ`; `--section dq` prints only that section.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS, plus `node validate-profile.mjs --help` still works.
- [ ] **Step 5: Commit** — `feat: document preferences, interests and dealbreakers and render them`

### Task B2: User-layer registration

**Files:**
- Modify: `update-system.mjs` (`USER_PATHS` += `modes/_context.md`, `config/jev-criteria.yml`, `config/notion-map.yml`, `jds/feeder/`, `data/jd-index.tsv`), `DATA_CONTRACT.md` (rows for each), `doctor.mjs` (one check: `modes/_context.md` present, else a warning "context file missing: evaluations use cv.md and profile.yml only"), `.gitignore` (the same paths, next to the existing `modes/_profile.md` line).
- Test: run `node validate-system-paths-coverage.mjs` and `node test-all.mjs --only user-layer`.

- [ ] **Step 1:** Make the edits. **Step 2:** Both commands pass. **Step 3:** Commit `feat: register the context layer files in the user layer`.

### Task B3: Prompts: `_shared.md`, `oferta.md`, `auto-pipeline.md`, `batch-prompt.md`

**Files:**
- Modify: `modes/_shared.md` (sources table row for `_context.md` "ALWAYS, targeting only"; a new `## Calibrated pre-screen (Jev)` section after Scoring System stating: how the block arrives, the hard-stop rule, that Jev informs CV match and North Star, that `jev_score` is reported beside the Global score and never averaged; the preference staleness rule), `modes/oferta.md` (new gate `## Jev pre-screen gate` after the Dealbreaker gate: in an interactive session run `node jev-score.mjs --job <tmp json> --format markdown` on the extracted JD and paste the block; a blocking result stops before Block A with the question "Jev marks this as {blocking}. Evaluate it anyway?"; headless follows the dealbreaker gate's headless path with `needs_confirmation: jev {blocking} - rerun with "evaluate anyway" to evaluate`; report header line `**Jev:**` under `**Score:**`; Machine Summary rule to copy the block), `modes/auto-pipeline.md` (Step 0.8 calls the gate), `batch/batch-prompt.md` (sources table row; `jev:` in the schema per C5; a sentence under Global Score; the pre-screen arrives as `## Runtime pre-screen: jev` and is never recomputed by the worker).
- Test: `tests/context-loaders.test.mjs` asserts each file contains the strings `_context.md`, `Calibrated pre-screen (Jev)` (where applicable) and the schema contains `jev:`; `node validate-untrusted-content-coverage.mjs` still passes.

- [ ] **Step 1:** Failing test. **Step 2:** Edits. **Step 3:** PASS. **Step 4:** Commit `feat: wire the Jev pre-screen and the context file into the evaluation prompts`.

### Task B4: Loaders: router, batch runner, OpenRouter runner, evaluators, web

**Files:**
- Modify: `.agents/skills/career-ops/SKILL.md` (Context Loading: read `modes/_context.md` if it exists after `_profile.md` and before `_custom.md`, for both the shared-context modes and the standalone modes; one line in the delegated-subagent template), `batch/batch-runner.sh` (the personalization loop adds `$DATA_ROOT/modes/_context.md`; C10 flags and the pre-screen injection; the JD for the pre-screen is the prefetched `$jd_file`, written to a temp JSON with the row's url, company and title), `openrouter-runner.mjs` (`loadContext` adds `context: readFile('modes/_context.md') ?? ''`; `buildSystemPrompt` appends `CANDIDATE CONTEXT (targeting only):` after the CV; `cmdEvaluate` runs `scoreJob` through a dynamic `import('./jev-score.mjs')` guarded by `existsSync` and appends the C3 block to the user message; the key comes from `resolveOpenRouterKey`), `openai-eval.mjs`, `gemini-eval.mjs`, `ollama-eval.mjs` (append `_context.md` when present, labelled targeting only), `web/src/lib/run-prompts.mjs` (same), `web/src/lib/machine-summary.mjs` (`readMachineSummary` returns `jev: { fit, score, verdict, blocking } | null`).
- Test: `tests/context-loaders.test.mjs` extended: `buildSystemPrompt` output contains the context text when `ctx.context` is set and is byte-identical to before when it is empty; `readMachineSummary` parses a `jev:` block and returns `null` for `jev: null`; a shell test runs `bash -n batch/batch-runner.sh` and greps the new flags in `usage()`.

- [ ] **Step 1:** Failing tests. **Step 2:** Edits. **Step 3:** PASS; `node test-all.mjs --only openrouter` and `--only batch` pass. **Step 4:** Commit `feat: load the context file in every evaluation path and gate batch workers on Jev`.

### Task B5: `AGENTS.md`, `modes/pipeline.md`, `modes/triage.md`, `_brief.template.md`

**Files:**
- Modify: `AGENTS.md` (Source-of-Truth Boundary: a third tier "Targeting / never evidence: `modes/_context.md`, `config/profile.yml` `preferences` and `interests`"; headless commands list gains `node jev-score.mjs`, `node jev-rank.mjs`, `node render-context.mjs`), `modes/pipeline.md` (document the `jev:` segment after `rank:`), `modes/triage.md` (a `jev:` segment on a row is a strong signal: `skip` with blocking means FAIL unless the Priority Override List names the company), `modes/_brief.template.md` (Hard DQ comment: "generate this list with `node render-context.mjs --section dq`").
- [ ] **Step 1:** Edits. **Step 2:** `node test-all.mjs --only agent-docs` passes. **Step 3:** Commit `docs: add the targeting tier and the jev segment`.

### Task B6: Notion sync mode and writer

**Files:**
- Create: `modes/notion-sync.md`, `notion-sync-apply.mjs`, `config/notion-map.example.yml`
- Test: `tests/notion-sync-apply.test.mjs`

**Interfaces:**
- `config/notion-map.yml` (data root): `root: <url>`, `pages: { profile, career_history, claims_to_confirm, interests, professional_examples, ats_notes }` each `{ title, url }`, `employers: [{ name, url }]`, `examples: [{ id, title }]`.
- Mode (in-session, standalone context): read `config/notion-map.yml`; fetch each page with the session's Notion connector (stop with a clear message when it is not available); build a proposal JSON `{ context_md, preferences, interests, article_digest_md, cv_facts: { allow_metrics, allow_facts, forbidden_phrases }, career_profile_facts }` following the factual rules (Claims to Confirm "Use now" wording or omit; interests carry `recorded_on` and ask for `confirmed_on`); run `node notion-sync-apply.mjs --proposal <file> --dry-run`, show the diff, write only after an explicit yes with `--apply`. Never writes to Notion.
- `notion-sync-apply.mjs --proposal <file> [--dry-run|--apply] [--data-root <dir>]`: writes `modes/_context.md`, merges the `preferences` and `interests` blocks into `config/profile.yml` (preserving every other key and comment outside those blocks by replacing the block text, not re-serialising the file), writes `article-digest.md`, merges `config/cv-facts.json` lists (union, sorted), and appends facts to `data/career-profile.yml` through `lib/career-profile.mjs` with `review_status: proposed`. `--dry-run` prints a unified diff per file and exits 0 without writing.

- [ ] **Step 1: Failing tests**: dry run writes nothing and prints a diff naming each target; apply writes the five files; a second apply with the same proposal is a no-op; profile.yml keys outside the two blocks are byte-identical before and after.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (diff with a small inline LCS over lines, no dependency). **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: add the Notion sync mode and its local writer`.

### Task B7: Router entry for `notion-sync` and docs

- Modify: `.agents/skills/career-ops/SKILL.md` (mode table and trigger "sync my Notion records"), `docs/NOTION_SETUP.md` (section "Career records sync (fork)"), `DATA_CONTRACT.md` (`config/notion-map.yml`).
- [ ] Edits, `node test-all.mjs --only skill` passes, commit `docs: route notion-sync`.

---

## Track C: drafts and LinkedIn modes

### Task C1: Shared writing rules and templates

**Files:**
- Modify: `modes/_writing.md` (new section `## Outreach and comment rules`: 90 to 140 words per message, under 300 characters per connection note, at most one number and only a confirmed one, honest reason before facts, no "I hope this finds you well", no CV bullets, no tool lists, never ask for a job, never write to a current-employer colleague about leaving; new section `## Interests in candidate-facing text`: read `modes/_context.md` and `config/profile.yml` `interests` for "why this role" material; when `confirmed_on` is stale per `render-context.mjs`, say so and ask before using them)
- Create: `templates/outreach.md` (the four structures: recruiter-or-hiring-manager, referral, networking, connection-note, each as an ordered list of paragraph roles with one sentence on what the paragraph does; no personal facts), `templates/posts.md` (comment shapes: experience, counterpoint, concrete example, question; repost-with-take; Open to work post structure)
- Test: `tests/draft-modes-context.test.mjs` (asserts the headings exist and the templates contain no `@` or `+49`).

- [ ] Failing test, edits, PASS, commit `feat: add outreach and comment structures to the writing layer`.

### Task C2: Draft modes read the context

**Files:**
- Modify: `modes/cover.md` (Step 1: read `modes/_context.md` and the `interests` block for the "why this role" paragraph, through the `_writing.md` staleness rule), `modes/email.md` (Step 1 list), `modes/contacto.md` (message rules: use `templates/outreach.md`; add the referral and networking variants next to the existing power move and greeting), `modes/interview-prep.md` (Inputs: `_context.md` and `interests` for "why this role" and "what are you looking for"), `modes/followup.md` (Inputs: `_writing.md` and `_context.md`).
- Test: extend `tests/draft-modes-context.test.mjs`: each file names `_context.md`; `contacto.md` names `templates/outreach.md`.
- [ ] Failing test, edits, PASS, commit `feat: draft modes read the candidate context and interests`.

### Task C3: Application field classes and ATS notes

**Files:**
- Modify: `modes/apply.md` (Step 6 gains a table of field classes: identity and contact; knockout-prone; personal and sensitive; experience facts; free text; uploads; consent and legal, with the rule per class. `needs_candidate_confirmation: yes` list extended with notice period, earliest start date, on-site days, relocation, years of experience, language level, driving licence. Step 1 reads `data-static/ats-notes.md` for the detected ATS and names its documented auto-reject behaviour.)
- Create: `data-static/ats-notes.md` (port of job-search-plugin `shared/ats-notes.md`: the four cross-ATS facts, the quick-reference table and the per-vendor sources with check dates; no Notion links)
- Test: `tests/draft-modes-context.test.mjs`: `apply.md` contains `knockout-prone` and `data-static/ats-notes.md`; the notes file has a row for each of Greenhouse, Workday, Personio, Lever, Ashby, SmartRecruiters, JOIN, softgarden, Recruitee, Teamtailor, SAP SuccessFactors.
- [ ] Failing test, edits, PASS, commit `feat: classify application fields and ship vendor-sourced ATS notes`.

### Task C4: `network-plan.mjs` and `modes/network.md`

**Files:**
- Create: `network-plan.mjs`, `modes/network.md`
- Test: `tests/network-plan.test.mjs`

**Interfaces:**
- `node network-plan.mjs [--quota 100] [--per-company 10] [--roles "Engineering Manager,Head of Engineering,VP Engineering,CTO,Technical Recruiter"] [--done "Company"...] [--out <path>] [--json]`.
- Input: `data/applications.md` (through `tracker-parse.mjs` `parseTrackerRow`, `resolveColumns`) and `data/pipeline.md` pending rows with a `jev:` or `rank:` segment. Company ranking (port of job-hunt `jobs/network.py`): active statuses (Applied, Responded, Assessment, Interview, Offer) count 10 each, a `jev: ... apply` or `rank: >= 4.0` row counts 3, `maybe` or `rank: >= 3.5` counts 1, capped at `--per-company` openings per company; Rejected, Discarded, SKIP excluded. Done companies in `data/network.json` are left out.
- Output markdown: the header with the week, budget and rules; per company a section with its openings (status or verdict, link), a company-page search URL, and one people-search URL per role (`https://www.linkedin.com/search/results/people/?keywords={company}+{role}&origin=GLOBAL_SEARCH_HEADER`).
- Export `rankCompanies(trackerRows, pipelineRows, { perCompany }) -> Array<{ company, score, openings }>` and `renderPlan(companies, { quota, roles, date }) -> string`.

- [ ] **Step 1: Failing tests**: an applied company outranks one with three apply verdicts; the per-company cap holds; a done company is excluded; the rendered plan contains one people-search URL per role.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; `modes/network.md` explains the weekly ritual (Connect not Follow, note only with something real, follow the company page, "I am interested"), runs the script, and offers `--done`. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: add the weekly LinkedIn connection plan`.

### Task C5: `modes/engage.md` and `docs/LINKEDIN.md`

**Files:**
- Create: `modes/engage.md` (input: a JSON hand-off `{ posts: [{ author, url, date, text, age_days, priority }] }` written by the feeder's `jobs engage`, or pasted post text; pick at most three posts by the priority order in the design; draft comments 40 to 90 words with the shapes in `templates/posts.md`; language of the post; never post; after the user says what they posted, offer the feeder's `--done` command), `docs/LINKEDIN.md` (the three pillars, how the feeder, `network` and `engage` fit, what is never automated).
- [ ] Write, `node test-all.mjs --only untrusted` passes (the mode names "Untrusted External Content" for the post text), commit `feat: add the engage mode for daily LinkedIn comments`.

---

## Track D: Python feeder (job-hunt)

### Task D1: `jobs/pipeline_md.py`

**Files:**
- Create: `jobs/pipeline_md.py`
- Test: `tests/test_pipeline_md.py`

**Interfaces:**
- `sanitize_field(value: str) -> str` (C7 rules), `sanitize_url(value: str) -> str`.
- `format_pipeline_line(job: Job, search_name: str = "") -> str` (C7).
- `jd_relative_path(job: Job) -> str` = `jds/feeder/{source}-{source_id}.json`.
- `export_to_data_root(jobs: list[Job], data_root: Path, today: str) -> ExportResult` with `ExportResult(added: int, skipped_existing: int, written_jds: int)`: reads existing URLs from `data/pipeline.md` (every `- [ ]` and `- [x]` row, first cell) and `data/jd-index.tsv`; for each new job writes the JD JSON (job `to_dict()` plus `url`, `first_seen`, `search_name`), appends the index row, and appends the pipeline line under `## Pending` (creating the file from the skeleton `# Pipeline\n\n## Pending\n\n## Processed\n` when missing, inserting before `## Processed` when present). Jobs with an empty `description` are still exported (career-ops can fetch them).
- Idempotent: a second call with the same jobs returns `added 0`.

- [ ] **Step 1: Failing tests**: a LinkedIn job renders the 4-column row with `posted:` and `note: linkedin gerente-eng-germany-7d`; a job with salary and no location keeps an empty location cell; `|` in a title becomes `/`; export creates the three files; a second export adds nothing; an existing `- [x]` row with the same URL blocks re-adding.
- [ ] **Step 2:** `uv run pytest tests/test_pipeline_md.py` — FAIL. **Step 3:** Implement (standard library only). **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: export new openings to a career-ops data root`.

### Task D2: CLI wiring and README

**Files:**
- Modify: `jobs/cli.py` (new subcommand `pipeline --data-root PATH` reading `out/jobs.jsonl` through `jobs/store.py`; `run` gains `--data-root` and runs the export after `fetch` when given; `JOB_HUNT_DATA_ROOT` env default via `jobs/settings.py`), `README.md` (section "Feeding career-ops": the command, what it writes, that `score`, `explain`, `export`, `status`, `network` and `outreach` are superseded by career-ops and kept for the CSV workflow only).
- Test: `tests/test_cli_commands.py` gains one test that `pipeline --data-root <tmp>` writes `data/pipeline.md`.
- [ ] Failing test, implement, `uv run pytest` all green, commit `feat: add the pipeline command and document the feeder role`.

---

## Orchestrator tasks

### Task O1: Phase 0, data root and checkout wiring

- [ ] `.env` in the checkout: `CAREER_OPS_DATA_DIR=~/Projects/job-hunt-private`, `CAREER_OPS_CLI=claude`.
- [ ] `config/local-paths.txt` from the example with: `docs/superpowers/`, `jev-score.mjs`, `jev-rank.mjs`, `render-context.mjs`, `notion-sync-apply.mjs`, `network-plan.mjs`, `lib/openrouter-key.mjs`, `lib/jev-criteria.mjs`, `lib/jd-store.mjs`, `modes/notion-sync.md`, `modes/network.md`, `modes/engage.md`, `templates/outreach.md`, `templates/posts.md`, `data-static/ats-notes.md`, `docs/JEV.md`, `docs/LINKEDIN.md`, `config/jev-criteria.example.yml`, `config/notion-map.example.yml`, `modes/_context.template.md`; un-ignore and commit it per the example's instructions.
- [ ] Data root: `node doctor.mjs --json --init-templates`; `node onboard-write.mjs --answers -` with the facts from `job-hunt-private/profile.md`; `cv.md` converted from `job-hunt/applications/Renato_Beltrao_CV_2026-10.docx` with `python-docx` (headings per AGENTS.md Step 1 shape); `modes/_context.md` = `profile.md` verbatim; `config/jev-criteria.yml` = port of `jobs/scoring/criteria.py` wording; `modes/_profile.md`, `_brief.md`, `_custom.md` personalised from `profile.md` and the job-search-plugin rules; `portals.yml` `tracked_companies` from `companies.yaml`; `data/applications.md`, `data/pipeline.md` skeletons; `config/notion-map.yml` from `job-search-plugin/shared/notion-map.md`; `.env` with `CAREER_OPS_CLI=claude`.
- [ ] `node doctor.mjs` green except Playwright chromium when absent; commit the data root in job-hunt-private.

### Task O2: Merge order and router registration

- [ ] Merge `feat/jev-score`, then `feat/context-layer`, then `feat/drafts-linkedin` into `main` of the fork (no-ff). Resolve nothing by hand: the tracks share no file; a conflict means an ownership violation to fix in the track branch first.
- [ ] Add `network` and `engage` to the mode table and triggers in `.agents/skills/career-ops/SKILL.md` and to the standalone-modes list in Context Loading. Commit `feat: route the network and engage modes`.
- [ ] `node test-all.mjs --quick`, `npm run lint`, `node validate-system-paths-coverage.mjs`. Push `main`.

### Task O3: Phase 5, tracker import and retirement notes

- [ ] One-off script in the scratchpad: read `job-hunt/out/jobs.csv`; for rows with status `applied` write a headed TSV (status `Applied`, score `N/A`, pdf `❌`, report `-`, notes `imported from job-hunt; jev fit {score} {verdict}`, url), for `draft` write `Evaluated` with the same notes; `node merge-tracker.mjs`; `node tracker.mjs sync`.
- [ ] Run the feeder once: `uv run python -m jobs pipeline --data-root ~/Projects/job-hunt-private` on the existing `out/jobs.jsonl`; then `node jev-rank.mjs --limit 20 --no-fetch` and read the summary.
- [ ] `job-search-plugin/README.md` (create if absent): one paragraph that the skills are superseded by the career-ops fork, with the mode names.
- [ ] Verification run: `node openrouter-runner.mjs evaluate <one known URL>` and confirm the report carries `**Jev:**` and the `jev:` block; `bash batch/batch-runner.sh --dry-run --limit 3`.
