import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readPdfWorkerInputs, pdfReportContext, pdfContentProcedure } from "../../src/lib/pdf-worker-inputs.mjs";
import { buildPrompt } from "../../src/lib/run-prompts.mjs";
import { claudeCliArgs, argValue } from "../../src/lib/claude-invocation.mjs";
import { parseCvPayloadEnvelope, createCvPayloadEnvelopeFilter } from "../../src/lib/cv-payload-envelope.mjs";
import { buildCvPayload } from "../../src/lib/pdf-render.mjs";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const payload = { page_format: "a4", candidate: { name: "Ada Example" }, summary: "Built reliable services.", experience: [{ company: "Example", role: "Engineer", dates: "2020 - Present", bullets: ["Built reliable services."] }] };
const envelope = `<<cv-json>>\n${JSON.stringify(payload)}\n<</cv-json>>`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-worker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "config"));
  fs.mkdirSync(path.join(root, "reports"));
  fs.mkdirSync(path.join(root, "modes"));
  fs.mkdirSync(path.join(root, "scratch"));
  fs.writeFileSync(path.join(root, "config/profile.yml"), 'candidate:\n  full_name: Ada Example\n  email: ada@example.com\nprivate_connection: OMIT_PRIVATE_CONNECTION\ncv:\n  template: compact\n');
  fs.writeFileSync(path.join(root, "modes/_custom.md"), "Use plain language.");
  fs.writeFileSync(path.join(root, "reports/001-example.md"), "Seeking an engineer. UNTRUSTED_REPORT_DATA");
  return root;
}

test("preloaded PDF prompt excludes reference pages, qualified facts and unrelated profile settings", async t => {
  const dataRoot = fixture(t);
  const pdfInputs = await readPdfWorkerInputs({ codeRoot, dataRoot, reportFile: "reports/001-example.md", hasContext: true });
  const contextLibrary = {
    source: "library", notice: "Only facts support claims.", text: "FULL_REFERENCE_MATERIAL", evidenceText: "CURRENT_FACT",
    pages: [
      { breadcrumb: ["Career", "Experience"], relativePath: "data/context-workspace/pages/facts.md", usage: "facts", content: "CURRENT_FACT\nHELD_FOR_CONFIRMATION", evidenceText: "CURRENT_FACT" },
      { breadcrumb: ["Reference"], relativePath: "reference.md", usage: "reference", content: "FULL_REFERENCE_MATERIAL", evidenceText: "" },
      { breadcrumb: ["Preferences"], relativePath: "preferences.md", usage: "preferences", content: "Prefer remote roles.", evidenceText: "" },
    ],
  };
  const prompt = buildPrompt({ kind: "pdf", input: "001", memory: "STALE_MEMORY", today: "2026-10-26", cvTemplate: "templates/cv-template.compact.html", contextLibrary, pdfInputs });
  for (const included of ["CURRENT_FACT", "facts.md:1", "Ada Example", "Use plain language.", "UNTRUSTED_REPORT_DATA", "JSON Input Schema", "templates/cv-template.compact.html"]) assert.ok(prompt.includes(included), included);
  for (const excluded of ["FULL_REFERENCE_MATERIAL", "HELD_FOR_CONFIRMATION", "OMIT_PRIVATE_CONNECTION", "STALE_MEMORY", "Prefer remote roles."]) assert.ok(!prompt.includes(excluded), excluded);
  assert.match(prompt, /do not calculate years of experience/i);
  assert.match(prompt, /Do not read or search files/);
  assert.doesNotMatch(prompt, /VERDICT:.*5/);
  assert.equal(argValue(claudeCliArgs({ kind: "pdf", prompt, inlineInputs: true }), "--tools"), "");
  assert.equal(claudeCliArgs({ kind: "evaluate", prompt, inlineInputs: true }).includes("--tools"), false);
});

