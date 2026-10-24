# Runbook: operating this career-ops fork

Last verified 2026-10-24. Paths are the ones on the machine where the fork was set up; adjust the two roots if they move.

## What is already set up

| Piece | Where | Notes |
|---|---|---|
| Code | `~/Projects/career-ops` (git remote `origin` = rdbeltrao/career-ops, `upstream` = career-ops-hq/career-ops) | Fork code lives on `main`. Upstream is merged with git, never with `node update-system.mjs apply`. |
| Data root | `~/Projects/job-hunt-private` (own private git repository) | Pointed at by the gitignored marker file `.career-ops-data` in the checkout. Every personal file lives here: `cv.md`, `config/profile.yml`, `config/jev-criteria.yml`, `config/notion-map.yml`, `config/cv-facts.json`, `modes/_context.md`, `modes/_profile.md`, `modes/_brief.md`, `modes/_custom.md`, `portals.yml`, `data/`, `reports/`, `output/`, `jds/`, `writing-samples/`. |
| Runner defaults | `~/Projects/career-ops/.env` (gitignored) | `CAREER_OPS_MODEL=anthropic/claude-sonnet-5.5`, `CAREER_OPS_MODEL_TIMEOUT_MS=300000`, `CAREER_OPS_MAX_TOKENS=16384`, `CAREER_OPS_REASONING=low`. No key in the file. |
| OpenRouter key | macOS Keychain, service `OPENROUTER_API_KEY_JOB_SEARCH` (fallback `OPENROUTER_API_KEY`) | Read by `lib/openrouter-key.mjs`; env or `.env` values win when present. |
| Agent CLI | `claude`, recorded in the data root `.env` as `CAREER_OPS_CLI=claude` | Used by `rank-pipeline.mjs`, `doctor.mjs`, the web UI and the batch runner. |
| LinkedIn feeder | `~/Projects/job-hunt` (Python, `uv`) | `searches.yaml`, `companies.yaml` and `creators.yaml` are symlinks into the data root. Logged-in browser profile at `~/.job-hunt/browser-profile`. |

Health check, any time:

```bash
cd ~/Projects/career-ops && node doctor.mjs
```

Expected: all checks pass; the only warning is the optional web UI dependencies.

## Daily: find and rank postings

Run these in order. Each step is safe to repeat; nothing here spends agent tokens except the optional chat step at the end.

1. LinkedIn, through your own saved searches (needs the browser login once: `uv run python -m jobs login`):

   ```bash
   cd ~/Projects/job-hunt && uv run python -m jobs run --data-root ~/Projects/job-hunt-private
   ```

   Fetches every enabled search in `searches.yaml` and every board in `companies.yaml`, then writes new openings as rows in `data/pipeline.md` with a JD file under `jds/feeder/`.

2. Company boards from `portals.yml` (141 tracked companies, zero tokens):

   ```bash
   cd ~/Projects/career-ops && node scan.mjs --since 14
   ```

   Title, location, age and blacklist filters apply; survivors are appended to `data/pipeline.md` Pending.

3. Jev pre-screen for every pending row without a `jev:` segment:

   ```bash
   cd ~/Projects/career-ops && node jev-rank.mjs
   ```

   Rows gain `| jev: {fit} {verdict} — {reasons}`. Rows with no JD on file and no ATS API are left unannotated; rerun after the feeder has supplied the JD, or pass nothing and let the ATS fetch try (`--no-fetch` disables it).

4. Read the result:

   ```bash
   grep '| jev: ' ~/Projects/job-hunt-private/data/pipeline.md | grep ' apply ' 
   ```

