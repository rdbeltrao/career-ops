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
import { applyTarget, isLoginGatedBoard, linkedInPostingId, loginGatedRefusal } from "../../src/lib/apply/apply-target.mjs";

test("applyTarget: no URL, or not http(s), means nothing to open", () => {
  for (const url of [undefined, null, "", "javascript:alert(1)", "mailto:jobs@acme.com"]) {
    assert.deepEqual(applyTarget(url), { kind: "none" }, String(url));
  }
});

test("applyTarget: a login-gated board opens directly, labelled with its host; a LinkedIn posting offers the employer-form lookup", () => {
  assert.deepEqual(applyTarget("https://de.indeed.com/viewjob?jk=abc"), { kind: "direct", host: "de.indeed.com" });
  assert.deepEqual(applyTarget("https://www.linkedin.com/jobs/view/4001"), { kind: "resolve", host: "linkedin.com" });
  assert.deepEqual(applyTarget("https://www.linkedin.com/company/acme/jobs/"), { kind: "direct", host: "linkedin.com" }, "a LinkedIn page that is not one posting");
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

// ── LinkedIn postings with a known employer form (data/linkedin-apply.json) ──

const LI = "https://www.linkedin.com/jobs/view/4480683016/";
const ASHBY = "https://jobs.ashbyhq.com/secfix/2b0656e4/application?utm_source=linkedinpaid";

test("applyTarget: a LinkedIn posting whose employer form the crawl found goes to the proxy on that form", () => {
  const t = applyTarget(LI, { applyUrl: ASHBY, kind: "offsite" });
  assert.deepEqual(t, { kind: "proxy", host: "jobs.ashbyhq.com", url: ASHBY, boardUrl: LI, boardHost: "linkedin.com" });
});

test("applyTarget: Easy Apply stays on LinkedIn, and says so", () => {
  assert.deepEqual(applyTarget(LI, { applyUrl: "", kind: "easy-apply" }), { kind: "direct", host: "linkedin.com", easyApply: true });
});

test("applyTarget: a LinkedIn posting nobody looked up yet offers the lookup", () => {
  assert.deepEqual(applyTarget(LI, null), { kind: "resolve", host: "linkedin.com" });
  assert.deepEqual(applyTarget(LI, { applyUrl: "", kind: "offsite" }), { kind: "resolve", host: "linkedin.com" }, "offsite but unread: look again");
});

test("applyTarget: an employer URL that is itself a login-gated board or not http(s) is not used", () => {
  assert.equal(applyTarget(LI, { applyUrl: "https://de.indeed.com/viewjob?jk=1", kind: "offsite" }).kind, "resolve");
  assert.equal(applyTarget(LI, { applyUrl: "javascript:alert(1)", kind: "offsite" }).kind, "resolve");
});

test("applyTarget: other login-gated boards still open directly; a non-board URL ignores any stored entry", () => {
  assert.deepEqual(applyTarget("https://de.indeed.com/viewjob?jk=abc", null), { kind: "direct", host: "de.indeed.com" });
  assert.deepEqual(applyTarget("https://jobs.lever.co/acme/1", { applyUrl: ASHBY, kind: "offsite" }), { kind: "proxy", host: "jobs.lever.co" });
});

test("linkedInPostingId: digits only, LinkedIn hosts only", () => {
  assert.equal(linkedInPostingId(LI), "4480683016");
  assert.equal(linkedInPostingId("https://de.linkedin.com/jobs/view/senior-em-at-secfix-4480683016"), "4480683016");
  assert.equal(linkedInPostingId("https://www.linkedin.com/jobs/search/?currentJobId=42"), "42");
  assert.equal(linkedInPostingId("https://linkedin.com.evil.example/jobs/view/1"), null);
  assert.equal(linkedInPostingId("https://www.linkedin.com/feed/"), null);
  assert.equal(linkedInPostingId("nope"), null);
});

test("session route: a stored employer URL still goes through the URL guard after the LinkedIn mapping", async () => {
  // A stored URL comes from LinkedIn's page, which is untrusted content: a
  // private host there must be refused exactly like a pasted one.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(fileURLToPath(new URL("../../src/app/api/apply/session/route.ts", import.meta.url)), "utf8");
  const mapped = src.indexOf("applyTarget(pasted");
  const guarded = src.indexOf("blockedApplyUrlResponse(url)");
  assert.ok(mapped > 0 && guarded > mapped, "the guard must run on the mapped URL, after applyTarget");
  assert.match(src, /const url = target\.kind === "proxy" && target\.url \? target\.url : pasted;/);
});
