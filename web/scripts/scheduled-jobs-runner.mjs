#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import {
  isSafeScheduledId,
  withResourceLock,
  withScheduledStore,
} from "../src/lib/scheduled-jobs-store.mjs";
import { nextScheduledRun } from "../src/lib/scheduled-cadence.mjs";
import { isMainModule } from "../../lib/is-main-module.mjs";
import { scheduledRunnerResourcePath, scheduledStorePath } from "../src/lib/scheduled-runner-path.mjs";
import { getCareerOpsRoot } from "../../path-resolver.mjs";
import { getProfilePath } from "../src/lib/core/profile-path.mjs";
import { scanFailureMessage } from "../src/lib/scheduled-scan-error.mjs";
import { scheduledScanResult } from "../src/lib/scheduled-scan-result.mjs";
import { runScheduledScanner } from "../src/lib/scheduled-scan-process.mjs";
import { sessionStatus, readCrawlStatus } from "../../lib/linkedin-session.mjs";
import { jevAutoLogPath, startJevPass } from "../../lib/jev-auto.mjs";
import { evaluateLogPath, startEvaluatePass } from "../../lib/auto-evaluate.mjs";
import { parsePendingJev } from "../../jev-rank.mjs";

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const MAX_RUNS = 100;
export const MAX_ATTEMPTS = 3;
export const SCAN_TIMEOUT_MS = 25 * 60 * 1_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const QUEUE_CLAIM_STALE_MS = 30 * 1_000;

const nowIso = () => new Date().toISOString();

export const nextFutureRun = nextScheduledRun;

export function enqueueDueJobs(store, nowMs = Date.now()) {
  let queued = 0;
  for (const job of store.jobs) {
    if (job.status !== "active") continue;
    const dueAt = job.nextRunAt || job.startAt;
    const dueMs = Date.parse(dueAt);
    if (!Number.isFinite(dueMs) || dueMs > nowMs) continue;

    if (!store.queue.some((item) => item.jobId === job.id)) {
      store.queue.push({ id: randomUUID(), jobId: job.id, queuedAt: new Date(nowMs).toISOString() });
      queued += 1;
    }

    const nextRunAt = nextScheduledRun(job.startAt, job.every, job.unit, nowMs, job.timezone || "UTC");
    if (nextRunAt) job.nextRunAt = nextRunAt;
    job.updatedAt = new Date(nowMs).toISOString();
  }
  return queued;
}

function claimIsStale(item, nowMs) {
  if (!item.claimToken || !item.claimedAt) return false;
  const claimedMs = Date.parse(item.claimedAt);
  return !Number.isFinite(claimedMs) || nowMs - claimedMs >= QUEUE_CLAIM_STALE_MS;
}

function claimQueueItem(store, item, job, nowMs) {
  if (item.claimToken && !claimIsStale(item, nowMs)) return null;
  if (item.claimToken) {
    const staleRun = item.runId && store.runs.find((run) => run.id === item.runId);
    if (staleRun) {
      staleRun.state = "queued";
      staleRun.message = "Requeued after an interrupted worker.";
    }
  }
  const claimToken = randomUUID();
  item.claimToken = claimToken;
  item.claimedAt = new Date(nowMs).toISOString();
  if (!item.runId || !isSafeScheduledId(item.runId)) item.runId = randomUUID();
  const run = store.runs.find((candidate) => candidate.id === item.runId);
  if (run) {
    run.state = "running";
    run.at = new Date(nowMs).toISOString();
    run.attempt = (run.attempt || 0) + 1;
  } else {
    store.runs.unshift({ id: item.runId, jobId: job.id, at: new Date(nowMs).toISOString(), state: "running", attempt: 1, engine: job.engine || "full" });
  }
  return { job: structuredClone(job), queueId: item.id, runId: item.runId, claimToken };
}

export function claimDueJob(store, nowMs = Date.now()) {
  for (const item of store.queue) {
    const job = store.jobs.find((candidate) => candidate.id === item.jobId && candidate.status === "active");
    if (!job) continue;
    const claim = claimQueueItem(store, item, job, nowMs);
    if (claim) return claim;
  }
  return null;
}

