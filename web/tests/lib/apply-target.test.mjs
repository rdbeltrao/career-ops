// Tests for where the Apply button sends a posting: the in-app form proxy, or
// the user's own browser.
//
// A board whose Apply flow needs a signed-in member (LinkedIn, Indeed, ...)
// cannot be read by the proxy's signed-out browser: it wandered into the
// board's login page and re-rendered that. Those open in the user's browser.
// Every other host, including boards that link out to the employer without a
// login, keeps the proxy.
//
// Run:  node --test tests/lib/apply-target.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTarget, isLoginGatedBoard, loginGatedRefusal } from "../../src/lib/apply/apply-target.mjs";

test("applyTarget: no URL, or not http(s), means nothing to open", () => {
  for (const url of [undefined, null, "", "javascript:alert(1)", "mailto:jobs@acme.com"]) {
    assert.deepEqual(applyTarget(url), { kind: "none" }, String(url));
  }
});

test("applyTarget: a login-gated board opens directly, labelled with its host", () => {
  assert.deepEqual(applyTarget("https://www.linkedin.com/jobs/view/4001"), { kind: "direct", host: "linkedin.com" });
  assert.deepEqual(applyTarget("https://de.indeed.com/viewjob?jk=abc"), { kind: "direct", host: "de.indeed.com" });
});

test("applyTarget: an employer, an ATS, or a board that links out keeps the proxy", () => {
  for (const url of [
    "https://job-boards.greenhouse.io/acme/jobs/1",
    "https://jobs.lever.co/acme/1",
    "https://remoteok.com/remote-jobs/123",
    "https://himalayas.app/companies/acme/jobs/x",
    "https://builtin.com/job/x/1",
  ]) {
    assert.equal(applyTarget(url).kind, "proxy", url);
  }
});

test("isLoginGatedBoard: the boards and their subdomains, never a lookalike", () => {
  assert.equal(isLoginGatedBoard("https://www.linkedin.com/jobs/view/1"), true);
  assert.equal(isLoginGatedBoard("https://uk.indeed.com/viewjob?jk=1"), true);
  assert.equal(isLoginGatedBoard("https://www.glassdoor.de/job-listing/x"), true);
  assert.equal(isLoginGatedBoard("https://wellfound.com/jobs/1"), true);
  assert.equal(isLoginGatedBoard("https://notlinkedin.com/jobs"), false);
  assert.equal(isLoginGatedBoard("https://boards.greenhouse.io/x"), false);
  assert.equal(isLoginGatedBoard("bad url"), false);
});

test("loginGatedRefusal names the board and the way forward", () => {
  const m = loginGatedRefusal("linkedin.com");
  assert.match(m, /linkedin\.com/);
  assert.match(m, /signed-in member/);
  assert.match(m, /your browser/);
  assert.match(m, /employer/);
});
