# job-hunt 2.0: consolidating job-hunt into career-ops

Date: 2026-10-24. Status: proposal, awaiting Renato's decisions (listed at the end).

## Intent

Make career-ops the single job-search system and retire the `job-hunt` repository, keeping the four things job-hunt does better:

1. Jev, a calibrated typed decision model, scores every posting against the candidate.
2. A rich candidate context (interests, confirmed preferences, deal-breakers, competencies, Notion career records) exists as a first-class input.
3. That context drives match-making, not only the CV.
4. The same context, plus a strict factual-rules layer, drives every draft: cover letter, outreach message, application answers, email, interview prep.

career-ops already covers the rest of job-hunt's scope with more depth: 130 zero-auth job-source providers, an A-H evaluation, ATS PDF generation with a fact gate, cover letters, contact discovery, application-answer drafting, a tracker with status hooks, follow-ups, reply classification, interview prep, batch processing, a TUI and an alpha web UI, multi-CLI support (Claude Code, Codex, opencode, qwen, grok, kimi) and a plugin system.

## What each repository is today

### job-hunt (Python, `~/Projects/job-hunt`, private data in `~/Projects/job-hunt-private`)

- Fetch: logged-in LinkedIn browser adapter (Playwright, persistent profile, human pacing, seen-id store), LinkedIn guest endpoints (disabled), Personio XML, Greenhouse JSON, Ashby JSON. Saved LinkedIn searches in `searches.yaml`, boards in `companies.yaml`.
- Score: `jobs/scoring/jev.py` sends `state.profile` (the whole `profile.md`) and `state.job` to `POST https://openrouter.ai/api/alpha/decisions`, model `typesafe/jev-1.13`, and asks seven typed questions defined in `jobs/scoring/criteria.py`: `fit` (noul probability scaled to 0-100), `verdict` (apply / maybe / skip), `seniority_match`, `location_ok`, `language_blocker`, `team_type`, `stack_fit`. Confidences and per-label probabilities are kept. `jobs/scoring/llm.py` is the same question set as a strict-JSON chat completion (fallback when the typesafe provider is unavailable). `jobs/scoring/explain.py` is an optional second pass for strong matches (strong_matches, gaps, red_flags, pitch), usually written by a Claude session from a hand-off JSON instead.
- Verified working on Renato's OpenRouter account: 243 of 253 scored rows in `out/jobs.jsonl` carry model `typesafe/jev-1.13-20260917`; the 2026-10-19 run scored 219 postings with 10 failures.
- Track: append-only `out/jobs.csv` with status plus a dated notes trail (`jobs status`).
- LinkedIn side: `jobs network` (weekly connection plan ranked from the CSV), `jobs outreach <job_id>` (JSON pack for one message to one person), `jobs engage` (latest posts of chosen creators as a comment hand-off). None of them clicks anything.
- Context: `profile.md` (symlinked from job-hunt-private) is a 141-line fit profile built on 2026-10-16 from the Notion "Job Applications" workspace: target role, location and language, preferences confirmed on 2026-10-17 (hard rules, minus, neutral, plus, no penalty), deal-breakers, experience summary and details, technical profile in four tiers (core, solid, managed, aspiration), strengths beyond the stack, management competencies, signals of a strong and of a weak match, education. It is explicitly a scoring input, not a drafting source.
- Tests: 117 tests, fixtures only, no network.

### job-search-plugin (Claude skills, `~/Projects/job-search-plugin`)

