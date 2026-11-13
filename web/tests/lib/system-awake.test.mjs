import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parsePowerState, systemAwakeStatus } from "../../src/lib/system-awake.mjs";
import { readScheduledStore, withScheduledStore } from "../../src/lib/scheduled-jobs-store.mjs";
import { runScheduledTick } from "../../scripts/scheduled-jobs-runner.mjs";

// `ioreg -r -c IOPMrootDomain -d 1`, reduced to the properties the gate reads.
const ioreg = ({ capabilities, lidClosed = false, lidCausesSleep = true }) => `+-o IOPMrootDomain  <class IOPMrootDomain, id 0x100000117, registered, matched, active, busy 0 (0 ms), retain 60>
    {
      "IOPMSystemSleepType" = 7
      "System Capabilities" = ${capabilities}
      "AppleClamshellCausesSleep" = ${lidCausesSleep ? "Yes" : "No"}
      "AppleClamshellState" = ${lidClosed ? "Yes" : "No"}
    }
`;

test("a full wake with the lid open is awake", () => {
  assert.deepEqual(parsePowerState(ioreg({ capabilities: 15 })), { awake: true, reason: null });
});

test("a dark wake (CPU and network only, no graphics) is not awake", () => {
  const state = parsePowerState(ioreg({ capabilities: 9 }));
  assert.equal(state.awake, false);
  assert.match(state.reason, /dark wake/i);
});

test("a full wake under a closed lid that is about to sleep again is not awake", () => {
  const state = parsePowerState(ioreg({ capabilities: 15, lidClosed: true, lidCausesSleep: true }));
  assert.equal(state.awake, false);
  assert.match(state.reason, /lid/i);
});

test("a closed lid that does not cause sleep (external display) is awake", () => {
  assert.deepEqual(parsePowerState(ioreg({ capabilities: 15, lidClosed: true, lidCausesSleep: false })), { awake: true, reason: null });
});

test("output without the capability property is treated as awake", () => {
  assert.deepEqual(parsePowerState("unexpected output"), { awake: true, reason: null });
  assert.deepEqual(parsePowerState(""), { awake: true, reason: null });
});

test("only macOS is probed, and a probe that fails never blocks a run", () => {
  let probed = 0;
  const darkWake = () => { probed += 1; return ioreg({ capabilities: 9 }); };
  assert.equal(systemAwakeStatus({ platform: "linux", readPowerState: darkWake }).awake, true);
  assert.equal(probed, 0);
  assert.equal(systemAwakeStatus({ platform: "darwin", readPowerState: darkWake }).awake, false);
  assert.equal(probed, 1);
  assert.equal(systemAwakeStatus({ platform: "darwin", readPowerState: () => { throw new Error("ioreg missing"); } }).awake, true);
});

test("a scheduled tick during a dark wake leaves the due job unclaimed for the next tick", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scheduled-darkwake-"));
  const storePath = path.join(root, "data", "scheduled-jobs.json");
  const jobId = "11111111-1111-4111-8111-111111111111";
  const startAt = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    await withScheduledStore(storePath, (store) => {
      store.jobs.push({ id: jobId, name: "Sweep", status: "active", engine: "full", filters: {}, timezone: "UTC", startAt, nextRunAt: startAt, every: 1, unit: "days", createdAt: startAt, updatedAt: startAt });
    });
    const before = fs.readFileSync(storePath, "utf8");

    const result = await runScheduledTick({
      root,
      argv: [],
      awake: () => ({ awake: false, reason: "dark wake" }),
      execute: () => { throw new Error("a scan must not start while the machine is asleep"); },
    });

    assert.deepEqual(result, { status: "deferred", reason: "dark wake" });
    assert.equal(fs.readFileSync(storePath, "utf8"), before);
    assert.equal(readScheduledStore(storePath).queue.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a manual run is not held back by the wake check", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-scheduled-manual-awake-"));
  const storePath = path.join(root, "data", "scheduled-jobs.json");
  const jobId = "11111111-1111-4111-8111-111111111111";
  const startAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    await withScheduledStore(storePath, (store) => {
      store.jobs.push({ id: jobId, name: "Sweep", status: "active", engine: "full", filters: {}, timezone: "UTC", startAt, nextRunAt: startAt, every: 1, unit: "days", createdAt: startAt, updatedAt: startAt });
    });
    const executed = [];
    const result = await runScheduledTick({
      root,
      argv: ["--job", jobId],
      awake: () => ({ awake: false, reason: "dark wake" }),
      execute: (_root, job) => { executed.push(job.id); return { state: "success", attempt: 1, rolesFound: 0, durationMs: 1, message: "ok" }; },
    });
    assert.deepEqual(executed, [jobId]);
    assert.equal(result.status, "success");
    assert.equal(readScheduledStore(storePath).runs[0].state, "success");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
