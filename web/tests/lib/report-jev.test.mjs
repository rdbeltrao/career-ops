import test from "node:test";
import assert from "node:assert/strict";
import { attachJev, parseJevField, readJevHead } from "../../src/lib/report-jev.mjs";

test("parseJevField reads the header the evaluation writes", () => {
  assert.deepEqual(parseJevField("3.7/5 (fit 68, maybe)"), { fit: 68, score: 3.7, verdict: "maybe" });
  assert.deepEqual(parseJevField("2.7/5 (fit 42, maybe)"), { fit: 42, score: 2.7, verdict: "maybe" });
  assert.deepEqual(parseJevField("fit 81, apply"), { fit: 81, score: null, verdict: "apply" });
  assert.deepEqual(parseJevField("skip (fit 12)"), { fit: 12, score: null, verdict: "skip" });
});

test("parseJevField returns null when nothing is readable and never invents a fit", () => {
  assert.equal(parseJevField(""), null);
  assert.equal(parseJevField("not run"), null);
  assert.deepEqual(parseJevField("fit 140, apply"), { fit: null, score: null, verdict: "apply" });
});

test("readJevHead takes the URL and Jev from the report's leading lines", () => {
  const head = ["# Evaluation: Acme — EM", "", "**Date:** 2026-10-24", "**URL:** https://jobs.example.com/1", "**Score:** 4.2/5", "**Jev:** 2.7/5 (fit 42, maybe)"].join("\n");
  assert.deepEqual(readJevHead(head), { url: "https://jobs.example.com/1", jev: { fit: 42, score: 2.7, verdict: "maybe" } });
  assert.deepEqual(readJevHead("**URL:** (pasted)\n**Score:** 3/5"), { url: null, jev: null });
});

test("attachJev joins the report header with the pipeline row's reasons", () => {
  const heads = {
    "r1.md": "**URL:** https://jobs.example.com/1\n**Jev:** 3.7/5 (fit 68, maybe)",
    "r2.md": "**URL:** https://jobs.example.com/2\n**Score:** 3/5",
  };
  const inbox = [
    { url: "https://jobs.example.com/1/", jev: { fit: 68, verdict: "maybe", reasons: "seniority match, location yes" } },
    { url: "https://jobs.example.com/2", jev: { fit: 80, verdict: "apply", reasons: "stack match" } },
  ];
  const key = (u) => u.replace(/\/$/, "");
  const rows = attachJev(
    [
      { n: "1", report: "r1.md", url: "" },
      { n: "2", report: "r2.md", url: "" },
      { n: "3", report: "-", url: "" },
      { n: "4", report: "missing.md", url: "[ad](https://jobs.example.com/2)" },
    ],
    inbox,
    (row) => heads[row.report] ?? null,
    key,
  );
  assert.deepEqual(rows[0].jev, { fit: 68, score: 3.7, verdict: "maybe", reasons: "seniority match, location yes" });
  // No header line: the pipeline row supplies fit and verdict, score stays unknown.
  assert.deepEqual(rows[1].jev, { fit: 80, score: null, verdict: "apply", reasons: "stack match" });
  assert.equal(rows[2].jev, null);
  // No report to read: the tracker's URL cell still finds the pipeline row.
  assert.deepEqual(rows[3].jev, { fit: 80, score: null, verdict: "apply", reasons: "stack match" });
});