export function claimManualJob(store, jobId, nowMs = Date.now()) {
  const job = store.jobs.find((candidate) => candidate.id === jobId && candidate.status !== "deleted");
  if (!job) return null;
  let item = store.queue.find((candidate) => candidate.jobId === jobId);
  if (!item) {
    item = { id: randomUUID(), jobId, queuedAt: new Date(nowMs).toISOString() };
    store.queue.push(item);
  }
  return claimQueueItem(store, item, job, nowMs);
}

export const runnerResourcePath = scheduledRunnerResourcePath;

function numericFilter(value, fallback, minimum, maximum = Number.POSITIVE_INFINITY) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

const LINKEDIN_PROVIDER = "linkedin-browser";

/** The job's list when it has one, else the list portals.yml already holds. */
function keepUnlessSet(jobList, baseList) {
  const set = Array.isArray(jobList) ? jobList.filter((v) => typeof v === "string" && v.trim()) : [];
  if (set.length) return set;
  return Array.isArray(baseList) ? baseList : [];
}

/**
 * A LinkedIn-only schedule's portals overlay. The user's portals.yml filters
 * stay in force; a field the schedule sets replaces only that filter. Searches
 * the schedule did not choose are switched off for the run (a search that is
 * off in portals.yml stays off).
 */
function linkedinOverlay(base, job) {
  const filters = job.filters || {};
  const title = base.title_filter || {};
  base.title_filter = { ...title, positive: keepUnlessSet(filters.positive, title.positive), negative: keepUnlessSet(filters.negative, title.negative) };
  if (!base.title_filter.positive.length) throw new Error("Scheduled scans require title keywords in the job or portals.yml title_filter.positive.");
  const loc = base.location_filter || {};
  base.location_filter = {
    ...loc,
    allow: keepUnlessSet(filters.allow, loc.allow),
    block: keepUnlessSet(filters.block, loc.block),
    block_hard: keepUnlessSet(filters.blockHard, loc.block_hard),
    always_allow: keepUnlessSet(filters.alwaysAllow, loc.always_allow),
  };
  const chosen = Array.isArray(job.linkedin?.searches) ? job.linkedin.searches.filter((n) => typeof n === "string" && n.trim()).map((n) => n.trim()) : [];
  const entries = Array.isArray(base.tracked_companies) ? base.tracked_companies : [];
  let running = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || entry.provider !== LINKEDIN_PROVIDER) continue;
    const on = entry.enabled !== false && (chosen.length === 0 || chosen.includes(String(entry.name ?? "").trim()));
    if (!on) entry.enabled = false;
    else {
      running += 1;
      if (job.linkedin?.useSearchWindow === false) {
        // Widen the source search too: --since alone cannot recover jobs
        // LinkedIn omitted because its saved URL still asked for seven days.
        const searchUrl = new URL(entry.search_url);
        searchUrl.searchParams.set("f_TPR", `r${numericFilter(filters.sinceDays, 7, 1) * 86_400}`);
        entry.search_url = searchUrl.href;
      }
    }
  }
  if (running === 0) {
    throw new Error(chosen.length
      ? "None of the LinkedIn searches this schedule runs is on in portals.yml (renamed, removed or switched off). Edit the schedule."
      : "No LinkedIn search is on in portals.yml. Add or switch one on in the LinkedIn page.");
  }
  return base;
}

export function buildScanCommand(job) {
  const filters = job.filters || {};
  const sinceDays = numericFilter(filters.sinceDays, 7, 1);
  if (job.engine === "portals") {
    return {
      script: "scan.mjs",
      args: ["--since", String(sinceDays), "--quiet", "--json"],
    };
  }
  // The LinkedIn searches alone (the linkedin-browser entries of portals.yml),
  // read through the signed-in crawl profile. Each search carries its own
  // LinkedIn date window (f_TPR), so by default no --since narrows it.
  if (job.engine === "linkedin") {
    const window = job.linkedin?.useSearchWindow === false ? ["--since", String(sinceDays)] : [];
    return {
      script: "scan.mjs",
      args: [...window, "--quiet", "--provider", LINKEDIN_PROVIDER, "--json"],
    };
  }

  const ats = Array.isArray(filters.ats) && filters.ats.length
    ? filters.ats.join(",")
    : "greenhouse,lever,ashby,workday";
  return {
    script: "scan-ats-full.mjs",
    // Complete the directory over bounded runs instead of repeatedly sampling
    // 150 random employers. Each schedule owns its progress independently.
    args: ["--since", String(sinceDays), "--ats", ats, "--coverage-state",
      `data/cache/scheduled-coverage/${job.id || "default"}.json`, "--include-undated", "--history-seeds", "--json"],
  };
}

