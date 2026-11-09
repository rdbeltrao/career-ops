/**
 * apply-fill-gate-wiring.test.mjs: the gates (apply-gates.mjs, gate.ts) reach
 * a real application only through the routes and the page, pinned where they
 * live. The library tests prove each rule; these read the source so that
 * dropping one call puts the old behaviour back silently.
 *
 * Driving the routes needs a live apply session and a headed browser, so this
 * follows apply-prefill-wiring.test.mjs: source pins, not a server.
 *
 * Run (from web/):  node --test tests/lib/apply-fill-gate-wiring.test.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const fill = read("src/app/api/apply/fill/route.ts");
const drive = read("src/app/api/apply/drive/route.ts");
const prefill = read("src/app/api/apply/prefill/route.ts");
const answers = read("src/app/api/apply/answers/route.ts");
const gateRoute = read("src/app/api/apply/gate/route.ts");
const provider = read("src/components/apply/apply-provider.tsx");
const view = read("src/components/apply-view.tsx");
const careerOps = read("src/lib/career-ops.ts");
const pipelinePage = read("src/app/pipeline/[id]/page.tsx");
const reportView = read("src/components/report-view.tsx");

test("the fill route runs the verdict gate and refuses with 409 before touching the form", () => {
  assert.match(fill, /verdictGate\(\{\s*decision:\s*gate\.verdict\.decision,\s*overrideReason\s*\}\)/);
  assert.match(fill, /code:\s*v\.code[^\n]*\{\s*status:\s*409\s*\}/);
  const gateAt = fill.indexOf("verdictGate(");
  const fillAt = fill.indexOf("await fillSession(");
  assert.ok(gateAt > 0 && fillAt > gateAt, "the verdict is checked before fillSession runs");
});

test("the fill route records an override through the canonical note writer before the fill, and stops when it cannot", () => {
  const noteAt = fill.indexOf("appendTrackerNote({ row: gate.identity.row, status: gate.identity.status, note: overrideNote })");
  const fillAt = fill.indexOf("await fillSession(");
  assert.ok(noteAt > 0, "the override note goes through appendTrackerNote (set-status.mjs)");
  assert.ok(noteAt < fillAt, "the note is written before the form is filled");
  assert.match(fill, /override-not-recorded[^\n]*\{\s*status:\s*500\s*\}/, "a note that cannot be written stops the fill");
  assert.doesNotMatch(fill, /applications\.md/, "the route never touches the tracker file itself");
});

test("the fill route attaches only what attachDecision allows and refuses stale or unverified CVs with 409", () => {
  assert.match(fill, /attachDecision\(gate\.cv,\s*\{\s*confirmReport\s*\}\)/);
  assert.match(fill, /if \(!attach\.attach && attach\.code\)[\s\S]{0,200}status:\s*409/);
  assert.match(fill, /const cvPath = attach\.attach \? attach\.path : undefined/);
  assert.match(fill, /skipCv === true \? attachDecision\(\{ status: "none" \}\)/, "an explicit skip attaches nothing instead of refusing");
});

test("the fill route records CV provenance and flips the PDF column through the canonical helpers", () => {
  assert.match(fill, /cvProvenanceNote\(\{\s*file:\s*cvPath,\s*sha256,\s*report\s*\}\)/);
  assert.match(fill, /createHash\("sha256"\)\.update\(fs\.readFileSync\(cvPath\)\)/);
  assert.match(fill, /appendTrackerNote\(\{ row: gate\.identity\.row, status: gate\.identity\.status, note \}\)/);
  assert.match(fill, /markTrackerReady\(\{[^}]*reportNum:\s*report\s*\}\)/);
  assert.match(fill, /s\.ok && s\.label\.endsWith\("\(CV attached\)"\)/, "provenance is recorded only when a résumé field took the file");
});

test("the fill route saves every typed answer itself, with the attached CV", () => {
  assert.match(fill, /persistFormAnswers\(\{[\s\S]*?state:\s*"filled"[\s\S]*?fields,[\s\S]*?answers,[\s\S]*?cvPath:\s*attached \? cvPath : null/);
  // ...and the provider no longer saves a second copy after the fill.
  const fillFn = provider.slice(provider.indexOf("const fill = useCallback"), provider.indexOf("const agentFill = useCallback"));
  assert.doesNotMatch(fillFn, /saveAnswersRef\.current\("filled"\)/, "two saves of one fill would read as two applications in the bank");
  assert.match(answers, /persistFormAnswers\(/, "the explicit save route uses the same writer");
  assert.match(answers, /cv\?\.status === "ready"/, "the explicit save records a CV only when one would have been attached");
});

test("the provider sends the gate inputs with the fill and keeps the form on a 409", () => {
  const body = provider.slice(provider.indexOf('fetch("/api/apply/fill"'), provider.indexOf("const d = await r.json();", provider.indexOf('fetch("/api/apply/fill"')));
  assert.match(body, /overrideReason:\s*overrideReasonRef\.current/);
  assert.match(body, /confirmReport:\s*confirmReportRef\.current/);
  assert.match(body, /skipCv:\s*skipCvRef\.current/);
  assert.match(provider, /setStatus\(r\.status === 409 \? "ready" : "error"\)/);
  assert.match(provider, /fetch\(`\/api\/apply\/gate\?/, "the page reads the gate before the fill");
  assert.match(provider, /confirmReport:\s*confirmReportRef\.current/, "prefill drafts from the same confirmed CV");
  assert.match(provider, /goal:\s*"full",\s*answers:\s*ans,\s*application:\s*nRef\.current,\s*overrideReason:\s*overrideReasonRef\.current/, "the agent fill carries the same verdict inputs");
});

test("the Apply page shows the verdict with a required reason field and a report-number confirmation", () => {
  assert.match(view, /function GatePanel\(\)/);
  assert.match(view, /verdict\.requiresOverride && \(/);
  assert.match(view, /value=\{a\.overrideReason\}[\s\S]{0,120}onChange=\{\(e\) => a\.setOverrideReason\(e\.target\.value\)\}/);
  assert.match(view, /value=\{a\.confirmReport\}[\s\S]{0,120}onChange=\{\(e\) => a\.setConfirmReport\(e\.target\.value\)\}/);
  assert.match(view, /disabled=\{filling \|\| prefilling \|\| fillBlocked\}/, "the Fill button waits for the gate");
  assert.match(view, /cv\.status === "stale"[\s\S]{0,300}Regenerate it before filling/);
});

test("gateBlocksFill mirrors the server's three refusals", () => {
  const fn = view.slice(view.indexOf("function gateBlocksFill("), view.indexOf("function GatePanel("));
  assert.match(fn, /requiresOverride && input\.overrideReason\.trim\(\)\.length < gate\.verdict\.minReason\) return true/);
  assert.match(fn, /gate\.cv\.status === "stale"\) return true/);
  assert.match(fn, /gate\.cv\.status === "unverified-role" && !\/\^\\d\{1,6\}\$\/\.test\(input\.confirmReport\.trim\(\)\)\) return true/);
  assert.match(fn, /if \(!gate\) return false/, "an unread gate never blocks: the server still decides");
});

test("the prefill route drafts only from a ready CV and accepts the confirmed report", () => {
  assert.match(prefill, /resolveSessionCv\(\{\s*company,\s*application,\s*title:\s*s\.title,\s*confirmReport\s*\}\)/);
  assert.match(prefill, /const cvPath = cv\.status === "ready" \? cv\.path : null/);
});

test("the agent drive applies the verdict gate to a full fill", () => {
  assert.match(drive, /goal === "full" && application\?\.trim\(\)/);
  assert.match(drive, /verdictGate\(\{\s*decision:\s*gate\.verdict\.decision,\s*overrideReason\s*\}\)/);
  assert.match(drive, /status:\s*409/);
});

test("the gate route previews through the same applyGateStatus the fill route decides with", () => {
  assert.match(gateRoute, /applyGateStatus\(\{\s*application,\s*confirmReport,\s*company,\s*title\s*\}\)/);
  assert.match(fill, /applyGateStatus\(\{\s*application,\s*confirmReport,\s*company,\s*title:\s*session\.title\s*\}\)/);
  assert.match(gateRoute, /publicCv\(status\.cv\)/, "no absolute path leaves the server");
});

test("pdfPathStatusForReport reports a stale receipt and the pipeline page shows it", () => {
  assert.match(careerOps, /\| \{ status: "stale"; path: string; reason: string \}/);
  assert.match(careerOps, /if \(kind === "cv"\) \{\s*const review = await cvReviewStatus\(abs, String\(target\)/);
  assert.match(careerOps, /return result\.status === "found" \? result\.path : null/, "pdfPathForReport stays strict");
  assert.match(pipelinePage, /pdfStaleReason=\{pdfIndex\.status === "stale" \? pdfIndex\.reason : null\}/);
  assert.match(reportView, /CV stale — regenerate before applying/);
});
