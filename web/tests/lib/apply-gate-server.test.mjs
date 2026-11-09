/**
 * apply-gate-server.test.mjs: the server half of the application-time gates
 * (web/src/lib/apply/gate.ts, cv.ts, cv-review.ts and the "stale" status of
 * pdfPathStatusForReport in career-ops.ts), against a throwaway data root.
 *
 *   - the verdict is read from the linked report's Machine Summary, and only
 *     `final_decision: Apply` needs no override;
 *   - an indexed CV is "ready" only while its final-review receipt is current:
 *     a missing receipt or one the core's check rejects reads "stale", and the
 *     strict pdfPathForReport/pdfReadyForReport answer null/false for it;
 *   - a CV found by company name alone is "unverified-role", never ready, and
 *     a confirmed report number resolves through the index instead.
 *
 * The core's assertCurrentCvReview is loaded from the code checkout at runtime
 * (lib/cv-publication.mjs), so the fixture supplies a stub there, the way
 * apply-cv-resolver.test.mjs stubs tracker-utils.mjs: web CI installs web
 * dependencies alone, and the real module pulls the whole core in.
 *
 * Run (from web/):  node --test tests/lib/apply-gate-server.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "../helpers/web-ts-alias-loader.mjs";

const { applyGateStatus, identityForApplication, identityForReport, identityForUrl, publicCv, reportVerdict } = await import("../../src/lib/apply/gate.ts");
const { resolveTailoredCv, resolveSessionCv, resolveConfirmedCv } = await import("../../src/lib/apply/cv.ts");
const { pdfPathStatusForReport, pdfPathForReport, pdfReadyForReport } = await import("../../src/lib/career-ops.ts");
const { cvReviewStatus } = await import("../../src/lib/cv-review.ts");

const MANIFEST_HEADER = "# report\tpdf\thtml\tformat\tdate\tkind - written by generate-pdf.mjs, do not edit\n";

function machineSummary(decision) {
  return decision === null
    ? ""
    : `\n## Machine Summary\n\n\`\`\`yaml\ncompany: Acme\nrole: Engineer\nscore: 4.2\nfinal_decision: ${decision}\n\`\`\`\n`;
}

/**
 * A data root with three tracker rows and their reports, and a code root with
 * the two stubs the web loads from the checkout at runtime.
 *   row 309 -> report 018 (Apply)        CV indexed, receipt current
 *   row 310 -> report 019 (Consider)     CV indexed, receipt marked stale
 *   row 311 -> report 020 (no summary)   CV indexed, no receipt
 *   row 312 -> report 021 (Research first) no CV indexed
 */
