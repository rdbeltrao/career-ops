// Optional UI regression. All settings APIs are mocked; no candidate files change.
// Run against a loopback app: CV_TEMPLATES_TEST_URL=http://127.0.0.1:3000 node --test this-file.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";

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
    preferences: { template: "standard", useAtsGuidance: false, atsTemplates: {}, style: { accent_color: "", font_family: "Existing font, serif", font_size: "" } },
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
  await page.getByRole("button", { name: "Compact Dense layout.", exact: true }).click();
  await page.getByLabel("Font", { exact: true }).selectOption("Georgia, serif");
  await page.getByLabel("Text size", { exact: true }).selectOption("11pt");
  await page.getByLabel("Accent color", { exact: true }).fill("#bb3366");
  await page.getByLabel("Use ATS guidance when available").check();
  await page.getByText("ATS-specific templates", { exact: true }).click();
  await page.getByLabel("Greenhouse template", { exact: true }).selectOption("ats");
  await page.waitForFunction(() => document.querySelector('iframe[title="Sample CV preview"]')?.srcdoc.includes("compact, #bb3366"));
  assert.equal(await page.getByTitle("Sample CV preview", { exact: true }).evaluate((frame) => frame.clientWidth), 794, "sample keeps A4 geometry instead of clipping or reflowing to the sidebar width");
  assert.equal(writes.length, 0, "preview never saves preferences");
  assert.ok(previews.some((p) => p.template === "compact" && p.style.font_family === "Georgia, serif"));
  await page.getByRole("button", { name: "Save preferences", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Profile changed." }).waitFor();
  assert.equal(await page.getByLabel("Font", { exact: true }).inputValue(), "Georgia, serif");
  assert.equal(await page.getByLabel("Text size", { exact: true }).inputValue(), "11pt");
  failSave = false;
  await page.getByRole("button", { name: "Save preferences", exact: true }).click();
  await page.getByText("Preferences saved. New CVs will use these settings.", { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1).preferences, { template: "compact", useAtsGuidance: true, atsTemplates: { greenhouse: "ats" }, style: { accent_color: "#bb3366", font_family: "Georgia, serif", font_size: "11pt" } });
  assert.equal(writes.at(-1).revision, "initial");
  await page.reload();
  await page.getByRole("button", { name: "Compact Dense layout.", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Compact Dense layout.", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByLabel("Font", { exact: true }).inputValue(), "Georgia, serif");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
});
