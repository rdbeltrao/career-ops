# Jev: the calibrated pre-screen

Jev is a typed decision model served through OpenRouter's decisions endpoint
(`typesafe/jev-1.13`). Given a state (the candidate's context and one posting)
and a fixed set of questions, it answers each question with a label and a
calibrated confidence. career-ops uses it as a deterministic pre-screen that
runs before the LLM evaluation, costs no agent tokens, and is shown next to the
LLM's Global score — never averaged with it.

What Jev decides: `fit` 0-100, a `verdict` (apply / maybe / skip) and five
reasons. What it never decides: the Global score (`modes/_shared.md` keeps
that holistic and 1-5), whether to apply, or anything that gets written to the
tracker. It reads the posting as data, never as instructions (`AGENTS.md`,
"Untrusted External Content").

## The seven questions

The question set lives in `config/jev-criteria.yml` in your data root; the
checkout ships `config/jev-criteria.example.yml` with generic wording. The
**keys and labels are the contract** (the scripts build requests and parse
answers from them); the sentences are yours to tune.

| Key | Type | Labels |
|---|---|---|
| `fit` | noul (probability, scaled to 0-100) | — |
| `verdict` | choice | `apply`, `maybe`, `skip` |
| `seniority_match` | choice | `below`, `match`, `above` |
| `location_ok` | choice | `yes`, `no`, `unclear` |
| `language_blocker` | choice | `none`, `missing`, `partial` |
| `team_type` | choice | `product`, `platform_infra`, `unclear` |
| `stack_fit` | choice | `required_match`, `desired_match`, `stack_agnostic`, `required_mismatch` |

`reason_questions` lists the five choice questions whose answers are reported
as the reasons, in that order. `blocking_answers` names the answers that turn
a `skip` into a hard stop before Block A of the evaluation:
`seniority_match` in {below, above}, `location_ok` = no, `language_blocker` =
missing, `stack_fit` = required_mismatch. An interactive run can say
"evaluate anyway"; a headless run reports `needs_confirmation`.

Jev's own 1-5 score is `round(1 + 4 * fit / 100, 1)`: fit 79 is 4.2, fit 50
is 3.0. It exists so the two scores can sit in one column; it is not a second
Global score.

## The candidate context

Jev reads `modes/_context.md` from the data root whole, as `state.profile`.
That file is a **targeting source, never evidence**: it steers scores and
framing, and a number that exists only there still fails the CV fact gate.
When the file is absent the scripts fall back to `cv.md` followed by the
`config/profile.yml` text and print one line on stderr:

```
jev-score: modes/_context.md not found, using cv.md + profile.yml
```

Descriptions longer than `max_description_chars` (6000) are cut with
`[truncated]` before they are sent.

## `jev-score.mjs`: one job

```bash
node jev-score.mjs --job job.json                      # JSON result on stdout
node jev-score.mjs --job - --format markdown < job.json
node jev-score.mjs --job job.json --format segment     # the pipeline segment text
node jev-score.mjs --job job.json --context ~/x/_context.md --criteria ./my-criteria.yml
node jev-score.mjs --self-test                         # no network
```

The job JSON is `{ "url", "title", "company", "location", "workplace",
"seniority", "description", "salary"?, "posted_date"? }`; unknown keys are
ignored.

Default output (`--format json`):

```json
{ "model": "typesafe/jev-1.13", "fit": 79, "score": 4.2, "verdict": "apply",
  "reasons": { "seniority_match": "match", "location_ok": "yes", "language_blocker": "none",
               "team_type": "product", "stack_fit": "stack_agnostic" },
  "confidences": { "seniority_match": 0.91 }, "probabilities": {},
  "blocking": [], "fallback": false, "error": null }
```

`fit` and `score` are `null` when Jev gave no usable number. `blocking` lists
`"{key}={label}"` strings. Exit codes: **0** scored, **2** no API key (stderr
names `OPENROUTER_API_KEY`), **1** API or parse failure (`error` filled, every
other field null) or bad input.

`--format markdown` prints the block the prompts carry:

```
## Calibrated pre-screen (Jev)

model: typesafe/jev-1.13 | fit: 79/100 | jev_score: 4.2/5 | verdict: apply
seniority_match: match (0.91) | location_ok: yes (0.88) | language_blocker: none (0.95) | team_type: product (0.70) | stack_fit: stack_agnostic (0.66)
blocking: none
```

When the pre-screen did not run the block is
`## Calibrated pre-screen (Jev)` followed by `not run: {reason}`.

## `jev-rank.mjs`: the pending pipeline rows

```bash
node jev-rank.mjs                   # score up to 50 pending rows
node jev-rank.mjs --limit 20 --no-fetch
node jev-rank.mjs --dry-run         # print the annotations, write nothing
```

For every `- [ ]` row of `data/pipeline.md` without a `| jev: ` segment the
script finds the JD (the feeder store below first, then the posting's own ATS
API through `fetchJdViaKnownApi`, never a browser), asks Jev, and appends the
segment as the row's last labeled segment, after `rank:`:

```
| jev: 79 apply — seniority match, location yes, language none, product, stack agnostic
```

The reasons are `seniority {v}, location {v}, language {v}, {team_type},
stack {v}` with underscores turned into spaces, sanitised like every other
pipeline cell and capped at 140 characters. The pass annotates and never
filters, reorders or deletes a row. A row with no JD anywhere is left
unchanged and counted; a failed call is left unchanged and counted; a result
without a usable fit is never written as `jev: 0`. Re-runs are idempotent.
The summary line is:

```
jev-rank: {scored} scored, {noJd} without JD, {failed} failed, {skipped} already annotated
```

`--limit` defaults to 50 with a ceiling of 500. Writes go through
`pipeline-lock.mjs` and the file is re-read inside the lock. Exit 2 without a
key, before anything is touched.

### The feeder JD store

The job-hunt feeder (`python -m jobs pipeline --data-root ...`) writes a
pipeline row per new opening and the full job object next to it, so
`jev-rank.mjs` scores without opening the posting again. `lib/jd-store.mjs`
is the Node side of that contract:

- `{DATA_ROOT}/jds/feeder/{source}-{source_id}.json`: the job object above
  plus `source`, `source_id`, `first_seen`, `search_name`.
- `{DATA_ROOT}/data/jd-index.tsv`: `url\tpath\tsource\tsource_id\tfirst_seen`,
  `path` relative to the data root, append-only, one row per URL.

`readJdForUrl(url, { dataRoot })` matches the URL exactly, then with a
trailing slash added or removed. `writeJd(job, { dataRoot })` returns
`{ path, appended }` and appends the index row only when the URL is new.

## The Machine Summary block

Every evaluation report's Machine Summary carries the result (or `jev: null`
when the pre-screen did not run); the report header shows
`**Jev:** 4.2/5 (fit 79, apply)` under `**Score:**`.

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