async function withFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "apply-gate-"));
  const codeRoot = mkdtempSync(join(tmpdir(), "apply-gate-code-"));
  for (const d of ["data", "reports", "output"]) mkdirSync(join(root, d), { recursive: true });
  mkdirSync(join(codeRoot, "lib"), { recursive: true });

  const reports = [
    ["018", "Apply"],
    ["019", "Consider"],
    ["020", null],
    ["021", "Research first"],
  ];
  for (const [n, decision] of reports) {
    writeFileSync(join(root, "reports", `${n}-acme-2026-07-01.md`), `# Evaluation: Acme — Engineer ${n}\n\n**URL:** https://jobs.acme.test/${n}\n${machineSummary(decision)}`);
  }
  // Two Apply verdicts with a permit question: 022 marked by the evaluator, 023
  // only visible through its posting location (the 2026-11-09 diagnostic shape).
  writeFileSync(join(root, "reports", "022-acme-2026-07-01.md"), "# Evaluation: Acme — Engineer 022\n\n## Machine Summary\n\n```yaml\nfinal_decision: Apply\nwork_auth: permit_question\nposting_location: \"Madrid, Spain\"\n```\n");
  writeFileSync(join(root, "reports", "023-acme-2026-07-01.md"), "# Evaluation: Acme — Engineer 023\n\n## Machine Summary\n\n```yaml\nfinal_decision: Apply\nwork_auth: not_needed\nposting_location: \"Barcelona, Spain\"\n```\n");
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "profile.yml"), "location:\n  authorized_in: [Germany]\n  needs_sponsorship: true\n");
  // The core's country rules, loaded from the checkout at runtime like cv-publication.
  writeFileSync(join(codeRoot, "verify-report-consistency.mjs"), [
    "export function countryOf(text) { const s = String(text ?? '').toLowerCase(); return /spain/.test(s) ? 'Spain' : /germany/.test(s) ? 'Germany' : null; }",
    "export function isAuthorized(country, authorizedIn) { return (authorizedIn ?? []).includes(country); }",
    "export function readProfileLocation() { return { authorizedIn: ['Germany'], needsSponsorship: true }; }",
  ].join("\n"));
  writeFileSync(
    join(root, "data", "applications.md"),
    [
      "| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |",
      "|---|---|---|---|---|---|---|---|---|---|",
      "| 309 | 2026-07-01 | Acme | Engineer | 4.5/5 | Evaluated | ✅ | [018](../reports/018-acme-2026-07-01.md) | | [lever](https://jobs.lever.co/acme/0e1f-engineer) |",
      "| 310 | 2026-07-01 | Acme | Manager | 3.5/5 | Evaluated | ✅ | [019](../reports/019-acme-2026-07-01.md) | | https://boards.greenhouse.io/acme/jobs/4400?utm_source=linkedin |",
      "| 311 | 2026-07-01 | Acme | Lead | 3.9/5 | Applied | ✅ | [020](../reports/020-acme-2026-07-01.md) | sent | https://jobs.acme.test/shared |",
      "| 312 | 2026-07-01 | Acme | Director | 3.2/5 | Evaluated | ❌ | [021](../reports/021-acme-2026-07-01.md) | | https://jobs.acme.test/shared |",
    ].join("\n"),
  );
  const pdfs = { "018": "cv-jane-acme-engineer-2026-07-02.pdf", "019": "cv-jane-acme-manager-2026-07-02.pdf", "020": "cv-jane-acme-lead-2026-07-02.pdf" };
  for (const [n, file] of Object.entries(pdfs)) writeFileSync(join(root, "output", file), `pdf-${n}`);
  // Receipts: 018 current, 019 stale (the stub reads the marker), 020 none.
  writeFileSync(join(root, "output", `${pdfs["018"]}.review.json`), JSON.stringify({ version: 1, status: "passed", reportNum: "18" }));
  writeFileSync(join(root, "output", `${pdfs["019"]}.review.json`), JSON.stringify({ version: 1, status: "passed", reportNum: "19", stale: true }));
  writeFileSync(
    join(root, "data", "pdf-index.tsv"),
    MANIFEST_HEADER + Object.entries(pdfs).map(([n, file]) => `${n}\toutput/${file}\t\tletter\t2026-07-02\tcv`).join("\n") + "\n",
  );

  // The tracker column map, so the URL column resolves whatever the cwd is:
  // tracker-table.mjs reads tracker-aliases.json from the data root or the
  // code root, and the stub code root has none of its own.
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tracker-aliases.json"), join(codeRoot, "tracker-aliases.json"));
  // The two core modules the web loads from the checkout at runtime.
  writeFileSync(join(codeRoot, "tracker-utils.mjs"), [
    `export const resolveTrackerPath = () => ${JSON.stringify(join(root, "data", "applications.md"))};`,
    `export const resolvePdfIndexPath = () => ${JSON.stringify(join(root, "data", "pdf-index.tsv"))};`,
  ].join("\n"));
  writeFileSync(join(codeRoot, "lib", "cv-publication.mjs"), [
    "import fs from 'node:fs';",
    "export function assertCurrentCvReview(pdf, { dataRoot, reportNum }) {",
    "  const receipt = JSON.parse(fs.readFileSync(`${pdf}.review.json`, 'utf8'));",
    "  if (receipt.reportNum !== String(Number(reportNum))) throw new Error('A current successful final-PDF review is required.');",
    "  if (receipt.stale) throw new Error('Final-PDF review is stale: career evidence changed.');",
    "  return receipt;",
    "}",
  ].join("\n"));

  const prev = { CAREER_OPS_ROOT: process.env.CAREER_OPS_ROOT, CAREER_OPS_CODE_ROOT: process.env.CAREER_OPS_CODE_ROOT };
  process.env.CAREER_OPS_ROOT = root;
  process.env.CAREER_OPS_CODE_ROOT = codeRoot;
  try {
    return await fn({ root, codeRoot, pdfs });
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(codeRoot, { recursive: true, force: true });
  }
}

test("reportVerdict reads final_decision from the Machine Summary; only Apply passes without an override", async () => {
  await withFixture(async ({ root }) => {
    assert.deepEqual(await reportVerdict(join(root, "reports", "018-acme-2026-07-01.md")), { decision: "Apply", isApply: true, requiresOverride: false, permit: null });
    assert.deepEqual(await reportVerdict(join(root, "reports", "019-acme-2026-07-01.md")), { decision: "Consider", isApply: false, requiresOverride: true, permit: null });
    assert.deepEqual(await reportVerdict(join(root, "reports", "021-acme-2026-07-01.md")), { decision: "Research first", isApply: false, requiresOverride: true, permit: null });
    // No Machine Summary at all is "missing", which is not Apply.
    assert.deepEqual(await reportVerdict(join(root, "reports", "020-acme-2026-07-01.md")), { decision: "", isApply: false, requiresOverride: true, permit: null });
    assert.deepEqual(await reportVerdict(null), { decision: "", isApply: false, requiresOverride: true, permit: null });
  });
});