test("missing or malformed PDF inputs fail instead of sending an incomplete prompt", async t => {
  const dataRoot = fixture(t);
  await assert.rejects(() => readPdfWorkerInputs({ codeRoot, dataRoot, reportFile: "reports/missing.md", hasContext: true }), /ENOENT/);
  fs.writeFileSync(path.join(dataRoot, "config/profile.yml"), "candidate: [broken");
  await assert.rejects(() => readPdfWorkerInputs({ codeRoot, dataRoot, reportFile: "reports/001-example.md", hasContext: true }));
});

test("linked JD archives are preloaded and paraphrased signals are not offered as quotes", async t => {
  const dataRoot = fixture(t);
  fs.mkdirSync(path.join(dataRoot, "jds"));
  const archive = "Führe ein Engineering-Team. Verbessere die Zuverlässigkeit. Arbeite mit dem Produktteam zusammen.";
  fs.writeFileSync(path.join(dataRoot, "jds/example.md"), archive);
  const report = `# Evaluation: Example
## Job Description (archived verbatim)
See jds/example.md for the full archive.
## Machine Summary
\`\`\`yaml
requirement_importance:
  - requirement: Team leadership
    jd_signal: Lead an engineering team
    importance: critical
  - requirement: Reliability
    jd_signal: Verbessere die Zuverlässigkeit
    importance: high
  - requirement: Product partnership
    jd_signal: Collaborate with Product
    importance: high
\`\`\`
`;
  fs.writeFileSync(path.join(dataRoot, "reports/001-example.md"), report);
  const inputs = await readPdfWorkerInputs({ codeRoot, dataRoot, reportFile: "reports/001-example.md", hasContext: true });
  assert.ok(inputs.includes(archive));
  const match = /BEGIN INPUT Publication brief[^\n]*\n([^]*?)\nEND INPUT/.exec(inputs);
  const brief = JSON.parse(match[1]);
  assert.equal(brief.criticalRequirements[0].jdSignal, "Lead an engineering team");
  assert.equal(brief.criticalRequirements[0].jdQuote, null);
  assert.equal(brief.criticalRequirements[1].jdQuote, "Verbessere die Zuverlässigkeit");
  assert.equal(brief.criticalRequirements[2].jdQuote, null);
  const prompt = buildPrompt({ kind: "pdf", input: "001", memory: "", today: "2026-11-01", pdfInputs: inputs });
  assert.match(prompt, /keeping its original language/);
  assert.match(prompt, /When jdQuote is null, find the corresponding exact passage/);
  fs.rmSync(path.join(dataRoot, "jds/example.md"));
  await assert.rejects(() => readPdfWorkerInputs({ codeRoot, dataRoot, reportFile: "reports/001-example.md", hasContext: true }), /archived job description is empty or unavailable/);
});

test("legacy PDF inputs read each fallback source from the runtime data root", async t => {
  const dataRoot = fixture(t);
  const files = ["modes/_context.md", "cv.md", "article-digest.md", "modes/_profile.md", "voice-dna.md"];
  for (const [index, file] of files.entries()) {
    fs.writeFileSync(path.join(dataRoot, file), `RUNTIME_SOURCE_${index}`);
  }
  const inputs = await readPdfWorkerInputs({ codeRoot, dataRoot, reportFile: "reports/001-example.md", hasContext: false });
  for (const index of files.keys()) assert.ok(inputs.includes(`RUNTIME_SOURCE_${index}`));
  assert.match(inputs, /Use plain language\./);
  assert.match(inputs, /UNTRUSTED_REPORT_DATA/);
  assert.doesNotMatch(inputs, /OMIT_PRIVATE_CONNECTION/);
});

