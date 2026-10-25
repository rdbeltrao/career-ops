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