test("identity joins a tracker row and a confirmed report number to the same requisition", async () => {
  await withFixture(({ root }) => {
    const byRow = identityForApplication("310");
    assert.equal(byRow.row, "310");
    assert.equal(byRow.report, "19");
    assert.equal(byRow.status, "Evaluated");
    assert.equal(byRow.company, "Acme");
    assert.equal(byRow.reportFile, join(root, "reports", "019-acme-2026-07-01.md"));
    const byReport = identityForReport("19");
    assert.deepEqual(byReport, byRow);
    assert.deepEqual(identityForReport("019"), byRow, "a padded report number names the same report");
    assert.equal(identityForApplication("999"), null);
    assert.equal(identityForReport("999"), null);
  });
});

test("the receipt gate: a current receipt is ready, a rejected one is stale, a missing one is stale", async () => {
  await withFixture(async ({ root, pdfs }) => {
    const ready = await pdfPathStatusForReport("18");
    assert.equal(ready.status, "found");
    assert.equal(ready.path, join(root, "output", pdfs["018"]));

    const stale = await pdfPathStatusForReport("19");
    assert.equal(stale.status, "stale");
    assert.equal(stale.path, join(root, "output", pdfs["019"]));
    assert.equal(stale.reason, "career evidence changed");

    const noReceipt = await pdfPathStatusForReport("20");
    assert.equal(noReceipt.status, "stale");
    assert.match(noReceipt.reason, /no final-review receipt/);

    // The strict readers never call a stale CV ready.
    assert.equal(await pdfPathForReport("18"), join(root, "output", pdfs["018"]));
    assert.equal(await pdfPathForReport("19"), null);
    assert.equal(await pdfReadyForReport("20"), false);
  });
});

test("cvReviewStatus says why when the core check cannot run at all", async () => {
  await withFixture(async ({ root, pdfs }) => {
    const pdf = join(root, "output", pdfs["018"]);
    const r = await cvReviewStatus(pdf, "18", { dataRoot: root, modulePath: join(root, "nowhere", "cv-publication.mjs") });
    assert.equal(r.current, false);
    assert.match(r.reason, /final-review check unavailable/);
    const missing = await cvReviewStatus(join(root, "output", pdfs["020"]), "20", { dataRoot: root, modulePath: join(root, "nowhere.mjs") });
    assert.match(missing.reason, /no final-review receipt/, "a missing receipt is decided before the module is needed");
  });
});

test("resolveTailoredCv by tracker row: ready, stale, or none, never a bare path", async () => {
  await withFixture(async ({ root, pdfs }) => {
    assert.deepEqual(await resolveTailoredCv(undefined, "309"), { status: "ready", path: join(root, "output", pdfs["018"]), report: "18" });
    const stale = await resolveTailoredCv(undefined, "310");
    assert.equal(stale.status, "stale");
    assert.equal(stale.report, "19");
    assert.equal(stale.reason, "career evidence changed");
    const none = await resolveTailoredCv(undefined, "312");
    assert.equal(none.status, "none");
    assert.match(none.reason, /report 21/);
    assert.equal((await resolveTailoredCv(undefined, "999")).status, "none");
  });
});

test("the company fallback marks what it finds unverifiedRole, and a confirmed report resolves through the index", async () => {
  await withFixture(async ({ root, pdfs }) => {
    const fallback = await resolveTailoredCv("Acme");
    assert.equal(fallback.status, "unverified-role");
    assert.equal(fallback.unverifiedRole, true);
    assert.ok(Object.values(pdfs).map((f) => join(root, "output", f)).includes(fallback.path));

    // Same through the session resolver with only a page title to go on.
    const byTitle = await resolveSessionCv({ title: "Engineer @ Acme" });
    assert.equal(byTitle.status, "unverified-role");

    // The user confirms the report: the index answers, receipt and all.
    assert.deepEqual(await resolveConfirmedCv("18"), { status: "ready", path: join(root, "output", pdfs["018"]), report: "18" });
    assert.equal((await resolveSessionCv({ title: "Engineer @ Acme", confirmReport: "19" })).status, "stale");
    assert.equal((await resolveConfirmedCv("21")).status, "none");
    assert.equal((await resolveConfirmedCv("abc")).status, "none");
  });
});