test("compact inputs preserve nested job requirements and mode rules while excluding unrelated workflows", () => {
  const report = "# Evaluation: Example\nRole header\n## Job Description\nBuild services\n### Requirements\nREQUIRED_SKILL\n## D) Compensation and Demand\nUNRELATED_RESEARCH\n## Extracted Keywords\nKEYWORD";
  const compact = pdfReportContext(report);
  assert.match(compact, /Role header/);
  assert.match(compact, /REQUIRED_SKILL/);
  assert.match(compact, /KEYWORD/);
  assert.doesNotMatch(compact, /UNRELATED_RESEARCH/);
  assert.equal(pdfReportContext("Custom legacy report without headings"), "Custom legacy report without headings");
  const mode = "## ATS Rules\nUse readable text\n### Nested content rule\nKEEP_RULE\n## Application-scoped artifacts\nOMIT_BUILD_WORKFLOW\n### JSON Input Schema\n{}";
  assert.match(pdfContentProcedure(mode), /KEEP_RULE/);
  assert.doesNotMatch(pdfContentProcedure(mode), /OMIT_BUILD_WORKFLOW/);
  assert.throws(() => pdfContentProcedure("## ATS Rules\nNo schema"), /missing its JSON Input Schema/);
});

test("CV JSON filtering never exposes draft success, including every stream split", () => {
  const text = `VERDICT: 5/5 — not yet verified\n${envelope}\nClaimed success`;
  for (let cut = 0; cut <= text.length; cut++) {
    const filter = createCvPayloadEnvelopeFilter();
    assert.equal(filter.push(text.slice(0, cut)) + filter.push(text.slice(cut)) + filter.flush(), "");
    assert.deepEqual(filter.result(), { ok: true, payload, format: "a4", warnings: [] });
  }
});

test("CV JSON rejects duplicate, incomplete, invalid and oversized drafts", () => {
  for (const text of [envelope + "\n" + envelope, envelope.replace("<</cv-json>>", ""), "<<cv-json>>\n{}\n<</cv-json>>", "<<cv-json>>\n{broken}\n<</cv-json>>", envelope.replace('"a4"', '"auto"')]) assert.equal(parseCvPayloadEnvelope(text).ok, false, text);
  const filter = createCvPayloadEnvelopeFilter();
  filter.push("x".repeat(256_001));
  filter.push(envelope);
  assert.equal(filter.result().ok, false);
});

test("web CV JSON uses the real core builder and selected template", async t => {
  const root = fixture(t);
  const html = path.join(root, "scratch/cv-web-001.html");
  const template = "templates/cv-template.compact.html";
  const result = await buildCvPayload({ spawnFn: spawn, execPath: process.execPath, root, codeRoot, pdfPaths: { html }, payload, template });
  assert.equal(result.ok, true, result.error);
  const rendered = fs.readFileSync(html, "utf8");
  assert.match(rendered, /Ada Example/);
  assert.match(rendered, /Built reliable services/);
  assert.doesNotMatch(rendered, /\{\{[A-Z_]+\}\}/);
  assert.equal(fs.existsSync(html.replace(/\.html$/, ".json")), false);
  const invalid = await buildCvPayload({ spawnFn: spawn, execPath: process.execPath, root, codeRoot, pdfPaths: { html }, payload: { ...payload, education: [{ institution: "Wrong schema" }] }, template });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /Invalid CV payload/);
});

test("ATS template generation uses canonical payload folding without rewriting facts", async t => {
  const root = fixture(t);
  const html = path.join(root, "scratch/ats.html");
  const original = { ...payload, competencies: ["People leadership", "Product delivery"] };
  const result = await buildCvPayload({ spawnFn: spawn, execPath: process.execPath, root, codeRoot, pdfPaths: { html }, payload: original, template: "templates/ats/cv-template.ats.html" });
  assert.equal(result.ok, true, result.error);
  const rendered = fs.readFileSync(html, "utf8");
  const text = rendered.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  assert.match(text, /Core Competencies:\s*People leadership, Product delivery/);
  assert.match(text, /Built reliable services\./);
  assert.deepEqual(original.competencies, ["People leadership", "Product delivery"]);
});