5. Evaluate every row Jev marked `apply` or `maybe`; only `skip` rows stay unevaluated (a maybe is not a no). Either in chat (open `claude` in `~/Projects/career-ops`, then `/career-ops pipeline`, or paste one URL or JD), or headless for one posting:

   ```bash
   cd ~/Projects/career-ops && node openrouter-runner.mjs evaluate "<posting url>"
   ```

   Pasted text works too: `node openrouter-runner.mjs evaluate < jd.txt`, with no blank line inside the text (the paste ends at the first empty line). The report lands in `reports/NNN-company-date.md` with `**Score:**` (LLM, 1-5) and `**Jev:**` side by side; a tracker TSV is written and merged with:

   ```bash
   cd ~/Projects/career-ops && node merge-tracker.mjs && node tracker.mjs sync
   ```

   For many rows at once, the batch runner drives the Claude CLI headless and skips rows Jev already ruled out:

   ```bash
   cd ~/Projects/career-ops && node sync-batch-input.mjs && bash batch/batch-runner.sh --skip-jev-verdict skip --limit 10
   ```

   The batch runner starts the agent CLI with `--dangerously-skip-permissions` on fetched posting text. Run it in a shell you are watching, not unattended.

## Per application

In a `claude` session inside `~/Projects/career-ops`:

- `/career-ops pdf <company-slug>`: tailored CV from `cv.md`, blocked by the fact gate when a number is not in `cv.md`, `article-digest.md` or `config/cv-facts.json`.
- `/career-ops cover <company-slug>`: cover letter; approve the draft in chat before the PDF.
- `/career-ops apply <report>`: application answers, with knockout-prone fields (visa, salary, notice, start date, on-site days, years, language level) marked for your confirmation; nothing is submitted.
- `/career-ops contacto <company>`: the person to write to and the message, structures in `templates/outreach.md`.
- `/career-ops email`, `/career-ops followup`, `/career-ops interview-prep <company>` as needed.
- Status changes go through `node set-status.mjs --report <num> Applied` (or `<tracker#>`), never by editing the table.

## Weekly: LinkedIn network and comments

```bash
cd ~/Projects/career-ops && node network-plan.mjs --out ~/Projects/job-hunt-private/output/network-plan-$(date +%F).md
```

Walk the plan (Connect, follow the company page, "I am interested"), then mark companies covered with `node network-plan.mjs --done "Company"`. For comments:

```bash
cd ~/Projects/job-hunt && uv run python -m jobs engage --out out/engage-pending.json
```

then `/career-ops engage` in chat with that file; record posted comments with `uv run python -m jobs engage --done <post url>`.

## When the records change

- Notion career records: in a `claude` session with the Notion connector authorised, `/career-ops notion-sync`. It builds a proposal, shows the diff from `node notion-sync-apply.mjs --dry-run`, and writes `modes/_context.md`, the `preferences` and `interests` blocks, `article-digest.md`, `config/cv-facts.json` and `data/career-profile.yml` only after you say yes. Never writes to Notion.
- Preferences by hand: edit `modes/_context.md` (what Jev reads) and the `preferences` and `interests` blocks in `config/profile.yml` (what the evaluation and drafts read); update `confirmed_on`, since modes ask again after 90 days. `node render-context.mjs` shows what the prompts will see.
- Scoring wording: `config/jev-criteria.yml` in the data root. Keys and labels are the contract; the sentences are yours.
- Search surface: `portals.yml` (`title_filter`, `location_filter`, `tracked_companies`, `search_queries`), `searches.yaml` for LinkedIn.
- Commit the data root after a session: `cd ~/Projects/job-hunt-private && git add -A && git commit -m "..."`.

## Keeping up with upstream

```bash
cd ~/Projects/career-ops && git fetch upstream && git merge upstream/main
```

Then `node test-all.mjs --quick`, `node validate-system-paths-coverage.mjs` and `node doctor.mjs`. Fork-owned files are listed in `lib/update-manifest.mjs` under "Fork-owned files" and in `config/local-paths.txt`; a new fork file goes in one of those two places or the coverage guard fails.

## Known limitations

- A posting whose location is only "Remote" with no country or region fails the location allow-list; the title filter still catches titles that say remote.
- Two tracker rows for the same posting can survive when one URL is a LinkedIn link and the other the ATS link; put `job id <id>` in both rows' notes to keep them apart, or run `node merge-tracker.mjs --backfill-urls` to add the URL column.
- The report's `**Date:**` line is written by the model; the file name carries the real date.
- The Jev `fit` is a probability scaled to 0-100 (no documented `score` question type); treat its 1-5 projection as a second opinion, not a replacement.