Seven skills grounded in Notion career records: `fit-check`, `tailor-cv`, `fill-application`, `interview-prep`, `track-applications`, `linkedin-outreach`, `linkedin-engage`, `linkedin-network`. Shared references: `notion-map.md` (the pages and their reading order), `factual-rules.md` (what may be claimed and from where), `linkedin-playbook.md` (Ksu Dranitsina's guide distilled), `ats-notes.md` (vendor-documented parsing and knockout behaviour per ATS), `outreach-templates.md`, `post-templates.md`, `answer-types.md`, `cv-format.md`, `bullet-writing.md`.

The factual-rules layer is the part worth keeping verbatim: facts only from Notion records or what Renato confirms in the conversation; Claims to Confirm governs titles, dates, headcounts and metrics ("Use now" wording or omit); interests recorded in 2025 must be reconfirmed before they decide anything; no estimated numbers; learning interests are not expertise; never send, submit or write to Notion without asking.

### career-ops (v1.38.0, Node 22, `~/Projects/career-ops`)

Design: logic lives in markdown prompts (`modes/*.md`), scripts (`*.mjs`) do deterministic plumbing, the LLM produces the score. Key facts for this plan:

- Evaluation: `modes/oferta.md` (A-H), `modes/_shared.md` (scoring system, five dimensions, Global 1-5 decided holistically, "no arithmetic formula"; bands 4.5+, 4.0-4.4, 3.5-3.9, below 3.5), `modes/auto-pipeline.md` (entry when a JD or URL is pasted), `batch/batch-prompt.md` (headless copy and the authority for the Machine Summary schema). Scripts only parse the score; nothing hard-blocks below 4.0 except prompts and display.
- Context the model sees: `cv.md`, `article-digest.md` (proof points, wins over cv.md for metrics), `config/profile.yml`, `modes/_profile.md` (archetypes, framing, exit narrative, comp, location policy, writing style), `modes/_custom.md` (procedural house rules only), `modes/_brief.md` (triage brief), `voice-dna.md` and `writing-samples/` (style only), `interview-prep/story-bank.md`, `data/career-profile.yml` (facts with evidence and review status), `data/blacklist.md`. A `dealbreakers` key in profile.yml is read by oferta, auto-pipeline and batch-prompt but is not documented in `config/profile.example.yml`. There are no structured interests, pluses or management-competency fields.
- Headless scoring: `batch/batch-runner.sh` (agent CLI workers), `openrouter-runner.mjs` (direct OpenRouter chat completions with `OPENROUTER_API_KEY`), `openai-eval.mjs`, `gemini-eval.mjs`, `ollama-eval.mjs`, `rank-pipeline.mjs` (cheap rank on pipeline Pending rows).
- Sources: `scan.mjs` over `providers/` (Greenhouse, Ashby, Lever, Personio, join.com, softgarden, Workday, SmartRecruiters, Recruitee, Teamtailor, Workable and more) into `data/pipeline.md` Pending, through an admission gate. No LinkedIn provider; upstream keeps providers zero-auth.
- Plugins: hook kinds are `provider`, `ingest`, `search`, `notify`, `export` only. A plugin cannot hook evaluation or scoring. The bundled Notion plugin exports tracker rows and searches job URLs; it does not read career records.
- Drafts: `modes/cover.md`, `modes/contacto.md`, `modes/email.md`, `modes/followup.md`, `modes/interview-prep.md`, `modes/apply.md` plus `prepare-application.mjs`. Shared writing layer `modes/_writing.md` (not read by interview-prep and followup). Approval gates exist in cover, contacto, followup and apply; `verify-cv-facts.mjs` blocks PDFs and cover letters whose numbers or facts appear in neither cv.md, article-digest.md nor `config/cv-facts.json`.
- User data: all user files resolve against a data root (`CAREER_OPS_DATA_DIR`, `path-resolver.mjs`), and the updater (`update-system.mjs`) protects `USER_PATHS` plus the paths declared in `config/local-paths.txt`. This is how a fork keeps its own files across upstream updates.
- Tests: `node test-all.mjs` discovers about 700 test files; `npm run lint`; `evals/golden` with `eval-golden.mjs` (not in CI).

## Goals

- One repository to operate the search from, in the AI CLI already in use.
- Every posting gets a calibrated, typed, explainable pre-score before any LLM token is spent on it.
- The candidate context is structured, versioned in the private data repository, and loaded by every evaluation and draft path (chat, batch, OpenRouter runner, web).
- Drafts obey the factual rules mechanically where possible (fact gate), and by prompt where not.
- Upstream updates keep flowing: fork-owned files stay in `USER_PATHS` or `config/local-paths.txt`; edits to upstream prompts stay minimal and are candidates for upstream pull requests.

## Non-goals and anti-goals

- No auto-submit, no auto-send, no auto-connect, no auto-comment. Same line as both projects today.
- No LinkedIn provider in anything meant for upstream. LinkedIn fetching stays fork-local or external, with job-hunt's pacing rules.
- No personal data in the fork: profile, CV, reports, tracker, Notion-derived files live in the data root (job-hunt-private), never in the career-ops checkout.
- Jev never becomes the only judge. It gates and informs; the A-H evaluation and Renato decide.

## Design

### 1. Repository layout

- Fork `career-ops-hq/career-ops` to `rdbeltrao/career-ops`; `origin` is the fork, `upstream` is career-ops-hq. Branch `main` tracks upstream; our work lands on `main` of the fork through feature branches.
- `~/Projects/job-hunt-private` becomes the career-ops data root (`CAREER_OPS_DATA_DIR` in `.env`): `cv.md`, `article-digest.md`, `config/profile.yml`, `config/cv-facts.json`, `portals.yml`, `modes/_profile.md`, `modes/_custom.md`, `modes/_context.md`, `data/`, `reports/`, `output/`, `interview-prep/`. It is already a private git repository, so this mirrors today's job-hunt / job-hunt-private split.
- New fork-owned code files are declared in `config/local-paths.txt` so `npm run update` never overwrites them.

### 2. Jev for match-analysis

New script `jev-score.mjs` at the repo root, modeled on `openrouter-runner.mjs` (same `.env` loader, same `OPENROUTER_API_KEY`, plus `OPENROUTER_API_KEY_JOB_SEARCH` read first and the macOS Keychain fallback ported from job-hunt's `jobs/settings.py`). Node 22 has `fetch`, so no new dependency.

- Input: one job (title, company, location, workplace, seniority, description cut at 6000 characters) and the candidate context (`modes/_context.md`, see section 3). Output: typed JSON `{fit, verdict, seniority_match, location_ok, language_blocker, team_type, stack_fit, confidences, probabilities, model}`. The question set and wording move from `criteria.py` to `config/jev-criteria.yml` in the data root, so the wording stays tunable per candidate; question keys and labels are the contract.
- Fallback: when OpenRouter answers HTTP 404 "No allowed providers are available", the script switches to chat completions with a strict JSON schema (port of `llm.py`), says so, and tags the result with the model used.
- Three call sites:
  1. `jev-rank.mjs`: scores every `## Pending` row of `data/pipeline.md` that has a description (fetching it with the existing extractors when missing) and appends a `| jev: 79 apply (seniority match, remote yes, language none, product, stack agnostic)` segment, following the labeled-segment contract in `modes/pipeline.md`. `modes/triage.md` and `pipeline.triage_threshold` read that segment. This replaces job-hunt's `score` step and costs no agent tokens.
  2. Full evaluation: `modes/oferta.md` and `batch/batch-prompt.md` get a short "Calibrated pre-screen" block: the Jev result is injected (by `batch-runner.sh` before the worker starts, by `openrouter-runner.mjs` in `buildSystemPrompt`, by the router for chat through a `node jev-score.mjs --job <file>` call in Step 0). The Machine Summary schema gains a `jev:` block with the same keys. Rule for the LLM: a Jev `skip` verdict backed by a blocking answer (`seniority_match` below or above, `location_ok` no, `language_blocker` missing, `stack_fit` required_mismatch) is a hard stop unless `_custom.md` or the user overrides it; otherwise Jev's `fit` and reasons inform the CV-match and North Star dimensions, and the Global score stays the LLM's holistic call, as `_shared.md` requires.
  3. `batch-runner.sh --min-jev <n>` and `--skip-jev-verdict skip`: workers are not spawned for postings Jev already rules out, which is where most of the batch budget goes today (job-hunt's last run: 338 skip, 205 maybe, 25 apply out of 568).
- Calibration: `calibrate.mjs` learns the `jev:` block so Jev's probabilities can be compared with real outcomes alongside the LLM score. `analyze-patterns.mjs` gets the verdict as one more axis.
- Tests: port `tests/test_scoring.py` and `tests/test_llm_scoring.py` (20 tests) to `tests/jev-score.test.mjs` with recorded responses under `tests/fixtures/jev/`, discovered by `test-all.mjs`.

### 3. The context layer

Two files in the data root, one schema change, one sync script.

- `modes/_context.md` (new user file, prose): the fit profile, section for section as job-hunt's `profile.md`: target role, location and language, preferences confirmed on a date (hard rules, minus, neutral, plus, no penalty), deal-breakers, experience summary and details, technical profile in four tiers, strengths beyond the stack, management competencies, signals of a strong and of a weak match, education. It is a targeting source: it steers scores and framing, never a fact source for a draft. Jev reads it whole as `state.profile`.
- `config/profile.yml` gains two documented blocks (added to `config/profile.example.yml` so `validate-profile.mjs` accepts them, and `dealbreakers` gets documented at the same time):
  - `preferences:` with `confirmed_on`, `hard_rules`, `minus`, `neutral`, `plus`, `no_penalty`, `dealbreakers`.
  - `interests:` with `recorded_on`, `confirmed_on`, `role_balance`, `team_size`, `team_type`, `domains`, `ways_of_working`, `learning`.
  Rule, enforced in prompts: when `confirmed_on` is older than 90 days, any mode that lets interests decide a verdict or a "why this role" paragraph says so and asks before relying on them. This is factual-rules.md's "recorded in 2025, confirm it still applies" made mechanical.
- `_brief.md` Hard DQ list is generated from `preferences.hard_rules` and `dealbreakers` by a small `render-context.mjs`, so triage and the admission gate use the same blockers as Jev.
- Loader fan-out, every place that assembles context loads `_context.md` as a targeting source: the router (`.agents/skills/career-ops/SKILL.md` load order), `batch/batch-runner.sh` and the `batch-prompt.md` sources table, `openrouter-runner.mjs` `loadContext`, the `*-eval.mjs` scripts, `web/src/lib/run-prompts.mjs`, and the explicit read lists in `cover.md`, `email.md`, `contacto.md`, `apply.md`, `interview-prep.md`, `followup.md` and `_writing.md`.
- Trust tiers: `AGENTS.md` and `_shared.md` get `_context.md` as "targeting, never evidence". `verify-cv-facts.mjs` keeps its sources as they are: a number that exists only in `_context.md` still fails the fact gate, which is the behaviour we want.
- `notion-sync-context.mjs` (fork-local): reads the pages listed in job-search-plugin's `notion-map.md` (Profile, Career History and employer pages, Claims to Confirm, Professional and Personal Interests, Professional Examples) and proposes writes to the data root: `_context.md`, the `preferences` and `interests` blocks, `article-digest.md` entries from Professional Examples EX-01 to EX-05 with page links as provenance, `config/cv-facts.json` allow lists from Claims to Confirm "Use now" values and forbidden phrases from its open items, and `data/career-profile.yml` facts with `review_status`. First version runs inside a Claude session through the Notion connector and shows a diff before writing; a token-based batch version can follow. Notion itself is never written.

### 4. Context for drafts

- Facts: drafts already read `cv.md` and `article-digest.md` and pass the fact gate. With `article-digest.md` and `cv-facts.json` generated from Claims to Confirm and Professional Examples, "no unconfirmed numbers" becomes a mechanical check at PDF and cover-letter time instead of a prompt rule.
- Voice and structure: `voice-dna.md` and `writing-samples/` get Renato's register tiers from renato-communication; `modes/_custom.md` (procedural house rules, exactly its purpose) gets the rules from `linkedin-outreach`, `linkedin-engage`, `fill-application` and `factual-rules.md`: 90 to 140 words per message, under 300 characters per connection note, one confirmed number at most, no "I hope this finds you well", honest reason before facts, never a job ask, never write to a current-employer colleague about leaving, ask before every Notion write. `outreach-templates.md` and `post-templates.md` become `templates/outreach.md` and `templates/posts.md`, read by `contacto.md`, `email.md` and a new `engage.md`.
- Interests in drafts: `cover.md`, `email.md`, `contacto.md`, `apply.md` and `interview-prep.md` read the `interests` block for the "why this role" and "what are you looking for" material, with the staleness rule above.
- Application answers: `modes/apply.md` adopts fill-application's field classes (identity, knockout-prone, personal and sensitive, experience facts, free text, uploads, consent). career-ops already marks legal, visa and salary as `needs_candidate_confirmation`; the knockout-prone class adds notice period, earliest start, on-site days, relocation, years of experience, language level and driving licence, and the ATS quick-reference from `ats-notes.md` lands in `data-static/ats-notes.md` with its vendor sources and check dates.

### 5. The LinkedIn side

career-ops has no LinkedIn provider by design, and job-hunt's browser adapter (logged-in Playwright, human pacing, seen ids, markup fallbacks, 20 tests) is the most fragile and most valuable piece of job-hunt. Two options:

- A. Keep job-hunt's Python fetch as an external feeder: add `jobs export --pipeline-md` that writes Pending lines in the `modes/pipeline.md` contract (`- [ ] url | company | title | location | comp | posted: | trust: | note:`) into the data root. career-ops then owns scoring, tracking and drafts; job-hunt shrinks to `login`, `fetch`, `engage` and that export. Zero rewrite, works the first day.
- B. Port the adapter to Node (career-ops already depends on Playwright) as a fork-local `providers.local/linkedin-browser.mjs` with the same pacing and seen-id rules, never offered upstream.

Recommendation: A first, B once the rest is stable. `network` becomes `modes/network.md` plus `network-plan.mjs` ranking companies from `data/applications.md` and `data/pipeline.md` (career-ops already tracks connections in `data/Connections.csv` through `linkedin-join.mjs`). `engage` stays in the feeder under option A (it needs the logged-in browser) and gets `modes/engage.md` for the comment drafting.

### 6. What job-hunt loses, deliberately

- `out/jobs.csv` and `jobs status`: replaced by `data/applications.md`, `set-status.mjs` and the `data/status-log.tsv` ledger, which already keep a dated history. The current CSV is imported once (`merge-tracker.mjs` from a generated TSV; Evaluated rows for everything scored, Applied for the four applied rows, Draft for the eight drafts).
- The Claude Desktop dashboard artifact: replaced by the TUI and the web alpha.
- `jobs explain`: replaced by the A-H report, which already produces strengths, gaps, red flags and a cover-letter draft.
- `track-applications` in Notion: career-ops's Notion plugin exports the tracker; our Applications schema (Status values, ATS, CV version, next step) is mapped onto its export settings. The pipeline source of truth moves to `data/applications.md`.

## Phases

0. Fork and wire. Fork, set remotes, point `CAREER_OPS_DATA_DIR` at job-hunt-private, run onboarding from the current CV and profile, run `npm run doctor`. Baseline: evaluate three postings we already know well and compare with the Jev verdicts and our own calls. Exit: reports exist, tracker imported, upstream update applies cleanly.
1. Jev. `jev-score.mjs`, `config/jev-criteria.yml`, `jev-rank.mjs`, Machine Summary `jev:` block, pre-screen injection in oferta, batch-prompt, batch-runner and openrouter-runner, tests and fixtures. Exit: `node jev-rank.mjs` scores the pipeline without agent tokens, and a batch run skips Jev `skip` rows.
2. Context layer. `_context.md`, the `preferences` and `interests` schema, `render-context.mjs`, loader fan-out, trust tiers, `notion-sync-context.mjs`. Exit: one evaluation in chat, one in batch and one through the OpenRouter runner all cite the same preference that decided their verdict.
3. Drafts. Voice, house rules, templates, apply field classes, ATS notes, interests in draft modes. Exit: a cover letter and an outreach message for one real posting pass the fact gate and read like the ones in `applications/top5-2026-10-18.md`.
4. LinkedIn side. Feeder export (option A), `network.md`, `engage.md`. Exit: one daily run: feeder, scan, jev-rank, batch, network plan.
5. Retire. Archive `job-hunt` (or keep it as the feeder only), move `job-search-plugin`'s remaining value into career-ops modes, keep job-hunt-private as the data root.

Phases 1, 2 and 3 touch different files and can run in parallel once phase 0 is done.

## Upstream candidates

Once they work for us: the Jev evaluator as a standalone evaluator script (same shape as `ollama-eval.mjs`), the documented `preferences` and `dealbreakers` schema, the knockout-prone field classes in `apply.md`, and the ATS notes table with vendor sources. The LinkedIn feeder, the Notion sync and anything built on Renato's records stay in the fork.

## Risks

- Upstream velocity: v1.38.0 plus 14 commits, pull-request numbers in the 5700s. Mitigation: new files over edits, `local-paths.txt`, rules in `_custom.md`, and the updater's rollback.
- Batch workers run the agent CLI with `--dangerously-skip-permissions` on prefetched, untrusted job-description text (`batch/batch-runner.sh`). Upstream has "Untrusted External Content" guards in the prompts, but the permission bypass is real. Mitigation: run batch in a sandboxed shell or container, keep `--strict-mcp-config`, and let `jev-rank` cut the number of workers.
- Jev is an alpha endpoint and `fit` is a noul probability because no `score` question shape is published. The chat-completion fallback is mandatory, and the model id is recorded on every result.
- LinkedIn scraping is against its terms of service and runs on Renato's own account. The pacing and volume limits from job-hunt stay as they are; nothing LinkedIn-related is offered upstream.
- The 1-5 Global score and the 0-100 Jev fit are different scales with different meanings. They are reported side by side; no formula converts one into the other.

## Decisions for Renato

1. Fork under `rdbeltrao/career-ops` with job-hunt-private as the data root. Recommended: yes.
2. Jev's role in the score: gate plus inform (recommended), or replace the Global score.
3. LinkedIn fetch: keep the Python feeder (option A, recommended) or port to Node now (option B).
4. Notion sync: in-session through the connector with a shown diff (recommended first), or a token-based script on a schedule.
5. Whether to prepare upstream pull requests for the Jev evaluator and the preferences schema after phase 2.

## Calls made in this document

- `_context.md` is a targeting source and never evidence; the fact gate is not widened.
- The Jev question set lives in a YAML file in the data root, not in code, so wording changes do not touch the fork.
- Jev `skip` with a blocking reason is a hard stop unless overridden; everything else informs rather than decides.
- Interests older than 90 days since `confirmed_on` must be reconfirmed before they decide a verdict or a draft paragraph.
- The tracker source of truth moves from the CSV and Notion to `data/applications.md`; Notion becomes an export target.