test("real web publication checks the rendered PDF before readiness and refuses stale reviews", async t => {
  const { renderAndMarkPdf } = await import('../../src/lib/pdf-render.mjs');
  const root = fixture(t);
  const text = 'Led engineering delivery and product partnerships, coached engineers through clear expectations, improved release practices and strengthened production reliability across customer-facing software.';
  const dates = 'January 2020 – Present';
  fs.writeFileSync(path.join(root, 'config/cv-facts.json'), '{}');
  fs.writeFileSync(path.join(root, 'cv.md'), `# Ada Example\n\n## Experience\n\n### Example — Berlin\n\n**Engineer**\n${dates}\n\n- ${text}\n`);
  fs.writeFileSync(path.join(root, 'modes/_context.md'), `# Career facts\n\nExample: Engineer. ${text}`);
  const requirements = ['Lead engineering delivery', 'Coach engineers with clear expectations', 'Improve production reliability'];
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  fs.mkdirSync(path.join(root, 'jds'));
  const archive = path.join(root, 'jds/example.pdf');
  try {
    const page = await browser.newPage();
    await page.setContent(requirements.map(requirement => `<p>${requirement}.</p>`).join(''));
    await page.pdf({ path: archive });
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(root, 'reports/001-example.md'), '# Evaluation: Example\n\n## Job Description\n\nSee jds/example.pdf for the full archive.\n');
  const inputs = await readPdfWorkerInputs({ codeRoot, dataRoot: root, reportFile: 'reports/001-example.md', hasContext: true });
  for (const requirement of requirements) assert.ok(inputs.includes(requirement));
  assert.doesNotMatch(inputs, /%PDF-/);
  fs.mkdirSync(path.join(root, 'data'));
  fs.mkdirSync(path.join(root, 'output'));
  fs.writeFileSync(path.join(root, 'data/applications.md'), '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n| 1 | 2026-11-01 | Example | Engineer | 4/5 | Evaluated | ❌ | [001](../reports/001-example.md) | |\n');
  const tailored = { ...payload, summary: text, experience: [{ company: 'Example', role: 'Engineer', dates, bullets: [text] }], tailoring: { requirements: requirements.map(requirement => ({ requirement, jdQuote: requirement, match: 'supported', evidence: [{ source: 'modes/_context.md', quote: text }], placements: [{ section: 'summary', claim: text }] })) } };
  const paths = { html: path.join(root, 'scratch/cv-web-001.html'), finalPdf: path.join(root, 'output/cv.pdf'), reportFile: 'reports/001-example.md' };
  const bad = await buildCvPayload({ spawnFn: spawn, execPath: process.execPath, root, codeRoot, pdfPaths: paths, template: 'templates/cv-template.compact.html', payload: { ...tailored, experience: [{ ...tailored.experience[0], dates: '' }] } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /complete employment period/);
  const built = await buildCvPayload({ spawnFn: spawn, execPath: process.execPath, root, codeRoot, pdfPaths: paths, template: 'templates/cv-template.compact.html', payload: tailored });
  assert.equal(built.ok, true, built.error);
  const published = await renderAndMarkPdf({ spawnFn: spawn, execPath: process.execPath, root, codeRoot, pdfPaths: paths, format: 'a4', reportNum: '001' });
  assert.equal(published.kind, 'rendered', published.error);
  assert.equal(published.warnings.length, 0, published.warnings.join('\n'));
  assert.match(fs.readFileSync(path.join(root, 'data/applications.md'), 'utf8'), /✅/);
  const review = JSON.parse(fs.readFileSync(`${paths.finalPdf}.review.json`, 'utf8'));
  assert.equal(review.status, 'passed');
  assert.equal(review.pages.length, 1);
  fs.appendFileSync(paths.finalPdf, 'changed after review');
  const mark = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(codeRoot, 'mark-pdf-ready.mjs'), '001', '--json'], { env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_TRACKER: '', CAREER_OPS_PDF_INDEX: '' } });
    let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.resume(); child.on('close', code => resolve({ code, output }));
  });
  assert.equal(mark.code, 1);
  assert.match(mark.output, /review-required/);
  fs.writeFileSync(archive, '%PDF-1.4\ncorrupt');
  await assert.rejects(() => readPdfWorkerInputs({ codeRoot, dataRoot: root, reportFile: 'reports/001-example.md', hasContext: true }), /Could not extract the archived PDF job description/);
});
