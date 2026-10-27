import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCliId } from "../../src/lib/saved-cli.ts";

test("new runs synchronize the server's tool selection over stale browser preferences", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const store = new Map([["career-ops:config", JSON.stringify({ mode: "cli", cliId: "claude", logos: false })]]);
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    clis: [{ id: "claude", installed: true }, { id: "codex", installed: true }],
    configured: "codex", remembered: "claude",
  }) });
  t.after(() => { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; });
  assert.equal(await resolveCliId(), "codex");
  assert.deepEqual(JSON.parse(store.get("career-ops:config")), { mode: "cli", cliId: "codex", logos: false });

  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    clis: [{ id: "claude", installed: false }, { id: "codex", installed: true }], configured: "claude",
  }) });
  assert.equal(await resolveCliId(), "codex", "an uninstalled configured tool does not replace an installed browser choice");
});
