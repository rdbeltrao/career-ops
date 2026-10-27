import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CV_PALETTES } from "../../src/lib/cv-palettes.mjs";
import { renderCvTemplatePreview } from "../../src/lib/cv-template-preview.mjs";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cssVars = { accent_color: "--accent-color", secondary_color: "--secondary-color", tag_color: "--tag-color", tag_bg: "--tag-bg", tag_border: "--tag-border" };

test("every palette renders its coordinated colors through the real CV preview", async () => {
  for (const palette of CV_PALETTES) {
    const html = await renderCvTemplatePreview({ codeRoot, template: "standard", style: { ...palette.colors, font_family: "Georgia, serif", font_size: "10pt" } });
    for (const [key, color] of Object.entries(palette.colors)) assert.ok(html.includes(`${cssVars[key]}: ${color};`), `${palette.id}: ${key}`);
    assert.match(html, /--font-family: Georgia, serif/);
    assert.match(html, /--font-size: 10pt/);
    assert.match(html, /Alex Example/);
    assert.match(html, /career-ops-preview-page/);
  }
});

test("palette tokens also render with serif and plain ATS layouts", async () => {
  for (const template of ["executive", "ats"]) {
    const html = await renderCvTemplatePreview({ codeRoot, template, style: CV_PALETTES[0].colors });
    assert.match(html, /Alex Example/);
    for (const [key, color] of Object.entries(CV_PALETTES[0].colors)) assert.ok(html.includes(`${cssVars[key]}: ${color};`), `${template}: ${key}`);
    assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/);
  }
});
