import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const config = readFileSync(new URL("../../src/components/config-form.tsx", import.meta.url), "utf8");

test("Config loads saved AI settings before allowing a save", () => {
  assert.match(config, /fetch\("\/api\/ai-settings"/);
  assert.match(config, /disabled=\{[^}]*!settingsReady[^}]*\}/);
  assert.match(config, /role="alert"/);
});

test("Config sends provider and model settings to server before updating browser choice", () => {
  const save = config.slice(config.indexOf("async function save()"), config.indexOf("const installed"));
  assert.match(save, /method:\s*"POST"/);
  assert.match(save, /normalizeAiSettings\(\{[^}]*cliId,\s*models\s*\}/);
  const posted = save.indexOf('fetch("/api/ai-settings"');
  const succeeded = save.indexOf("if (!response.ok)");
  const persisted = save.indexOf("persistCliId(cliId)");
  assert.ok(posted !== -1 && succeeded > posted && persisted > succeeded);
  assert.match(save, /catch\s*\(/);
  assert.doesNotMatch(save, /apiKey/);
});

test("server selection takes precedence over stale browser selection", () => {
  const server = config.indexOf("keepIfInstalled(settings.cliId, list)");
  const browser = config.indexOf("keepIfInstalled(prev, list)");
  assert.ok(server !== -1 && browser > server);
});

test("Config retains model selections per tool and resets success after edits", () => {
  assert.match(config, /models\[cliId\]/);
  assert.match(config, /\[cliId\]:\s*selection/);
  assert.match(config, /setSaved\(false\)/);
  assert.match(config, /<AiModelFields/);
});

test("Config accurately explains provider data flow", () => {
  assert.doesNotMatch(config, /Your CV and data never leave your machine/);
  assert.match(config, /prompts.*selected provider/);
  assert.match(config, /new AI runs/);
});

test("appearance preferences remain saveable without an installed AI tool", () => {
  const save = config.slice(config.indexOf("async function save()"), config.indexOf("const installed"));
  assert.doesNotMatch(save, /if\s*\([^)]*!cliId[^)]*\)\s*return/, "An empty CLI choice must not block appearance preferences from saving");
  const button = config.slice(config.indexOf("onClick={save}"), config.indexOf("onClick={save}") + 150);
  assert.doesNotMatch(button, /disabled=\{[^}]*!cliId/, "The Save button must allow users with no installed AI tool");
  assert.match(save, /if\s*\(cliId\)\s*persistCliId\(cliId\)/, "Only nonempty tool choices are persisted through the CLI helper");
  assert.match(save, /localStorage\.setItem\(STORAGE_KEY, JSON\.stringify\(\{ mode, cliId, logos \}\)\)/);
});

test("model fields expose accessible defaults, custom models and custom providers", () => {
  const fields = readFileSync(new URL("../../src/components/ai-model-fields.tsx", import.meta.url), "utf8");
  assert.match(fields, /aiOptionsFor\(cliId\)/);
  assert.match(fields, /htmlFor="ai-provider"/);
  assert.match(fields, /htmlFor="ai-model"/);
  assert.match(fields, /Use CLI default/);
  assert.match(fields, /Custom model/);
  assert.match(fields, /Custom provider/);
  assert.match(fields, /role="alert"/);
});

test("all model and provider controls are disabled while a save is pending", () => {
  const fields = readFileSync(new URL("../../src/components/ai-model-fields.tsx", import.meta.url), "utf8");
  assert.match(fields, /<fieldset disabled=\{disabled\}/);
  assert.match(config, /<AiModelFields[\s\S]*?disabled=\{saving\}/);
});
