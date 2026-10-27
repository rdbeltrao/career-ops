import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCvTemplateSelection, reportPostingUrl } from "../../src/lib/core/cv-template.mjs";
import { renderCvTemplatePreview } from "../../src/lib/cv-template-preview.mjs";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cv-settings-web-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(path.join(root, "config/profile.yml"), "cv:\n  template: compact\n  ats_guidance: true\n  ats_templates:\n    ashby: executive\n");
  return root;
}

test("web selection uses the separate data root, saved ATS overrides and explicit choices", async t => {
  const dataRoot = fixture(t);
  const saved = await resolveCvTemplateSelection(codeRoot, { dataRoot, url: "https://jobs.ashbyhq.com/example/1" });
  assert.equal(saved.name, "executive");
  assert.equal(saved.template, "templates/cv-template.executive.html");
  assert.equal(saved.source, "ats-override");
  const guided = await resolveCvTemplateSelection(codeRoot, { dataRoot, url: "https://boards.greenhouse.io/example/jobs/1" });
  assert.equal(guided.template, "templates/ats/cv-template.ats.html");
  const explicit = await resolveCvTemplateSelection(codeRoot, { dataRoot, template: "jake", url: "https://jobs.ashbyhq.com/example/1" });
  assert.equal(explicit.name, "jake");
  await assert.rejects(resolveCvTemplateSelection(codeRoot, { dataRoot, template: "../../private" }), /template/i);
});

test("malformed preferences fail rather than selecting a different CV", async t => {
  const dataRoot = fixture(t);
  fs.writeFileSync(path.join(dataRoot, "config/profile.yml"), "cv: [broken");
  await assert.rejects(resolveCvTemplateSelection(codeRoot, { dataRoot }), /YAML|parse|flow|end|comma/i);
});

test("real template previews render synthetic content and the actual theme", async () => {
  for (const template of ["compact", "ats", "executive"]) {
    const html = await renderCvTemplatePreview({ codeRoot, template, style: { accent_color: "#336699", font_family: "Georgia, serif", font_size: "11pt" } });
    assert.match(html, /Alex Example/);
    assert.match(html, /Example Company/);
    assert.match(html, /--accent-color: #336699/);
    assert.match(html, /--font-family: Georgia, serif/);
    assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/);
  }
});

test("preview rejects missing templates and CSS injection", async () => {
  await assert.rejects(renderCvTemplatePreview({ codeRoot, template: "../../private", style: {} }), /template/i);
  await assert.rejects(renderCvTemplatePreview({ codeRoot, template: "compact", style: { accent_color: "red; } </style>" } }), /style|color|invalid/i);
});

test("sample preview supplies the screen equivalent of the PDF page margins", async () => {
  const html = await renderCvTemplatePreview({ codeRoot, template: "standard", style: {} });
  assert.match(html, /id="career-ops-preview-page"/);
  assert.match(html, /@media screen[\s\S]*padding:\s*var\(--page-margin,\s*0\.6in\)/);
});

test("only the report URL header identifies the ATS", () => {
  assert.equal(reportPostingUrl("**URL:** [Apply](https://jobs.ashbyhq.com/example/1)\n\nBody https://boards.greenhouse.io/other"), "https://jobs.ashbyhq.com/example/1");
  assert.equal(reportPostingUrl("Untrusted body: https://jobs.ashbyhq.com/example/1"), undefined);
});

test("preview ignores ambient candidate profile and tracker overrides", async t => {
  const dataRoot = fixture(t);
  const profile = path.join(dataRoot, "config/profile.yml");
  fs.writeFileSync(profile, 'cv:\n  locked_sections: [experience]\n');
  fs.writeFileSync(path.join(dataRoot, "cv.md"), "# PRIVATE CANDIDATE — must never enter a sample preview\n");
  const priorProfile = process.env.CAREER_OPS_PROFILE;
  const priorTracker = process.env.CAREER_OPS_TRACKER;
  t.after(() => {
    if (priorProfile === undefined) delete process.env.CAREER_OPS_PROFILE; else process.env.CAREER_OPS_PROFILE = priorProfile;
    if (priorTracker === undefined) delete process.env.CAREER_OPS_TRACKER; else process.env.CAREER_OPS_TRACKER = priorTracker;
  });
  process.env.CAREER_OPS_PROFILE = profile;
  process.env.CAREER_OPS_TRACKER = path.join(dataRoot, "data/applications.md");
  const html = await renderCvTemplatePreview({ codeRoot, template: "compact", style: { accent_color: "hsl(220 50% 30%)", font_size: "10px" } });
  assert.match(html, /Alex Example/);
  assert.match(html, /--font-size: 10px/);
  assert.doesNotMatch(html, /PRIVATE CANDIDATE/);
});
