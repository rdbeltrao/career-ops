// Tests for how the web reads linkedin-apply.mjs's result (exit code, stdout,
// stderr) when Apply looks up the employer form behind a LinkedIn posting.
//
// Each exit code means something the user can act on, so each gets its own
// status and message rather than whatever the last stderr line happened to be.
//
// Run:  node --test tests/lib/linkedin-resolve-result.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretResolve } from "../../src/lib/apply/linkedin-resolve-result.mjs";

const base = { code: 0, stdout: "", stderr: "", timedOut: false, spawnFailed: false };
const entry = { id: "4480683016", linkedinUrl: "https://www.linkedin.com/jobs/view/4480683016/", applyUrl: "https://jobs.ashbyhq.com/x/application", kind: "offsite", checkedAt: "2026-10-25", found: true };

test("exit 0: the last stdout line is the entry", () => {
  const r = interpretResolve({ ...base, stdout: `noise\n${JSON.stringify(entry)}\n` });
  assert.equal(r.ok, true);
  assert.equal(r.entry.applyUrl, entry.applyUrl);
  const easy = interpretResolve({ ...base, stdout: JSON.stringify({ ...entry, applyUrl: "", kind: "easy-apply" }) });
  assert.equal(easy.ok, true);
  assert.equal(easy.entry.kind, "easy-apply");
});

test("exit 3: LinkedIn wants a login, and the user is told how to fix it", () => {
  const r = interpretResolve({ ...base, code: 3, stdout: JSON.stringify({ id: "1", found: false, error: "login-required" }), stderr: "linkedin-browser: LinkedIn asked for a login..." });
  assert.deepEqual([r.ok, r.status, r.loginRequired], [false, 409, true]);
  assert.match(r.error, /node linkedin-login\.mjs/);
});

test("exit 2: a URL the core does not recognise is a 400 with a plain message, not the usage text", () => {
  const r = interpretResolve({ ...base, code: 2, stderr: "Not a LinkedIn posting: x\n\nUsage:\n  node linkedin-apply.mjs --resolve <url>\n\nExit codes: 0 read" });
  assert.deepEqual([r.ok, r.status], [false, 400]);
  assert.doesNotMatch(r.error, /Exit codes|Usage/);
});

test("a core without linkedin-apply.mjs is a 501, not a stack trace", () => {
  const stack = "node:internal/modules/cjs/loader:1228\n  throw err;\nError: Cannot find module '/x/linkedin-apply.mjs'\n    at Module._resolveFilename\nNode.js v22.21.1";
  for (const r of [interpretResolve({ ...base, code: 1, stderr: stack }), interpretResolve({ ...base, code: -1, spawnFailed: true })]) {
    assert.deepEqual([r.ok, r.status], [false, 501]);
    assert.doesNotMatch(r.error, /Node\.js v|at Module/);
  }
});

test("timeout is a 504; nothing found is a 404 carrying the core's own reason", () => {
  assert.equal(interpretResolve({ ...base, code: -1, timedOut: true }).status, 504);
  const none = interpretResolve({ ...base, code: 1, stdout: JSON.stringify({ id: "1", applyUrl: null, kind: "", found: false }), stderr: "linkedin-apply: no apply method found on posting 1 (closed, or the layout changed)." });
  assert.deepEqual([none.ok, none.status], [false, 404]);
  assert.match(none.error, /no apply method found/);
});
