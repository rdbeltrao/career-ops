import assert from "node:assert/strict";
import { test } from "node:test";

// All API reads/writes below use fictional fixtures; no AI worker is launched.
test("Config lists installed-client models, recovers unsupported selections, and handles discovery failure", { skip: !process.env.AI_MODEL_CONFIG_TEST_URL, timeout: 90_000 }, async () => {
  const url = new URL(process.env.AI_MODEL_CONFIG_TEST_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let settings = { version: 1, cliId: "codex", models: { codex: { provider: "", model: "gpt-6.1-sol" } } };
  let catalogFails = false;
  let catalogRequests = 0;
  let saves = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    if (requestUrl.pathname === "/api/clis") return route.fulfill({ json: { configured: settings.cliId, clis: [
      { id: "codex", name: "Codex", run: "codex exec", installed: true, path: "/fictional/codex", url: "https://example.com" },
      { id: "claude", name: "Claude Code", run: "claude -p", installed: true, path: "/fictional/claude", url: "https://example.com" },
    ] } });
    if (requestUrl.pathname === "/api/ai-settings") {
      if (request.method() === "POST") { saves++; settings = request.postDataJSON(); }
      return route.fulfill({ json: { settings } });
    }
    if (requestUrl.pathname === "/api/ai-models") {
      catalogRequests++;
      if (catalogFails) return route.fulfill({ status: 503, json: { error: "Fictional discovery failure" } });
      if (requestUrl.searchParams.get("provider") === "ollama") return route.fulfill({ json: { models: [], warning: "Use a custom model ID from this provider's own model list." } });
      return route.fulfill({ json: { models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", isDefault: true }, { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", isDefault: false }], warning: null } });
    }
    if (requestUrl.pathname === "/api/config-files") return route.fulfill({ json: { files: [] } });
    return route.fulfill({ status: 404, json: {} });
  });
  const model = page.getByRole("combobox", { name: "Model", exact: true });
  const warning = page.getByRole("alert").filter({ hasText: "This model is not listed by your Codex CLI" });
  const loaded = page.getByRole("status").filter({ hasText: "Models reported by your installed Codex CLI" });
  try {
    await page.goto(`${url.origin}/config`);
    await warning.waitFor();
    assert.equal(await model.getByRole("option", { name: "GPT-5.6 Sol (recommended by CLI)", exact: true }).count(), 1);
    assert.equal(await model.locator('option[value="gpt-6.1-sol"]').count(), 0, "the rejected generic model is never offered as a preset");
    assert.equal(await page.getByRole("textbox", { name: "Custom model ID", exact: true }).inputValue(), "gpt-6.1-sol", "unknown saved models remain visible for repair");
    assert.equal(saves, 0, "discovery never rewrites a saved model");

    await model.selectOption("gpt-5.6-sol");
    await page.getByRole("button", { name: "Save config", exact: true }).click();
    await page.getByRole("button", { name: "Saved", exact: true }).waitFor();
    assert.equal(settings.models.codex.model, "gpt-5.6-sol");
    await page.reload();
    await loaded.waitFor();
    assert.equal(await model.inputValue(), "gpt-5.6-sol", "a saved discovered model restores as a preset after asynchronous discovery");

    const beforeRefresh = catalogRequests;
    catalogFails = true;
    await page.getByRole("button", { name: "Refresh models", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Could not load models from the installed Codex CLI" }).waitFor();
    assert.ok(catalogRequests > beforeRefresh);
    assert.equal(await model.locator('option[value="gpt-5.6-sol"]').count(), 0, "failed discovery does not retain a stale preset catalog");
    assert.equal(settings.models.codex.model, "gpt-5.6-sol", "failure never silently substitutes a different model");

    catalogFails = false;
    await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption("ollama");
    await page.getByRole("status").filter({ hasText: "Use a custom model ID from this provider" }).waitFor();
    assert.equal(await model.inputValue(), "", "changing provider clears the previous provider's model");
    assert.equal(await model.locator('option[value="gpt-5.6-sol"]').count(), 0, "local providers never show OpenAI model presets");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
