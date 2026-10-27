import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import "../helpers/web-ts-alias-loader.mjs";
const { GET, POST } = await import("../../src/app/api/ai-settings/route.ts");
const { resolveCliOrFallback, detectClis } = await import("../../src/lib/clis.ts");

test("AI config round-trips, validates requests, and preserves invalid saved files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-ai-api-"));
  const previous = process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CAREER_OPS_ROOT;
    else process.env.CAREER_OPS_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const post = (body) => POST(new Request("http://localhost:3000/api/ai-settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const initial = await GET();
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("Cache-Control"), "no-store");
  assert.deepEqual((await initial.json()).settings, { version: 1, cliId: "", models: {} });
  assert.deepEqual(fs.readdirSync(root), [], "viewing settings creates no user file");

  const installed = detectClis().filter((cli) => cli.installed);
  const selected = installed[0]?.id ?? "";
  const settings = { version: 1, cliId: selected, models: { claude: { provider: "", model: "sonnet" }, opencode: { provider: "openrouter", model: "anthropic/claude-sonnet" } } };
  let response = await post(settings);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).settings, settings);
  assert.deepEqual((await (await GET()).json()).settings, settings);
  if (selected) {
    assert.equal(resolveCliOrFallback("obsolete-browser-value").spec.id, selected, "saved tool governs new runs even with stale browser selection");
  }
  for (const body of [null, [], { ...settings, models: { claude: { provider: "", model: "--dangerously-skip-permissions" } } }, { ...settings, apiKey: "not-a-key" }, { ...settings, cliId: "unknown" }]) {
    response = await post(body);
    assert.equal(response.status, 400);
  }
  const file = path.join(root, "data", "ai-settings.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), settings);
  fs.writeFileSync(file, "{broken");
  assert.equal((await GET()).status, 409);
  assert.equal((await post(settings)).status, 409);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});