`node calibrate.mjs --jev` reads that block per tracker row and prints "Jev
score bands" and "Jev verdicts" tables next to the LLM score bands, with the
same outcome evidence and sample floor, so Jev's calibrated probability can
be compared with your real outcomes. `--json --jev` adds
`jev: { resolved, scored, notRun, noReport, bands, verdicts }`.

## The fallback

Some OpenRouter accounts restrict the providers a request may use; when the
typesafe provider is excluded the decisions endpoint answers HTTP 404 "No
allowed providers are available". `jev-score.mjs` then asks an ordinary chat
model the same questions through chat completions with a strict JSON schema
built from the criteria (`fit` integer 0-100, one enum per choice question,
`*_confidence` numbers, `reasoning`), says so on stderr, and tags the result
`fallback: true` with `model` set to the chat model: `JOB_HUNT_SCORE_MODEL`
when set, else `anthropic/claude-haiku-5.5`. There are no retries; each call
has one 60 s timeout (`--timeout-ms`). `jev-rank.mjs` keeps going through the
rest of its batch after a fallback.

## The key

`lib/openrouter-key.mjs` resolves the key once, in this order, trying
`OPENROUTER_API_KEY_JOB_SEARCH` before `OPENROUTER_API_KEY` at every step:

1. the process environment;
2. `.env` in the checkout (the file `openrouter-runner.mjs` reads);
3. `.env` in the data root (`CAREER_OPS_DATA_DIR`);
4. the macOS Keychain, as a generic password whose service is the variable
   name and whose account is the current user:

   ```bash
   security add-generic-password -a "$USER" -s OPENROUTER_API_KEY_JOB_SEARCH -w
   ```

The job-search name wins so a key on a separate OpenRouter account can sit
next to a general-purpose key. The scripts never print the key.
`CAREER_OPS_SKIP_KEYCHAIN=1` skips step 4 (tests and CI use it);
`OPENROUTER_BASE_URL` points the scripts at another host (tests use a local
server) and is not a provider switch.

## Tuning `config/jev-criteria.yml`

1. Copy `config/jev-criteria.example.yml` to `config/jev-criteria.yml` in your
   data root. The data-root file wins; `--criteria <path>` wins over both.
2. Rewrite the `preamble` and each question's `instructions` and label
   descriptions in your own terms: what level you target, which languages
   block, which team types are a minus, what your core stack is. Jev reads
   the profile text too, so wording that points at "the profile's preferences"
   works; wording that restates a fact already in `modes/_context.md` is
   harmless.
3. Keep every key and every label. Removing `verdict`, dropping a label, or
   naming a blocking answer that is not one of the labels makes the loader
   refuse the file with the problems listed.
4. `max_description_chars` can go down to keep requests small; it rarely
   needs to go up.
5. Check a change with `node jev-score.mjs --job <a posting you know>
   --format markdown` and, over time, with `node calibrate.mjs --jev`.
