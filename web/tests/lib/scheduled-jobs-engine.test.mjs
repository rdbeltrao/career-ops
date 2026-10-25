// The schedule validator accepts the LinkedIn-only engine and still refuses an
// unknown one. Without this the "LinkedIn searches only" choice in the schedule
// form would be rejected by the API it posts to.
//
// Run:  node --test tests/lib/scheduled-jobs-engine.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import "../helpers/web-ts-alias-loader.mjs";

const { parseScheduledJobInput, ScheduledJobValidationError } = await import("../../src/lib/scheduled-jobs.ts");

test("parseScheduledJobInput accepts every engine the form offers", () => {
  for (const engine of ["full", "portals", "linkedin"]) {
    assert.equal(parseScheduledJobInput({ name: "x", engine, every: 1, unit: "days" }).engine, engine);
  }
});

test("parseScheduledJobInput refuses an engine the runner does not know", () => {
  assert.throws(() => parseScheduledJobInput({ name: "x", engine: "linkedin-everything", every: 1, unit: "days" }), ScheduledJobValidationError);
});

test("a LinkedIn schedule stores its chosen searches and window, trimmed and deduplicated", () => {
  const f = parseScheduledJobInput({ name: "x", engine: "linkedin", every: 1, unit: "days", linkedin: { searches: [" LinkedIn em-de ", "LinkedIn em-de", "LinkedIn em-es"], useSearchWindow: false } });
  assert.deepEqual(f.linkedin, { searches: ["LinkedIn em-de", "LinkedIn em-es"], useSearchWindow: false });
});

test("a LinkedIn schedule with no choice runs every search that is on, in each search's own window", () => {
  assert.deepEqual(parseScheduledJobInput({ name: "x", engine: "linkedin", every: 1, unit: "days" }).linkedin, { searches: [], useSearchWindow: true });
});

test("an edit that leaves linkedin out keeps the stored choice; other engines carry none", () => {
  const base = parseScheduledJobInput({ name: "x", engine: "linkedin", every: 1, unit: "days", linkedin: { searches: ["A"], useSearchWindow: false } });
  assert.deepEqual(parseScheduledJobInput({ name: "renamed" }, { ...base, id: "1", status: "active", createdAt: "", updatedAt: "" }).linkedin, { searches: ["A"], useSearchWindow: false });
  assert.equal(parseScheduledJobInput({ name: "x", engine: "portals", every: 1, unit: "days", linkedin: { searches: ["A"] } }).linkedin, undefined);
});

test("bad LinkedIn options are refused", () => {
  for (const linkedin of [{ searches: "A" }, { searches: [1] }, { searches: ["x".repeat(81)] }, { useSearchWindow: "yes" }, { searches: Array.from({ length: 51 }, (_, i) => `s${i}`) }]) {
    assert.throws(() => parseScheduledJobInput({ name: "x", engine: "linkedin", every: 1, unit: "days", linkedin }), ScheduledJobValidationError, JSON.stringify(linkedin).slice(0, 60));
  }
});
