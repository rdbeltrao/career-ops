import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scheduledScanResult } from "../../src/lib/scheduled-scan-result.mjs";
import { executeJob, recordCompletion } from "../../scripts/scheduled-jobs-runner.mjs";
import { readScheduledStore } from "../../src/lib/scheduled-jobs-store.mjs";
import { runStatusTone } from "../../src/lib/scheduled-run-status.mjs";

test("unreadable, truncated and invalid counts never become successful empty scans", () => {
  for (const output of ["", "not json", "{}", '{"postingsKept":0,', '{"postingsKept":"0"}', '{"postingsKept":-1}']) {
    assert.throws(() => scheduledScanResult("full", output), /no complete, valid result receipt/);
  }
  const result = scheduledScanResult("full", 'Startup banner\n{"postingsKept":7}\n');
  assert.equal(result.rolesFound, 7);
  assert.equal(result.state, "success");
});

test("limited coverage and outages retain counts and report partial instead of success", () => {
  const result = scheduledScanResult("full", JSON.stringify({ postingsKept: 2, companiesScanned: 600, companiesAvailable: 28746, capHit: true, unreachableBoards: 4, postingsDroppedNoDate: 8, datasetStatus: { greenhouse: "ok", lever: "stale" }, stoppedByOutage: true }));
  assert.equal(result.rolesFound, 2);
  assert.equal(result.state, "partial");
  assert.match(result.message, /600 of 28746 companies/);
  assert.match(result.message, /rotating sample/);
  assert.match(result.message, /stopped before all sources finished/);
  assert.match(result.message, /lever/);
  assert.match(result.message, /4 boards unreachable/);
  assert.match(result.message, /8 postings excluded/);
  assert.equal(runStatusTone(result.state), "warning");
});

test("no company coverage is a failed scan", () => {
  assert.equal(scheduledScanResult("full", JSON.stringify({ postingsKept: 0, companiesScanned: 0, datasetStatus: { lever: "empty" } })).state, "failed");
  assert.equal(scheduledScanResult("linkedin", JSON.stringify({ version: "careerops.scan.receipt@1", added: 0, scanned: 1, found: 0, errors: [{ error: "login required" }] })).state, "failed");
});

test("directory progress, missing boards and unknown dates are reported separately", () => {
  const result = scheduledScanResult("full", JSON.stringify({ postingsKept: 2, companiesScanned: 60, companiesAvailable: 160,
    missingBoards: 4, unreachableBoards: 1, postingsKeptUndated: 1, coverage: { companiesTotal: 160, companiesCompleted: 159, remaining: 1 } }));
  assert.equal(result.state, "partial");
  assert.match(result.message, /4 boards returned HTTP 404 or 410/);
  assert.match(result.message, /1 boards unreachable/);
  assert.match(result.message, /159 of 160 boards checked/);
  assert.match(result.message, /next run continues saved progress/);
  assert.match(result.message, /1 matching role kept with unknown posting dates/);
  const complete = scheduledScanResult("full", JSON.stringify({ postingsKept: 0, companiesScanned: 0, missingBoards: 4,
    coverage: { companiesTotal: 4, companiesCompleted: 4, remaining: 0 } }));
  assert.equal(complete.state, "success", 'confirmed obsolete boards are not a transient outage');
  const unsaved = scheduledScanResult("full", JSON.stringify({ postingsKept: 2, coverageSaveError: "EACCES" }));
  assert.equal(unsaved.state, "partial");
  assert.equal(unsaved.rolesFound, 2);
  assert.match(unsaved.message, /Saved matches were retained/);
});

test("portal receipt explains zero matches and preserves saved jobs when some sources fail", () => {
  const result = scheduledScanResult("linkedin", JSON.stringify({ version: "careerops.scan.receipt@1", scanned: 9, found: 104, filtered: 99, duplicates: 3, added: 2, errors: [{ error: "Login required" }] }));
  assert.equal(result.state, "partial");
  assert.equal(result.rolesFound, 2);
  assert.match(result.message, /104 jobs read, 99 filtered out, 3 already known/);
  assert.match(result.message, /LinkedIn sign-in required/);
});

test("LinkedIn login failures provide recovery without authwall tracking URLs", () => {
  const result = scheduledScanResult("linkedin", JSON.stringify({ version: "careerops.scan.receipt@1", scanned: 1, found: 0, added: 0,
    errors: [{ error: "LinkedIn asked for a login or a checkpoint at https://www.linkedin.com/authwall?trk=private" }] }));
  assert.equal(result.state, "failed");
  assert.match(result.message, /Open LinkedIn settings/);
  assert.doesNotMatch(result.message, /trk=|authwall/);
});

test("runner retains persisted timeout results without retrying and rejects unsaved previews", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scan-timeout-"));
  fs.writeFileSync(path.join(root, "portals.yml"), "title_filter:\n  positive: [engineer]\n");
  try {
    for (const saved of [true, false]) {
      let attempts = 0;
      const result = await executeJob(root, { id: "11111111-1111-4111-8111-111111111111", engine: "full" }, { spawnFn: () => {
        attempts++;
        return { error: { code: "ETIMEDOUT" }, status: 0, stdout: JSON.stringify({ saved, stoppedEarly: true, postingsKept: 3, companiesScanned: 40 }) };
      } });
      assert.equal(attempts, 1);
      assert.equal(result.state, saved ? "partial" : "failed");
      assert.equal(result.rolesFound, saved ? 3 : 0);
      assert.match(result.message, /timed out after 25 minutes/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("signed-out LinkedIn schedules stop before launching a browser", async () => {
  let spawned = false;
  const result = await executeJob("/unused", { engine: "linkedin" }, {
    sessionFn: () => ({ state: "signed-out" }),
    spawnFn: () => { spawned = true; },
  });
  assert.equal(spawned, false);
  assert.equal(result.state, "failed");
  assert.match(result.message, /LinkedIn sign-in required/);
});

test("runner does not retry saved partial results or pretend malformed output means zero jobs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scan-result-"));
  const job = { id: "11111111-1111-4111-8111-111111111111", engine: "portals", filters: {} };
  fs.writeFileSync(path.join(root, "portals.yml"), "title_filter:\n  positive: [engineer]\n");
  try {
    let attempts = 0;
    const result = await executeJob(root, job, { spawnFn: () => {
      attempts++;
      return { status: 2, stdout: JSON.stringify({ version: "careerops.scan.receipt@1", scanned: 3, added: 2, errors: [{ error: "board offline" }] }) };
    } });
    assert.equal(attempts, 1);
    assert.equal(result.state, "partial");
    assert.equal(result.rolesFound, 2);
    const storePath = path.join(root, "data", "scheduled-jobs.json");
    await recordCompletion(storePath, { job }, result);
    assert.equal(readScheduledStore(storePath).runs[0].state, "partial");

    attempts = 0;
    const malformed = await executeJob(root, { ...job, engine: "full" }, { spawnFn: () => { attempts++; return { status: 0, stdout: "broken output" }; } });
    assert.equal(attempts, 1);
    assert.equal(malformed.state, "failed");
    assert.equal(malformed.message, "Scanner returned no complete, valid result receipt.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