test("applyGateStatus answers the fill route and the page with one resolution", async () => {
  await withFixture(async ({ root, pdfs }) => {
    const apply = await applyGateStatus({ application: "309" });
    assert.equal(apply.verdict.decision, "Apply");
    assert.equal(apply.verdict.requiresOverride, false);
    assert.equal(apply.cv.status, "ready");
    assert.equal(apply.identity.row, "309");

    const consider = await applyGateStatus({ application: "310", company: "Acme" });
    assert.equal(consider.verdict.requiresOverride, true);
    assert.equal(consider.cv.status, "stale");

    // A pasted URL the tracker does not know: no verdict to read, CV by company name only.
    const pasted = await applyGateStatus({ company: "Acme", url: "https://jobs.acme.test/never-evaluated" });
    assert.equal(pasted.verdict, null);
    assert.equal(pasted.identity, null);
    assert.equal(pasted.cv.status, "unverified-role");

    // ...until the report number is confirmed, which also brings its verdict.
    const confirmed = await applyGateStatus({ company: "Acme", confirmReport: "18" });
    assert.equal(confirmed.identity.row, "309");
    assert.equal(confirmed.verdict.decision, "Apply");
    assert.deepEqual(confirmed.cv, { status: "ready", path: join(root, "output", pdfs["018"]), report: "18" });

    // What the page receives carries the basename only.
    const pub = publicCv(confirmed.cv);
    assert.deepEqual(pub, { status: "ready", file: pdfs["018"], report: "18", reason: null, unverifiedRole: false });
    assert.ok(!JSON.stringify(pub).includes(root));
    assert.deepEqual(publicCv(pasted.cv).unverifiedRole, true);
  });
});

test("a pasted URL resolves to the tracker row that evaluated the same posting, and ambiguity stays unresolved", async () => {
  await withFixture(async ({ pdfs }) => {
    // Lever serves the form at /apply with a source param; the tracker holds the posting URL as a markdown link.
    const lever = identityForUrl("https://jobs.lever.co/acme/0e1f-engineer/apply?lever-source=LinkedIn");
    assert.equal(lever?.row, "309");
    assert.equal(lever?.report, "18");
    // Greenhouse: a tracking param on the tracker side and the #app fragment on the form side are the same posting.
    const gh = identityForUrl("http://boards.greenhouse.io/acme/jobs/4400#app");
    assert.equal(gh?.row, "310");
    // Two rows share one URL: no guess, the user confirms the report number.
    assert.equal(identityForUrl("https://jobs.acme.test/shared"), null);
    assert.equal(identityForUrl("not a url"), null);
    assert.equal(identityForUrl(""), null);

    // Through the gate: the URL match brings the verdict and the indexed CV, so the
    // fill route has a verdict to check, which is what closes the pasted-URL bypass.
    const viaUrl = await applyGateStatus({ company: "Acme", url: "https://jobs.lever.co/acme/0e1f-engineer/apply" });
    assert.equal(viaUrl.identity.row, "309");
    assert.equal(viaUrl.verdict.decision, "Apply");
    assert.equal(viaUrl.cv.status, "ready");
    assert.equal(viaUrl.cv.path.endsWith(pdfs["018"]), true);
    const considerViaUrl = await applyGateStatus({ company: "Acme", url: "https://boards.greenhouse.io/acme/jobs/4400" });
    assert.equal(considerViaUrl.verdict.requiresOverride, true);
    // An explicit tracker row or confirmed report still wins over the URL.
    const explicit = await applyGateStatus({ application: "310", url: "https://jobs.lever.co/acme/0e1f-engineer/apply" });
    assert.equal(explicit.identity.row, "310");
  });
});

test("the permit question makes an Apply verdict require an override: from the evaluator's tier, or from a posting location outside authorized_in", async () => {
  await withFixture(async ({ root }) => {
    const marked = await reportVerdict(join(root, "reports", "022-acme-2026-07-01.md"));
    assert.equal(marked.isApply, true);
    assert.equal(marked.requiresOverride, true);
    assert.match(marked.permit, /permit question/);
    const located = await reportVerdict(join(root, "reports", "023-acme-2026-07-01.md"));
    assert.equal(located.isApply, true);
    assert.equal(located.requiresOverride, true);
    assert.match(located.permit, /"Barcelona, Spain" is outside/);
    // A German posting for the same candidate is no question.
    const home = await reportVerdict(join(root, "reports", "018-acme-2026-07-01.md"));
    assert.equal(home.permit, null);
  });
});
