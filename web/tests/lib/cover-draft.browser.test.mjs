// Run against disposable data: COVER_DRAFT_TEST_URL=http://127.0.0.1:3107
// node --test tests/lib/cover-draft.browser.test.mjs
// Fixture tracker/report company must be "Example Cover Fixture". All worker
// and run-log writes are intercepted; this never starts an AI worker.
import assert from "node:assert/strict";
import { test } from "node:test";

const target = process.env.COVER_DRAFT_TEST_URL;
const report = process.env.COVER_DRAFT_TEST_REPORT || "041";

test("cover draft accepts empty direction, preserves retry/redraft, and fits mobile", { skip: !target, timeout: 120_000 }, async (t) => {
  const origin = new URL(target);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname));
  assert.match(report, /^\d+$/);
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const requests = [];
  let releaseFirst;
  const firstResponse = new Promise(resolve => { releaseFirst = resolve; });
  await page.route("**/api/clis", route => route.fulfill({ json: { clis: [{ id: "fixture-cli", installed: true }] } }));
  await page.route("**/api/runs/save", route => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/run", async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    assert.equal(body.kind, "cover");
    assert.equal(body.input, report);
    if (requests.length === 1) {
      await firstResponse;
      await route.fulfill({ status: 500, json: { error: "Fixture draft failure" } });
      return;
    }
    const score = requests.length === 2 ? 1 : 5;
    await route.fulfill({ contentType: "application/x-ndjson", body: [
      { type: "text", text: `Fictional draft.\nVERDICT: ${score}/5 — ${score === 1 ? "Fixture weak draft" : "Fixture complete draft"}` },
      { type: "done" },
    ].map(event => JSON.stringify(event)).join("\n") + "\n" });
  });
  await page.addInitScript(() => localStorage.setItem("career-ops:config", JSON.stringify({ cliId: "fixture-cli" })));
  await page.goto(`${origin.origin}/pipeline/${report}`);
  assert.match(await page.locator("main").innerText(), /Example Cover Fixture/, "use a fictional report fixture");
  const open = page.getByRole("button", { name: "Draft cover letter", exact: true });
  await open.click();
  const form = page.getByRole("form", { name: "Cover letter draft", exact: true });
  const instructions = form.getByRole("textbox", { name: "Additional instructions (optional)", exact: true });
  assert.equal(await form.locator("textarea").count(), 1);
  assert.equal(await form.getByRole("combobox").count(), 0);
  assert.equal(await instructions.getAttribute("required"), null);
  assert.equal(await instructions.getAttribute("maxlength"), "3000");
  const blankRequest = page.waitForRequest(request => new URL(request.url()).pathname === "/api/run");
  await form.getByRole("button", { name: "Draft letter", exact: true }).click();
  const blankBody = (await blankRequest).postDataJSON();
  await page.getByRole("link", { name: "Drafting cover letter…", exact: true }).waitFor();
  assert.deepEqual(blankBody.brief, { instructions: "" });
  releaseFirst();
  await page.getByRole("alert").filter({ hasText: "Fixture draft failure" }).waitFor();
  await open.click();
  const custom = "Focus on platform leadership.\nKeep the tone direct.";
  await instructions.fill(`  ${custom}  `);
  await form.getByRole("button", { name: "Draft letter", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Fixture weak draft" }).waitFor();
  assert.deepEqual(requests[1].brief, { instructions: custom });
  await open.click();
  assert.equal(await instructions.inputValue(), custom);
  await form.getByRole("button", { name: "Draft letter", exact: true }).click();
  await page.getByRole("link", { name: "View cover letter draft", exact: true }).waitFor();
  await page.getByRole("button", { name: "Draft the cover letter again", exact: true }).click();
  assert.equal(await instructions.inputValue(), custom);
  assert.deepEqual(requests[2].brief, { instructions: custom });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.equal(await instructions.isVisible(), true);
  assert.equal(requests.length, 3);
  assert.deepEqual(errors, []);
});