export function extractRolesFound(engine, stdout) {
  // Keep the legacy human-summary reader for callers with old saved output.
  if (engine !== "full" && !stdout.includes("{")) {
    const match = stdout.match(/New offers added:\s*(\d+)/i);
    if (match) return Number(match[1]);
  }
  return scheduledScanResult(engine, stdout).rolesFound;
}

function writeJobPortals(root, job) {
  if (!isSafeScheduledId(job.id)) throw new Error("Invalid scheduled job identifier.");
  const portalsPath = path.join(root, "portals.yml");
  const base = yaml.load(fs.readFileSync(portalsPath, "utf8"));
  if (!base || typeof base !== "object") throw new Error("portals.yml must contain a mapping");

  if (job.engine === "linkedin") {
    const overlay = linkedinOverlay(base, job);
    const tempDir = path.join(root, "data", "tmp");
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `scheduled-${job.id}-${randomUUID()}.yml`);
    fs.writeFileSync(tempPath, yaml.dump(overlay, { lineWidth: 120, noRefs: true }), "utf8");
    return tempPath;
  }

  const filters = job.filters || {};
  const positive = Array.isArray(filters.positive)
    ? filters.positive.filter((value) => typeof value === "string" && value.trim())
    : [];
  const fallbackPositive = Array.isArray(base.title_filter?.positive)
    ? base.title_filter.positive.filter((value) => typeof value === "string" && value.trim())
    : [];
  if (!positive.length && !fallbackPositive.length) {
    throw new Error("Scheduled scans require title keywords in the job or portals.yml title_filter.positive.");
  }
  base.title_filter = {
    ...(base.title_filter || {}),
    positive: positive.length ? positive : fallbackPositive,
    negative: Array.isArray(filters.negative) ? filters.negative : [],
  };
  if (base.title_filter_full) base.title_filter_full = { ...base.title_filter_full, ...base.title_filter };
  base.location_filter = {
    ...(base.location_filter || {}),
    allow: Array.isArray(filters.allow) ? filters.allow : [],
    block: Array.isArray(filters.block) ? filters.block : [],
    block_hard: Array.isArray(filters.blockHard) ? filters.blockHard : [],
    always_allow: Array.isArray(filters.alwaysAllow) ? filters.alwaysAllow : [],
  };

  const tempDir = path.join(root, "data", "tmp");
  fs.mkdirSync(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `scheduled-${job.id}-${randomUUID()}.yml`);
  fs.writeFileSync(tempPath, yaml.dump(base, { lineWidth: 120, noRefs: true }), "utf8");
  return tempPath;
}

/*
 * Keep the temporary portal overlay scoped to each retry. A thrown setup or
 * spawn error is retryable just like a non-zero scanner exit, while cleanup
 * still runs before the next attempt. A scanner that ran into the timeout is
 * not retried: the same sweep would hit the same limit, three times over.
 */

// The scanner and the Jev pass both run with cwd = the checkout; a relative
// profile override is resolved here, the way the web resolves it, so every
// child reads one file.
function childEnv(root) {
  return {
    ...process.env,
    CAREER_OPS_ROOT: root,
    ...(process.env.CAREER_OPS_PROFILE?.trim() ? { CAREER_OPS_PROFILE: getProfilePath(root) } : {}),
  };
}

