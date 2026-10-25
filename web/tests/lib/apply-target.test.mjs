// Tests for where the Apply button sends a posting: the in-app form proxy, or
// the user's own browser.
//
// Job boards (LinkedIn, Indeed, Glassdoor, ...) never show the employer's form to
// a signed-out browser. Sending one through the proxy opened a fresh Chrome on
// the board, wandered into its login page and re-rendered that. A board URL
// opens in the user's browser, where they are already signed in.
//
// The aggregator predicate is injected: in the app it is the core's
// isAggregatorUrl (url-key.mjs), and suites under web/tests run on web/ alone.
//
// Run:  node --test tests/lib/apply-target.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTarget, fallbackIsJobBoard, aggregatorRefusal } from "../../src/lib/apply/apply-target.mjs";

const boards = new Set(["linkedin.com", "indeed.com"]);
const isAgg = (u) => {
  const h = new URL(u).hostname.replace(/^www\./, "");
  return [...boards].some((d) => h === d || h.endsWith(`.${d}`));
};

test("applyTarget: no URL, or not http(s), means nothing to open", () => {
  assert.deepEqual(applyTarget(undefined, isAgg), { kind: "none" });
  assert.deepEqual(applyTarget("", isAgg), { kind: "none" });
  assert.deepEqual(applyTarget("javascript:alert(1)", isAgg), { kind: "none" });
  assert.deepEqual(applyTarget("mailto:jobs@acme.com", isAgg), { kind: "none" });
});

test("applyTarget: a job-board URL opens directly, labelled with its host", () => {
  assert.deepEqual(applyTarget("https://www.linkedin.com/jobs/view/4001", isAgg), { kind: "direct", host: "linkedin.com" });
  assert.deepEqual(applyTarget("https://de.indeed.com/viewjob?jk=abc", isAgg), { kind: "direct", host: "de.indeed.com" });
});

test("applyTarget: an employer or ATS URL goes through the proxy", () => {
  assert.deepEqual(applyTarget("https://job-boards.greenhouse.io/acme/jobs/1", isAgg), { kind: "proxy", host: "job-boards.greenhouse.io" });
});

test("applyTarget: a throwing predicate falls back to the built-in board list", () => {
  const boom = () => {
    throw new Error("core missing");
  };
  assert.equal(applyTarget("https://www.linkedin.com/jobs/view/1", boom).kind, "direct");
  assert.equal(applyTarget("https://jobs.lever.co/acme/1", boom).kind, "proxy");
});

test("fallbackIsJobBoard: the big boards and their subdomains, never a lookalike", () => {
  assert.equal(fallbackIsJobBoard("https://www.linkedin.com/jobs/view/1"), true);
  assert.equal(fallbackIsJobBoard("https://uk.indeed.com/viewjob?jk=1"), true);
  assert.equal(fallbackIsJobBoard("https://www.glassdoor.de/job-listing/x"), true);
  assert.equal(fallbackIsJobBoard("https://wellfound.com/jobs/1"), true);
  assert.equal(fallbackIsJobBoard("https://notlinkedin.com/jobs"), false);
  assert.equal(fallbackIsJobBoard("https://boards.greenhouse.io/x"), false);
  assert.equal(fallbackIsJobBoard("bad url"), false);
});

test("aggregatorRefusal names the board and the way forward", () => {
  const m = aggregatorRefusal("linkedin.com");
  assert.match(m, /linkedin\.com/);
  assert.match(m, /your browser/);
  assert.match(m, /employer/);
});
