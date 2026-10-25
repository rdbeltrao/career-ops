// Tests for the request contract of /api/apply/answers, the route that saves the
// answers reviewed on the Apply page into the report and the answer bank.
//
// The route writes into a report file and the user's data root, so everything it
// takes from the request is checked before it reaches a writer: the state is one
// of two words, the application number is digits, and fields/answers have the
// shapes the snapshot builder expects. Anything else is a 400, not a guess.
//
// Run:  node --test tests/lib/apply-answers-save.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSaveBody, MAX_FIELDS } from "../../src/lib/apply/answers-save.mjs";

const fields = [{ id: "co0", type: "text", label: "First name", required: true }];

test("parseSaveBody: a well-formed body passes, trimmed", () => {
  const r = parseSaveBody({ state: "filled", application: " 067 ", company: " Acme ", title: "EM", url: "https://jobs.lever.co/acme/1", sessionId: "apply-1", fields, answers: { co0: "Renata" } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { state: "filled", application: "067", company: "Acme", title: "EM", url: "https://jobs.lever.co/acme/1", sessionId: "apply-1", fields, answers: { co0: "Renata" } });
});

test("parseSaveBody: optional identity fields default to empty", () => {
  const r = parseSaveBody({ state: "submitted", fields, answers: {} });
  assert.equal(r.ok, true);
  assert.equal(r.value.application, "");
  assert.equal(r.value.company, "");
  assert.equal(r.value.url, "");
});

test("parseSaveBody: refuses what a writer should never see", () => {
  const bad = [
    [null, /json/],
    [{ state: "sent", fields, answers: {} }, /state/],
    [{ state: "filled", application: "../x", fields, answers: {} }, /application/],
    [{ state: "filled", application: 7, fields, answers: {} }, /application/],
    [{ state: "filled", company: {}, fields, answers: {} }, /company/],
    [{ state: "filled", url: "javascript:alert(1)", fields, answers: {} }, /url/],
    [{ state: "filled", fields: "x", answers: {} }, /fields/],
    [{ state: "filled", fields: [{ id: 1, label: "x", type: "text" }], answers: {} }, /fields/],
    [{ state: "filled", fields, answers: [] }, /answers/],
    [{ state: "filled", fields, answers: { co0: 5 } }, /answers/],
    [{ state: "filled", fields: Array.from({ length: MAX_FIELDS + 1 }, (_, i) => ({ id: `c${i}`, type: "text", label: "x" })), answers: {} }, /fields/],
  ];
  for (const [body, msg] of bad) {
    const r = parseSaveBody(body);
    assert.equal(r.ok, false, JSON.stringify(body)?.slice(0, 80));
    assert.match(r.error, msg);
  }
});