export async function executeJob(root, job, options = {}) {
  const spawnFn = options.spawnFn || runScheduledScanner;
  const startedAt = Date.now();
  let lastError = "Scan failed";
  let finalAttempt = MAX_ATTEMPTS;

  if (job.engine === "linkedin") {
    const session = (options.sessionFn || (() => sessionStatus({ crawl: readCrawlStatus(root) })))();
    if (["no-profile", "signed-out", "expired", "sign-in-needed"].includes(session.state)) {
      return { state: "failed", attempt: 1, rolesFound: 0, durationMs: Date.now() - startedAt,
        message: "LinkedIn sign-in required. Open LinkedIn settings and sign in to the scan browser, then run this schedule again." };
    }
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let tempPortals = null;
    try {
      tempPortals = writeJobPortals(root, job);
      const command = buildScanCommand(job);
      const result = await spawnFn(
        process.execPath,
        [command.script, ...command.args],
        {
          cwd: CODE_ROOT,
          env: { ...childEnv(root), CAREER_OPS_PORTALS: tempPortals,
            // Browser scans finish their current posting, then let scan.mjs
            // filter and persist results before the outer process deadline.
            CAREER_OPS_SCAN_DEADLINE_MS: String(Date.now() + SCAN_TIMEOUT_MS - 120_000) },
          timeout: SCAN_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
        },
      );

      // SIGTERM can produce a complete, persisted partial receipt. Keep its
      // count; retrying would lose it to dedup. An unsaved preview is not enough.
      if (result.error?.code === "ETIMEDOUT" && job.engine === "full") {
        try {
          const receipt = JSON.parse(result.stdout || "");
          if (receipt.stoppedEarly === true && receipt.saved === true) {
            const outcome = scheduledScanResult("full", result.stdout);
            return { ...outcome, state: outcome.state === "failed" ? "failed" : "partial", attempt,
              durationMs: Date.now() - startedAt,
              message: `${scanFailureMessage(result, { timeoutMs: SCAN_TIMEOUT_MS })} ${outcome.message}` };
          }
        } catch { /* No usable persisted result: report the timeout below. */ }
      }

      // scan.mjs exits 2 with a valid receipt when some sources failed. It has
      // already saved its matches, so rerunning would obscure the first count.
      if (!result.error && (result.status === 0 || (result.status === 2 && command.script === "scan.mjs"))) {
        try {
          const outcome = scheduledScanResult(job.engine || "full", result.stdout || "");
          return { ...outcome, attempt, durationMs: Date.now() - startedAt };
        } catch (error) {
          lastError = error.message;
          finalAttempt = attempt;
          break;
        }
      }
      lastError = scanFailureMessage(result, { timeoutMs: SCAN_TIMEOUT_MS });
      if (result.error?.code === "ETIMEDOUT") {
        finalAttempt = attempt;
        break;
      }
    } catch (error) {
      lastError = scanFailureMessage({ error });
    } finally {
      if (tempPortals) {
        try {
          fs.rmSync(tempPortals, { force: true });
        } catch {
          // Temporary filter cleanup is best effort.
        }
      }
    }
  }

  return {
    state: "failed",
    attempt: finalAttempt,
    rolesFound: 0,
    durationMs: Date.now() - startedAt,
    message: lastError,
  };
}

/*
 * Rows are normally pre-screened and evaluated the moment they are written:
 * appendToPipeline() starts a Jev pass (lib/jev-auto.mjs), and the Jev pass
 * starts the full evaluation (lib/auto-evaluate.mjs). A writer that edits
 * data/pipeline.md directly (the LinkedIn feeder, a hand edit) skips both, and
 * a run can stop early (no Claude usage left, the Mac went to sleep). So every
 * runner tick checks the pending rows: rows without a jev: segment start a Jev
 * pass (which then starts the evaluation), and rows Jev did not mark skip start
 * an evaluation directly. Each restarts at most once per HEAL_COOLDOWN_MS,
 * measured from its last log write, so a row that keeps failing is not retried
 * every 15 minutes.
 */
export const HEAL_COOLDOWN_MS = 60 * 60 * 1_000;

function recentlyRan(logPath, nowMs) {
  return fs.existsSync(logPath) && nowMs - fs.statSync(logPath).mtimeMs < HEAL_COOLDOWN_MS;
}

