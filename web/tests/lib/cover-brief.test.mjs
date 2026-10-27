// Run: node --test tests/lib/cover-brief.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseCoverRequest } from "../../src/lib/cover-brief.mjs";

const ROOT = path.join(path.sep, "tmp", "career-ops");
const REPORT = path.join(ROOT, "reports", "041-acme-2026-10-01.md");
const findReportFile = (n) => (Number(n) === 41 ? REPORT : null);
const request = (brief, input = "041") => parseCoverRequest({ input, brief, root: ROOT, findReportFile });
const accepted = (instructions = "") => ({ ok: true, reportFile: "reports/041-acme-2026-10-01.md", brief: { instructions } });

test("parseCoverRequest: optional instructions are trimmed without losing line breaks", () => {
  assert.deepEqual(request({ instructions: "  Focus on platform leadership.\nKeep the tone direct.  " }), accepted("Focus on platform leadership.\nKeep the tone direct."));
});

test("parseCoverRequest: absent, null, empty and whitespace-only direction can draft", () => {
  for (const brief of [undefined, null, {}, { instructions: undefined }, { instructions: "" }, { instructions: " \n\t " }]) {
    assert.deepEqual(request(brief), accepted());
  }
});

test("parseCoverRequest: malformed briefs are rejected before report lookup", () => {
  for (const brief of ["extra direction", 1, false, [], ["text"]]) {
    let lookedUp = false;
    const result = parseCoverRequest({ input: "041", brief, root: ROOT, findReportFile: () => { lookedUp = true; return REPORT; } });
    assert.deepEqual(result, { ok: false, error: "Invalid cover letter brief: expected an object." });
    assert.equal(lookedUp, false);
  }
});

test("parseCoverRequest: instructions must be text, never coerced", () => {
  for (const instructions of [null, 12, true, {}, [], { toString: null }]) {
    assert.deepEqual(request({ instructions }), { ok: false, error: "Additional instructions must be text." });
  }
});

test("parseCoverRequest: accepts the 3000-character limit and refuses excess without truncating", () => {
  assert.deepEqual(request({ instructions: "x".repeat(3000) }), accepted("x".repeat(3000)));
  assert.deepEqual(request({ instructions: "x".repeat(3001) }), { ok: false, error: "Keep additional instructions to 3000 characters or fewer." });
});

test("parseCoverRequest: a row with no report asks for an evaluation first even without direction", () => {
  assert.deepEqual(request(undefined, "7"), { ok: false, error: "No report #7 found. Evaluate this posting first." });
});

test("parseCoverRequest: a selector that is not a bare number never reaches the report lookup", () => {
  const seen = [];
  const result = parseCoverRequest({ input: "41/../../etc/passwd", root: ROOT, findReportFile: n => (seen.push(n), REPORT) });
  assert.deepEqual(result, { ok: false, error: 'Invalid report selector: "41/../../etc/passwd"' });
  assert.deepEqual(seen, []);
});

test("parseCoverRequest: a non-string input is refused before the selector regex runs", () => {
  const result = request(undefined, { toString: null });
  assert.deepEqual(result, { ok: false, error: "Invalid report selector: expected a report number string." });
});
