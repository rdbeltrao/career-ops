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
| LinkedIn searches | `providers.local/linkedin-browser.mjs` in the checkout; one `provider: linkedin-browser` entry per saved search in `portals.yml` (data root) | Fork-local, never offered upstream. Logged-in browser profile at `~/.job-hunt/browser-profile` (or `LINKEDIN_PROFILE_DIR`), signed in once with `node linkedin-login.mjs`. Opened job ids in `data/linkedin-seen.json`. |
| LinkedIn comments | `~/Projects/job-hunt` (Python, `uv`), `jobs engage` only | `creators.yaml` is a symlink into the data root. Shares the browser profile above. The Python fetch is no longer needed. |

Health check, any time:

```bash
cd ~/Projects/career-ops && node doctor.mjs
```

Expected: all checks pass; the only warning is the optional web UI dependencies.

## Cost rule

OpenRouter is for the Jev pre-screen only (cents per posting). Full evaluations, CVs, letters and answers run through the Claude subscription: `/career-ops pipeline` in a `claude` session, or `bash batch/batch-runner.sh` headless. `node openrouter-runner.mjs evaluate` refuses a paid pinned model unless `CAREER_OPS_ALLOW_PAID_OPENROUTER=1` is set for that shell; never set it. On 2026-10-24 about 83 dollars of credit went into 240 OpenRouter evaluations before this rule existed.

## Daily: find and rank postings

Run these in order. Each step is safe to repeat; nothing here spends agent tokens except the optional chat step at the end.

1. Sign in to LinkedIn once (a headed browser window opens on the login page; you type the credentials there, the script never does):

   ```bash
   cd ~/Projects/career-ops && node linkedin-login.mjs
   ```

   Exit 0 once the feed page shows, 1 after `LINKEDIN_LOGIN_TIMEOUT_MS` (default 300000). The profile keeps the session; repeat only when a scan reports a login wall. If Playwright has no Chromium yet: `npx playwright install chromium`.

2. Company boards and LinkedIn searches, both from `portals.yml` (zero tokens):

   ```bash
   cd ~/Projects/career-ops && node scan.mjs --since 14
   ```

   Each saved LinkedIn search is a `tracked_companies` entry routed to the fork-local provider; paste the search URL from the browser, without its `currentJobId`:

   ```yaml
   tracked_companies:
     - name: engineering-manager-germany-7d
       provider: linkedin-browser
       search_url: "https://www.linkedin.com/jobs/search/?f_TPR=r604800&f_WT=2%2C3&geoId=101282230&keywords=Engineering%20Manager&sortBy=DD"
       max_pages: 3      # optional, 25 cards per page, default 3
       enabled: true
   ```

   The HTTP boards run first; the LinkedIn searches run last, one at a time in random order, at a person's pace (1.5 to 4 s between cards, 5 to 10 s between pages). Keep the volume small: a few searches, 1 to 3 pages each, no cron. Each new card's detail pane is opened once; its id goes to `data/linkedin-seen.json` and is never reopened (delete the file to start over). Title, location, age and blacklist filters apply to every source; survivors are appended to `data/pipeline.md` Pending with `note: linkedin-browser {name}` for LinkedIn rows, and their JD is stored under `jds/feeder/linkedin-browser-{id}.json` so step 3 scores them without a fetch.

   A login, checkpoint or authwall page stops the LinkedIn part at once with a message naming the page and `node linkedin-login.mjs`; nothing is retried, the HTTP boards are unaffected, and the error shows in the scan summary. `--dry-run` walks the pages but leaves the seen file alone. `LINKEDIN_HEADED=1` shows the browser; `LINKEDIN_DUMP_DIR=/some/dir` keeps the list and detail HTML a run saw, which is how a selector gets fixed after a LinkedIn redesign (turn the saved HTML into a fixture under `tests/fixtures/linkedin/`). `node scan.mjs --company <name>` runs one search.

3. Jev pre-screen for every pending row without a `jev:` segment:

   ```bash
   cd ~/Projects/career-ops && node jev-rank.mjs
   ```

   Rows gain `| jev: {fit} {verdict} — {reasons}`. Rows with no JD on file and no ATS API are left unannotated; rerun after the feeder has supplied the JD, or pass nothing and let the ATS fetch try (`--no-fetch` disables it).

4. Read the result:

   ```bash
   grep '| jev: ' ~/Projects/job-hunt-private/data/pipeline.md | grep ' apply ' 
   ```

5. Evaluate every row Jev marked `apply` or `maybe`; only `skip` rows stay unevaluated (a maybe is not a no). In chat (open `claude` in `~/Projects/career-ops`, then `/career-ops pipeline`, or paste one URL or JD), or headless through the subscription:

   ```bash
   cd ~/Projects/career-ops && node sync-batch-input.mjs && bash batch/batch-runner.sh --skip-jev-verdict skip
   ```

   The report lands in `reports/NNN-company-date.md` with `**Score:**` (LLM, 1-5) and `**Jev:**` side by side; a tracker TSV is written and merged with:

   ```bash
   cd ~/Projects/career-ops && node merge-tracker.mjs && node tracker.mjs sync
   ```

   For many rows at once, the batch runner drives the Claude CLI headless and skips rows Jev already ruled out:

   ```bash
   cd ~/Projects/career-ops && node sync-batch-input.mjs && bash batch/batch-runner.sh --skip-jev-verdict skip --limit 10
   ```

   The batch runner starts the agent CLI with `--dangerously-skip-permissions` on fetched posting text. Run it in a shell you are watching, not unattended.

## Scheduled run and dashboard service

Two launchd agents in `~/Library/LaunchAgents` (installed 2026-10-25):

- `com.rdbeltrao.career-ops-daily` runs `fork/scripts/daily.sh` at 07:30 every day: scan, jev-rank, batch through the Claude subscription (`--skip-jev-verdict skip --skip-pdf --parallel 2`), tracker sync, data-root commit. Log: `job-hunt-private/output/logs/daily-YYYY-MM-DD.log`. If the Mac is asleep at 07:30, launchd runs it at the next wake. A LinkedIn login wall stops only the LinkedIn targets; run `node linkedin-login.mjs` and the next day picks them up.
- `com.rdbeltrao.career-ops-ui` keeps the dashboard at http://localhost:3000 alive (`node scripts/ui-server.mjs`, KeepAlive, starts at login). Logs: `output/logs/ui.out` and `ui.err`.

```bash
launchctl kickstart -k gui/501/com.rdbeltrao.career-ops-daily   # run the daily job now
launchctl bootout gui/501/com.rdbeltrao.career-ops-ui            # stop the dashboard service
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.rdbeltrao.career-ops-ui.plist   # start it again
```

The batch runner starts `claude -p --dangerously-skip-permissions` workers on fetched posting text; the scheduled run is unattended by design, so keep `data/blacklist.md` and the dealbreakers current and read the daily log.

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
- Search surface: `portals.yml` (`title_filter`, `location_filter`, `tracked_companies` including the `provider: linkedin-browser` entries, `search_queries`). `searches.yaml` in the Python repo is no longer read by anything in the daily run.
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
