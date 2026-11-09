/**
 * apply-tracker-note.test.mjs: the apply flow's tracker notes (`override: ...`
 * and `cv: ...`) go through set-status.mjs, the canonical writer, with the
 * row's current state so the status is a no-op and only the note lands
 * (web/src/lib/apply/tracker-note.ts).
 *
 * The argv is pinned without spawning; then the real CLI is run once against a
 * scratch tracker, so the note's spelling and idempotency are the CLI's, not a
 * mock's. That run needs the core checkout's own dependencies, which web CI
 * does not install, so it skips itself when the CLI cannot load.
 *
 * Run (from web/):  node --test tests/lib/apply-tracker-note.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "../helpers/web-ts-alias-loader.mjs";

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { appendTrackerNote, trackerNoteArgs } = await import("../../src/lib/apply/tracker-note.ts");
const { runSetStatus } = await import("../../src/lib/core-cli.ts");

const ok = { code: 0, stdout: '{"changed":true,"newStatus":"Evaluated"}\n', stderr: "", spawnFailed: false, timedOut: false };

async function withRoot(fn, { tracker = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "apply-note-"));
  mkdirSync(join(root, "data"), { recursive: true });
  if (tracker) {
    writeFileSync(
      join(root, "data", "applications.md"),
      [
        "# Applications Tracker",
        "",
        "| # | Date | Company | Role | Score | Status | PDF | Report | Notes |",
        "|---|------|---------|------|-------|--------|-----|--------|-------|",
        "| 309 | 2026-07-01 | Acme | Engineer | 3.5/5 | Evaluated | ❌ | [018](../reports/018-acme-2026-07-01.md) | first look |",
        "",
      ].join("\n"),
    );
  }
  const prev = { CAREER_OPS_ROOT: process.env.CAREER_OPS_ROOT, CAREER_OPS_CODE_ROOT: process.env.CAREER_OPS_CODE_ROOT };
  process.env.CAREER_OPS_ROOT = root;
  process.env.CAREER_OPS_CODE_ROOT = CHECKOUT;
  try {
    return await fn(root);
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("trackerNoteArgs: the row's own canonical state, the literal --note= form, --source web, --json", async () => {
  await withRoot(() => {
    assert.deepEqual(trackerNoteArgs({ row: "309", status: "Evaluated", note: "override: recruiter asked (verdict Consider)" }), [
      "--row", "309", "Evaluated", "--note=override: recruiter asked (verdict Consider)", "--source", "web", "--json",
    ]);
    // An alias the CLI knows is passed as its canonical label, so the state is a no-op.
    assert.deepEqual(trackerNoteArgs({ row: "309", status: "applied", note: "cv: a.pdf sha256:abcdef123456 report:18" }).slice(0, 3), ["--row", "309", "Applied"]);
    // Report-number selector when the row is unknown.
    assert.deepEqual(trackerNoteArgs({ report: "18", status: "Evaluated", note: "x" }).slice(0, 2), ["--report", "18"]);
    // A note starting with -- stays a note, never a flag.
    assert.ok(trackerNoteArgs({ row: "309", status: "Evaluated", note: "--dry-run" }).includes("--note=--dry-run"));
  });
});

test("trackerNoteArgs refuses what it cannot write without changing the row", async () => {
  await withRoot(() => {
    assert.match(trackerNoteArgs({ row: "309", status: "Pondering", note: "x" }).error, /not a canonical state/);
    assert.match(trackerNoteArgs({ row: "309", status: "Evaluated", note: "   " }).error, /empty/);
    assert.match(trackerNoteArgs({ status: "Evaluated", note: "x" }).error, /no tracker row/);
    assert.match(trackerNoteArgs({ row: "abc", status: "Evaluated", note: "x" }).error, /no tracker row/);
  });
});

test("appendTrackerNote runs the CLI with those args and reports its outcome", async () => {
  await withRoot(async () => {
    const calls = [];
    const r = await appendTrackerNote({ row: "309", status: "Evaluated", note: "override: a | b\nc (verdict Skip)" }, async (args) => { calls.push(args); return ok; });
    assert.equal(r.ok, true);
    assert.equal(r.changed, true);
    assert.equal(r.note, "override: a / b c (verdict Skip)", "the note is sanitised once, and the caller is told the text written");
    assert.deepEqual(calls, [["--row", "309", "Evaluated", "--note=override: a / b c (verdict Skip)", "--source", "web", "--json"]]);

    const notFound = await appendTrackerNote({ row: "999", status: "Evaluated", note: "x" }, async () => ({ ...ok, code: 2, stdout: '{"error":"tracker row 999 not found","code":"not-found"}\n' }));
    assert.equal(notFound.ok, false);
    assert.equal(notFound.error, "tracker row 999 not found");

    const crashed = await appendTrackerNote({ row: "309", status: "Evaluated", note: "x" }, async () => ({ ...ok, code: -1, spawnFailed: true, stderr: "Error: at /abs/path" }));
    assert.equal(crashed.ok, false);
    assert.doesNotMatch(crashed.error, /\/abs\/path/, "child stderr never reaches the caller");

    const slow = await appendTrackerNote({ row: "309", status: "Evaluated", note: "x" }, async () => ({ ...ok, code: -1, timedOut: true }));
    assert.match(slow.error, /may or may not/);

    const bad = await appendTrackerNote({ row: "309", status: "Nope", note: "x" }, async () => { throw new Error("must not spawn"); });
    assert.equal(bad.ok, false);
  });
});

test("through the real set-status.mjs: the note lands in the Notes cell, the status does not move, and a re-run is a no-op", async (t) => {
  await withRoot(async (root) => {
    // Can this checkout run the CLI at all? Web CI installs web deps alone.
    const probe = await runSetStatus(["--row", "309", "Evaluated", "--dry-run", "--json"]);
    if (probe.spawnFailed || /ERR_MODULE_NOT_FOUND|Cannot find (package|module)/.test(probe.stderr)) {
      t.skip("set-status.mjs cannot load its dependencies in this checkout");
      return;
    }
    assert.equal(probe.code, 0, `dry run failed: ${probe.stderr}\n${probe.stdout}`);

    const note = "override: Recruiter reached out and asked for an application (verdict Consider)";
    const first = await appendTrackerNote({ row: "309", status: "Evaluated", note });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.changed, true);
    let tracker = readFileSync(join(root, "data", "applications.md"), "utf8");
    const row = tracker.split("\n").find((l) => l.startsWith("| 309 |"));
    assert.ok(row, "row 309 survived");
    assert.match(row, /\| Evaluated \|/, "status unchanged");
    assert.match(row, /first look; override: Recruiter reached out and asked for an application \(verdict Consider\)/, "note appended after the existing one");

    const again = await appendTrackerNote({ row: "309", status: "Evaluated", note });
    assert.equal(again.ok, true);
    assert.equal(again.changed, false, "idempotent re-run");
    tracker = readFileSync(join(root, "data", "applications.md"), "utf8");
    assert.equal(tracker.split("override:").length - 1, 1, "the note is in the row once");

    const cv = await appendTrackerNote({ row: "309", status: "Evaluated", note: "cv: cv-acme.pdf sha256:247c4837647a report:18" });
    assert.equal(cv.ok, true, JSON.stringify(cv));
    tracker = readFileSync(join(root, "data", "applications.md"), "utf8");
    assert.match(tracker, /override: [^|]+\(verdict Consider\); cv: cv-acme\.pdf sha256:247c4837647a report:18 \|/);
  });
});
