// Optional UI regression. All settings APIs are mocked; no candidate files change.
// Run against a loopback app: CV_TEMPLATES_TEST_URL=http://127.0.0.1:3000 node --test this-file.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CV_PALETTES, PALETTE_COLOR_KEYS } from "../../src/lib/cv-palettes.mjs";

const target = process.env.CV_TEMPLATES_TEST_URL;

test("CV templates preview, preserve drafts on errors, save and reload preferences", { skip: !target, timeout: 120_000 }, async (t) => {
  const url = new URL(target);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(10_000);
  let saved = {
    templates: [{ name: "standard", displayName: "Standard", description: "Balanced layout." }, { name: "compact", displayName: "Compact", description: "Dense layout." }, { name: "ats", displayName: "ATS Friendly", description: "Simple layout." }],
    vendors: [{ id: "greenhouse", label: "Greenhouse" }, { id: "lever", label: "Lever" }],
    revision: "initial",
    preferences: { template: "standard", useAtsGuidance: false, atsTemplates: {}, style: { accent_color: "hsl(220 25% 35%)", secondary_color: "#303b45", tag_color: "#31465a", tag_bg: "#f0f5fa", tag_border: "#cad6e3", font_family: "Existing font, serif", font_size: "10px" } },
  };
  const writes = [];
  const previews = [];
  let failSave = true;
  await page.route("**/api/cv-templates", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: saved });
    const body = request.postDataJSON();
    if (request.method() === "POST" && body.preview) {
      previews.push(body);
      return route.fulfill({ json: { html: `<html><body>Fictional sample: ${body.template}, ${body.style.accent_color || "default"}</body></html>` } });
    }
    if (request.method() !== "PUT") throw new Error(`Unexpected method: ${request.method()}`);
    writes.push(body);
    if (failSave) return route.fulfill({ status: 409, json: { error: "Profile changed. Reload saved preferences before saving." } });
    saved = { ...saved, preferences: body.preferences, revision: "saved" };
    return route.fulfill({ json: saved });
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url.origin}/cv/templates`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("heading", { name: "Templates & style", exact: true }).waitFor();
  await page.getByRole("group", { name: "Color palette", exact: true }).waitFor();
  await page.getByText("Custom colors", { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('iframe[title="Sample CV preview"]')?.srcdoc.includes("hsl(220 25% 35%)"));
  assert.equal(writes.length, 0, "opening legacy custom colors never saves or replaces them");
  assert.equal(await page.getByLabel("Accent color", { exact: true }).count(), 0);
  const paletteGroup = page.getByRole("group", { name: "Color palette", exact: true });
  assert.equal(await paletteGroup.getByRole("button").count(), 13);
  for (const palette of CV_PALETTES) assert.equal(await paletteGroup.getByRole("button", { name: `${palette.name} palette`, exact: true }).count(), 1);
  const chosenPalette = CV_PALETTES.find(palette => palette.id === "midnight");
  assert.ok(chosenPalette);
  await page.getByRole("button", { name: `${chosenPalette.name} palette`, exact: true }).click();
  await page.getByRole("button", { name: "Compact Dense layout.", exact: true }).click();
  await page.getByLabel("Font", { exact: true }).selectOption("Georgia, serif");
  await page.getByLabel("Text size", { exact: true }).selectOption("11pt");
  await page.getByLabel("Use ATS guidance when available").check();
  await page.getByText("ATS-specific templates", { exact: true }).click();
  await page.getByLabel("Greenhouse template", { exact: true }).selectOption("ats");
  await page.waitForFunction(accent => document.querySelector('iframe[title="Sample CV preview"]')?.srcdoc.includes(`compact, ${accent}`), chosenPalette.colors.accent_color);
  assert.equal(await page.getByTitle("Sample CV preview", { exact: true }).evaluate((frame) => frame.clientWidth), 794, "sample keeps A4 geometry instead of clipping or reflowing to the sidebar width");
  assert.equal(writes.length, 0, "preview never saves preferences");
  assert.ok(previews.some((p) => p.template === "compact" && p.style.font_family === "Georgia, serif"));
  for (const key of PALETTE_COLOR_KEYS) assert.equal(previews.at(-1).style[key], chosenPalette.colors[key]);
  await page.getByRole("button", { name: "Save preferences", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Profile changed." }).waitFor();
  assert.equal(await page.getByLabel("Font", { exact: true }).inputValue(), "Georgia, serif");
  assert.equal(await page.getByLabel("Text size", { exact: true }).inputValue(), "11pt");
  failSave = false;
  await page.getByRole("button", { name: "Save preferences", exact: true }).click();
  await page.getByText("Preferences saved. New CVs will use these settings.", { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1).preferences, { template: "compact", useAtsGuidance: true, atsTemplates: { greenhouse: "ats" }, style: { ...chosenPalette.colors, font_family: "Georgia, serif", font_size: "11pt" } });
  assert.equal(writes.at(-1).revision, "initial");
  await page.reload();
  await page.getByRole("button", { name: "Compact Dense layout.", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Compact Dense layout.", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByLabel("Font", { exact: true }).inputValue(), "Georgia, serif");
  assert.equal(await page.getByRole("button", { name: `${chosenPalette.name} palette`, exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Template default palette", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('iframe[title="Sample CV preview"]')?.srcdoc.includes("compact, default"));
  assert.equal(writes.length, 2, "resetting the palette only previews until explicitly saved");
  for (const key of PALETTE_COLOR_KEYS) assert.equal(previews.at(-1).style[key], "");
  assert.equal(previews.at(-1).style.font_family, "Georgia, serif");
  assert.equal(previews.at(-1).style.font_size, "11pt");
  await page.getByRole("button", { name: "Save preferences", exact: true }).click();
  await page.getByText("Preferences saved. New CVs will use these settings.", { exact: true }).waitFor();
  assert.equal(writes.at(-1).revision, "saved");
  for (const key of PALETTE_COLOR_KEYS) assert.equal(writes.at(-1).preferences.style[key], "");
  await page.reload();
  await page.getByRole("button", { name: "Template default palette", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Template default palette", exact: true }).getAttribute("aria-pressed"), "true");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
});
