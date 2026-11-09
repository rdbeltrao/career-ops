// The application-time gates behind /api/apply/fill (web/src/lib/apply/apply-gates.mjs):
// an Apply verdict passes, anything else needs a recorded reason, and the two
// tracker notes the fill writes have one spelling.
//
// Run (from web/):  node --test tests/lib/apply-gates.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachDecision,
  cvProvenanceNote,
  GATE_CODES,
  isApplyVerdict,
  MIN_OVERRIDE_REASON,
  normalizeDecision,
  overrideNote,
  parseGateNote,
  trackerNoteText,
  verdictGate, parseGateNotes } from "../../src/lib/apply/apply-gates.mjs";

test("isApplyVerdict: only Apply passes, whatever the case", () => {
  for (const v of ["Apply", "apply", " APPLY "]) assert.equal(isApplyVerdict(v), true, v);
  for (const v of ["Consider", "Research first", "research_first", "Skip", "", undefined, null, "apply later"]) {
    assert.equal(isApplyVerdict(v), false, String(v));
  }
});

test("normalizeDecision folds the three spellings of research first", () => {
  assert.equal(normalizeDecision("research_first"), "research first");
  assert.equal(normalizeDecision("Research  First"), "research first");
  assert.equal(normalizeDecision("RESEARCH-FIRST"), "research first");
});

test("verdictGate accepts an Apply verdict without a reason", () => {
  assert.deepEqual(verdictGate({ decision: "Apply" }), { ok: true, decision: "Apply", override: false });
  assert.deepEqual(verdictGate({ decision: "apply", overrideReason: "ignored when Apply" }), { ok: true, decision: "apply", override: false });
});

test("verdictGate refuses Consider, Research first, Skip and a missing verdict without a reason", () => {
  for (const decision of ["Consider", "Research first", "research_first", "Skip", "", undefined]) {
    const r = verdictGate({ decision });
    assert.equal(r.ok, false, String(decision));
    assert.equal(r.code, GATE_CODES.verdict);
    assert.match(r.error, new RegExp(`${MIN_OVERRIDE_REASON} characters`));
  }
  const missing = verdictGate({ decision: "" });
  assert.match(missing.error, /no readable final_decision/);
  const consider = verdictGate({ decision: "Consider" });
  assert.match(consider.error, /"Consider", not Apply/);
});

test("verdictGate refuses a reason shorter than the minimum, whitespace excluded", () => {
  const short = verdictGate({ decision: "Consider", overrideReason: "   referral   " });
  assert.equal(short.ok, false);
  const eleven = verdictGate({ decision: "Consider", overrideReason: "a".repeat(MIN_OVERRIDE_REASON - 1) });
  assert.equal(eleven.ok, false);
  const notAString = verdictGate({ decision: "Consider", overrideReason: 42 });
  assert.equal(notAString.ok, false);
});

test("verdictGate accepts a long enough reason and writes the override note with the verdict", () => {
  const r = verdictGate({ decision: "Research first", overrideReason: "Recruiter reached out and asked for the application" });
  assert.equal(r.ok, true);
  assert.equal(r.override, true);
  assert.equal(r.note, "override: Recruiter reached out and asked for the application (verdict Research first)");
  const missing = verdictGate({ decision: undefined, overrideReason: "Report predates Machine Summary blocks" });
  assert.equal(missing.ok, true);
  assert.equal(missing.note, "override: Report predates Machine Summary blocks (verdict missing)");
});

test("the override note never carries a pipe or a line break into the tracker row", () => {
  const r = verdictGate({ decision: "Skip", overrideReason: "hiring manager | wrote\nback; wants a chat" });
  assert.equal(r.ok, true);
  assert.equal(r.note, "override: hiring manager / wrote back; wants a chat (verdict Skip)");
  assert.doesNotMatch(r.note, /[|\r\n]/);
});

test("trackerNoteText bounds the note and marks the cut", () => {
  const long = trackerNoteText("x".repeat(500));
  assert.equal(long.length, 240);
  assert.ok(long.endsWith("…"));
  assert.equal(trackerNoteText("  a   b  "), "a b");
});