export function healUnscoredRows(root, options = {}) {
  const startJev = options.startJev || startJevPass;
  const startEvaluate = options.startEvaluate || startEvaluatePass;
  const nowMs = options.nowMs ?? Date.now();
  try {
    const pipelinePath = path.join(root, "data", "pipeline.md");
    if (!fs.existsSync(pipelinePath)) return { started: false, reason: "no pipeline" };
    const text = fs.readFileSync(pipelinePath, "utf8");
    if (parsePendingJev(text).length) {
      if (recentlyRan(jevAutoLogPath(root), nowMs)) return { started: false, reason: "recent pass" };
      return startJev({ dataRoot: root });
    }
    const awaiting = text.split(/\r?\n/).filter((line) => /^- \[ \]\s/.test(line) && !/\|\s*jev:\s*\d+\s+skip\b/.test(line)).length;
    if (!awaiting) return { started: false, reason: "nothing to score" };
    if (recentlyRan(evaluateLogPath(root), nowMs)) return { started: false, reason: "recent pass" };
    return { ...startEvaluate({ dataRoot: root }), evaluate: true };
  } catch (error) {
    return { started: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function recordCompletion(storePath, claim, result, inMemoryStore = null) {
  const at = nowIso();
  const apply = (store) => {
    const job = claim.job;
    const queueItem = claim.queueId && store.queue.find((item) => item.id === claim.queueId && item.claimToken === claim.claimToken);
    // A stale worker may finish after another worker reclaimed the item. Its
    // result must not overwrite the newer claim's run or job metadata.
    if (claim.queueId && !queueItem) return;
    const current = store.jobs.find((item) => item.id === job.id);
    if (current) {
      current.lastRunAt = at;
      current.rolesFoundCount = result.rolesFound;
      current.updatedAt = at;
      if (result.state === "failed" || result.state === "partial") current.lastError = result.message;
      else delete current.lastError;
    }

    const run = store.runs.find((item) => item.id === claim.runId && item.jobId === job.id);
    if (run) Object.assign(run, { at, durationMs: result.durationMs, state: result.state, attempt: result.attempt, message: result.message, rolesFound: result.rolesFound, engine: job.engine || "full" });
    else store.runs.unshift({ id: claim.runId || randomUUID(), jobId: job.id, at, durationMs: result.durationMs, state: result.state, attempt: result.attempt, message: result.message, rolesFound: result.rolesFound, engine: job.engine || "full" });
    store.queue = store.queue.filter((item) => !(item.id === claim.queueId && item.claimToken === claim.claimToken));
    if (store.runs.length > MAX_RUNS) store.runs = store.runs.slice(0, MAX_RUNS);
  };
  if (inMemoryStore) apply(inMemoryStore);
  else await withScheduledStore(storePath, apply);
}

async function takeDueJob(storePath) {
  return withScheduledStore(storePath, (store) => {
    enqueueDueJobs(store);
    return claimDueJob(store);
  });
}

function requestedJobId(args) {
  const index = args.indexOf("--job");
  return index >= 0 ? args[index + 1] || null : null;
}

async function main() {
  const root = getCareerOpsRoot();
  healUnscoredRows(root);
  const storePath = scheduledStorePath(root);
  const runnerResource = runnerResourcePath(storePath);
  const manualJobId = requestedJobId(process.argv.slice(2));

  return withResourceLock(
    runnerResource,
    async () => {
      let claim;
      if (manualJobId) {
        if (!isSafeScheduledId(manualJobId)) throw new Error("Invalid scheduled job identifier.");
        claim = await withScheduledStore(storePath, (store) => {
          const job = store.jobs.find((item) => item.id === manualJobId && item.status !== "deleted");
          if (!job) throw new Error("Scheduled job not found.");
          const manualClaim = claimManualJob(store, manualJobId);
          if (!manualClaim) throw new Error("Scheduled job is already running.");
          return manualClaim;
        });
      } else {
        claim = await takeDueJob(storePath);
      }

      if (!claim) return { status: "idle" };

      const result = await executeJob(root, claim.job);
      await recordCompletion(storePath, claim, result);
      if (result.state === "failed") throw new Error(result.message);
      return { status: "success", jobId: claim.job.id, ...result };
    },
    { timeoutMs: 1_000, staleMs: SCAN_TIMEOUT_MS * MAX_ATTEMPTS + 60_000 },
  );
}

if (isMainModule(import.meta.url)) {
  main()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
