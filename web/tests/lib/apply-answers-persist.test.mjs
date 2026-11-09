/**
 * apply-answers-persist.test.mjs: persistFormAnswers (web/src/lib/apply/
 * answers-persist.ts), the one writer behind POST /api/apply/answers and the
 * save /api/apply/fill performs right after a fill.
 *
 * Every filled field with a non-empty, non-password value reaches
 * data/application-answers.jsonl with the company, the report number, the
 * question and the answer; the report's `## Application Answers` section is
 * written when the session belongs to a tracker row. The core writers
 * (answer-bank.mjs, application-answers.mjs) are the real ones from this
 * checkout; they import nothing outside Node.
 *
 * Run (from web/):  node --test tests/lib/apply-answers-persist.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "../helpers/web-ts-alias-loader.mjs";

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { persistFormAnswers } = await import("../../src/lib/apply/answers-persist.ts");

const FIELDS = [
  { id: "f1", type: "text", label: "Full name *", required: true },
  { id: "f2", type: "email", label: "Email", required: true },
  { id: "f3", type: "textarea", label: "Why this role?", required: false },
  { id: "f4", type: "select", label: "Work authorisation", required: true, options: ["Yes", "No"] },
  { id: "f5", type: "text", label: "Password", required: true, password: true },
  { id: "f6", type: "text", label: "LinkedIn", required: false },
  { id: "f7", type: "file", label: "Resume / CV", required: true },
  { id: "f8", type: "file", label: "Cover letter", required: false },
];
const ANSWERS = { f1: "Jane Doe", f2: "jane@example.test", f3: "Because the team ships.", f4: "Yes", f5: "hunter2", f6: "" };

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "answers-persist-"));
  for (const d of ["data", "reports", "output"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "reports", "012-acme-2026-07-01.md"), "# Evaluation: Acme — Staff Engineer\n\n**URL:** https://jobs.acme.test/12\n\n## Verdict\n\nApply.\n");
  writeFileSync(
    join(root, "data", "applications.md"),
    [
      "| # | Date | Company | Role | Score | Status | PDF | Report | Notes |",
      "|---|---|---|---|---|---|---|---|---|",
      "| 7 | 2026-07-01 | Acme | Staff Engineer | 4.5/5 | Evaluated | ✅ | [012](../reports/012-acme-2026-07-01.md) | |",
    ].join("\n"),
  );
  writeFileSync(join(root, "output", "cv-jane-acme-2026-07-02.pdf"), "pdf");
  const prev = { CAREER_OPS_ROOT: process.env.CAREER_OPS_ROOT, CAREER_OPS_CODE_ROOT: process.env.CAREER_OPS_CODE_ROOT };
  process.env.CAREER_OPS_ROOT = root;
  process.env.CAREER_OPS_CODE_ROOT = CHECKOUT;
  try {
    return await fn(root);
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function bankRecords(root) {
  const file = join(root, "data", "application-answers.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
}

test("every filled, non-password answer is banked with company, report, question and answer", async () => {
  await withRoot(async (root) => {
    const r = await persistFormAnswers({
      state: "filled",
      application: "7",
      company: "Acme (display label)",
      title: "Staff Engineer @ Acme",
      url: "https://jobs.acme.test/apply/12",
      fields: FIELDS,
      answers: ANSWERS,
      cvPath: join(root, "output", "cv-jane-acme-2026-07-02.pdf"),
    });
    assert.equal(r.saved, true);
    assert.equal(r.banked, true);
    assert.equal(r.report, "012-acme-2026-07-01.md");
    assert.equal(r.reportSkipped, null);

    const [record, ...rest] = bankRecords(root);
    assert.equal(rest.length, 0, "one record per save");
    assert.equal(record.state, "filled");
    assert.equal(record.company, "Acme", "the tracker row's company, not the page's display label");
    assert.equal(record.role, "Staff Engineer");
    assert.equal(record.report, "012");
    assert.equal(record.url, "https://jobs.acme.test/apply/12");
    const byQ = Object.fromEntries(record.answers.map((a) => [a.q, a]));
    assert.deepEqual(byQ["Full name"], { q: "Full name", a: "Jane Doe", kind: "field" });
    assert.deepEqual(byQ["Email"], { q: "Email", a: "jane@example.test", kind: "field" });
    assert.deepEqual(byQ["Why this role?"], { q: "Why this role?", a: "Because the team ships.", kind: "free" });
    assert.deepEqual(byQ["Work authorisation"], { q: "Work authorisation", a: "Yes", kind: "select" });
    assert.equal(byQ["Password"], undefined, "a password is never stored");
    assert.equal(byQ["LinkedIn"], undefined, "an empty answer is not an answer");
    assert.equal(byQ["Resume / CV"].a, "output/cv-jane-acme-2026-07-02.pdf", "the attached CV is recorded root-relative");
    assert.equal(byQ["Cover letter"], undefined, "a file field that took nothing is not recorded");
    assert.equal(r.count, record.answers.length);

    const report = readFileSync(join(root, "reports", "012-acme-2026-07-01.md"), "utf8");
    assert.match(report, /## Application Answers/);
    assert.match(report, /Because the team ships\./);
    assert.doesNotMatch(report, /hunter2/);
  });
});

test("a session with no tracker row still reaches the answer bank, with the page's company", async () => {
  await withRoot(async (root) => {
    const r = await persistFormAnswers({ state: "filled", application: "", company: "Globex", title: "Engineer @ Globex", url: "https://jobs.globex.test/1", fields: FIELDS, answers: ANSWERS, cvPath: null });
    assert.equal(r.saved, true);
    assert.equal(r.report, null);
    const [record] = bankRecords(root);
    assert.equal(record.company, "Globex");
    assert.equal(record.report, null);
    assert.equal(record.role, "Engineer @ Globex");
    assert.ok(record.answers.length >= 4);
  });
});

test("nothing is written when no answer is worth saving", async () => {
  await withRoot(async (root) => {
    const r = await persistFormAnswers({ state: "filled", application: "7", company: "Acme", title: "t", url: "", fields: FIELDS, answers: { f5: "hunter2", f6: "   " }, cvPath: null });
    assert.deepEqual(r, { saved: false, report: null, banked: false, reportSkipped: null, count: 0 });
    assert.equal(bankRecords(root).length, 0);
    assert.doesNotMatch(readFileSync(join(root, "reports", "012-acme-2026-07-01.md"), "utf8"), /Application Answers/);
  });
});