test("cvProvenanceNote records basename, 12 hex of the hash and the report number", () => {
  const note = cvProvenanceNote({
    file: "/home/me/job-hunt/output/cv-candidate-123-sap-2026-10-24.pdf",
    sha256: "247C4837647AA54DF93C3AC8D9E5782BBC40A8D2D09F96A172778C9D1338848D",
    report: "386",
  });
  assert.equal(note, "cv: cv-candidate-123-sap-2026-10-24.pdf sha256:247c4837647a report:386");
  assert.equal(cvProvenanceNote({ file: "cv.pdf", sha256: "abcdef123456789", report: null }), "cv: cv.pdf sha256:abcdef123456 report:unknown");
});

test("parseGateNote reads back both notes, and nothing else", () => {
  assert.deepEqual(parseGateNote(overrideNote("Recruiter asked", "Consider")), { kind: "override", reason: "Recruiter asked", decision: "Consider", permit: false });
  assert.deepEqual(parseGateNote(overrideNote("Recruiter confirmed the permit", "Apply", "Spain")), { kind: "override", reason: "Recruiter confirmed the permit", decision: "Apply", permit: true });
  assert.deepEqual(parseGateNote("cv: cv-acme.pdf sha256:247c4837647a report:386"), { kind: "cv", file: "cv-acme.pdf", sha256: "247c4837647a", report: "386" });
  assert.deepEqual(parseGateNote("cv: cv-acme.pdf sha256:247c4837647a report:unknown"), { kind: "cv", file: "cv-acme.pdf", sha256: "247c4837647a", report: null });
  assert.equal(parseGateNote("sent CV"), null);
});

test("attachDecision attaches only a ready CV", () => {
  assert.deepEqual(attachDecision({ status: "ready", path: "/out/cv.pdf", report: "12" }), { attach: true, path: "/out/cv.pdf", report: "12" });
  assert.deepEqual(attachDecision({ status: "none" }), { attach: false, code: null, error: null });
  assert.deepEqual(attachDecision(null), { attach: false, code: null, error: null });
});

test("attachDecision refuses a stale CV and tells the user to regenerate it", () => {
  const r = attachDecision({ status: "stale", path: "/out/cv.pdf", report: "12", reason: "career evidence changed" });
  assert.equal(r.attach, false);
  assert.equal(r.code, GATE_CODES.stale);
  assert.match(r.error, /stale \(career evidence changed\)/);
  assert.match(r.error, /Regenerate it/);
});

test("attachDecision refuses an unverified-role CV until a report number is confirmed", () => {
  const r = attachDecision({ status: "unverified-role", path: "/out/cv-acme.pdf", unverifiedRole: true });
  assert.equal(r.attach, false);
  assert.equal(r.code, GATE_CODES.unverifiedRole);
  assert.match(r.error, /Confirm the report number/);
  // A confirmed number that resolved to no CV refuses with its own code: the user asked for that CV.
  const confirmed = attachDecision({ status: "none", reason: "not-found" }, { confirmReport: "77" });
  assert.equal(confirmed.attach, false);
  assert.equal(confirmed.code, GATE_CODES.noCv);
  assert.match(confirmed.error, /Report 77 has no indexed tailored CV \(not-found\)/);
  assert.match(confirmed.error, /Fill without attaching a CV/);
});

test("parseGateNotes reads every gate note out of a real Notes cell, which set-status joins with '; '", () => {
  const cell = "job id 123; Re-eval 2026-10-24 (3.7→3.4); cv: cv-acme.pdf sha256:247c4837647a report:386; override: Recruiter asked (verdict Consider)";
  assert.deepEqual(parseGateNotes(cell), [
    { kind: "cv", file: "cv-acme.pdf", sha256: "247c4837647a", report: "386" },
    { kind: "override", reason: "Recruiter asked", decision: "Consider", permit: false },
  ]);
  assert.deepEqual(parseGateNotes("sent CV; thanks"), []);
  assert.deepEqual(parseGateNotes(""), []);
});

test("verdictGate: an Apply verdict with an open permit question needs a recorded reason, and the note says so", () => {
  const refused = verdictGate({ decision: "Apply", permit: "the posting location \"Madrid, Spain\" is outside Germany" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, GATE_CODES.verdict);
  assert.match(refused.error, /work-permit question is open/);
  const allowed = verdictGate({ decision: "Apply", permit: "Madrid", overrideReason: "Recruiter confirmed a Spanish permit is arranged" });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.override, true);
  assert.match(allowed.note, /\(verdict Apply; permit question open\)$/);
  assert.equal(verdictGate({ decision: "Apply", permit: null }).override, false);
  assert.equal(verdictGate({ decision: "Apply", permit: "" }).override, false);
});
