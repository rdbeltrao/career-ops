import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AiSettingsError, readAiSettings, readWorkerAiSettings, saveAiSettings } from "../../src/lib/ai-settings-store.mjs";

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "career-ai-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const choice = { version: 1, cliId: "claude", models: { claude: { provider: "", model: "sonnet" } } };
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test("missing settings inherit defaults and saving targets the user data layer", (t) => {
  const root = scratch(t);
  assert.deepEqual(readAiSettings(root), { version: 1, cliId: "", models: {} });
  let target;
  const saved = saveAiSettings(root, choice, (file, text) => { target = file; write(file, text); });
  assert.equal(target, path.join(root, "data", "ai-settings.json"));
  assert.deepEqual(saved, choice);
  assert.deepEqual(readAiSettings(root), choice);
});

test("corrupt settings block both runs and overwrites", (t) => {
  const root = scratch(t);
  const file = path.join(root, "data", "ai-settings.json");
  for (const invalid of ["{broken", "null", JSON.stringify({ version: 2, cliId: "claude", models: {} })]) {
    write(file, invalid);
    assert.throws(() => readAiSettings(root), (err) => err instanceof AiSettingsError && err.status === 409 && /ai-settings\.json/.test(err.message));
    assert.throws(() => saveAiSettings(root, choice, () => assert.fail("must not write")), AiSettingsError);
    assert.equal(fs.readFileSync(file, "utf8"), invalid);
  }
});

test("non-ENOENT read failures and failed writes propagate instead of returning defaults", (t) => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, "data", "ai-settings.json"), { recursive: true });
  assert.throws(() => readAiSettings(root), (err) => err instanceof AiSettingsError && err.status === 500);
  const other = scratch(t);
  assert.throws(() => saveAiSettings(other, choice, () => { throw new Error("disk unavailable"); }), /disk unavailable/);
});

test("invalid requests never write and carry a 400 validation status", (t) => {
  const root = scratch(t);
  assert.throws(() => saveAiSettings(root, {}, () => assert.fail("must not write")), (err) => err instanceof AiSettingsError && err.status === 400);
});

test("worker settings follow root/data-dir/marker precedence relative to code root", (t) => {
  const root = scratch(t);
  const code = path.join(root, "engine");
  fs.mkdirSync(path.join(code, "web"), { recursive: true });
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  write(path.join(first, "data", "ai-settings.json"), JSON.stringify(choice));
  const other = { ...choice, cliId: "codex" };
  write(path.join(second, "data", "ai-settings.json"), JSON.stringify(other));
  write(path.join(code, ".career-ops-data"), "../first\n");
  assert.deepEqual(readWorkerAiSettings({ cwd: path.join(code, "web"), env: {} }), choice);
  assert.deepEqual(readWorkerAiSettings({ cwd: path.join(code, "web"), env: { CAREER_OPS_DATA_DIR: "../second" } }), other);
  assert.deepEqual(readWorkerAiSettings({ cwd: path.join(code, "web"), env: { CAREER_OPS_ROOT: "../first", CAREER_OPS_DATA_DIR: "../second" } }), choice);
  assert.deepEqual(readWorkerAiSettings({ cwd: root, env: { CAREER_OPS_CODE_ROOT: "engine" } }), choice);
});
