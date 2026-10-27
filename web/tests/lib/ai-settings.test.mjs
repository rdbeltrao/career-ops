import { test } from "node:test";
import assert from "node:assert/strict";
import { AI_CLI_IDS, EMPTY_AI_SETTINGS, aiOptionsFor, applyAiModelArgs, normalizeAiSettings } from "../../src/lib/ai-settings.mjs";

const settings = (models = {}, cliId = "claude") => ({ version: 1, cliId, models });

test("unset settings inherit CLI defaults without sharing mutable state", () => {
  assert.deepEqual(normalizeAiSettings(undefined), EMPTY_AI_SETTINGS);
  const first = normalizeAiSettings(undefined);
  first.models.claude = { provider: "", model: "sonnet" };
  assert.deepEqual(normalizeAiSettings(undefined).models, {});
  assert.ok(AI_CLI_IDS.includes("claude"));
  assert.ok(AI_CLI_IDS.includes("hermes"));
});

test("settings retain independent models for each tool", () => {
  const input = settings({ claude: { provider: "", model: "sonnet" }, opencode: { provider: "openrouter", model: "anthropic/claude-sonnet-5" } });
  assert.deepEqual(normalizeAiSettings(input), input);
  assert.notEqual(normalizeAiSettings(input).models, input.models);
});

test("malformed, unknown, incomplete and unsupported settings fail clearly", () => {
  for (const input of [null, [], {}, { version: 2, cliId: "claude", models: {} }, settings({}, "bad-cli"), { ...settings(), apiKey: "not-accepted" }, settings({ claude: {} }), settings({ claude: { provider: "anthropic", model: "sonnet" } }), settings({ pi: { provider: "", model: "test" } }), settings({ typo: { provider: "", model: "" } })]) {
    assert.throws(() => normalizeAiSettings(input), /AI settings/i);
  }
  assert.doesNotThrow(() => normalizeAiSettings(settings({ pi: { provider: "", model: "" } }, "pi")));
});

test("model and provider IDs cannot become argv flags or contain control characters", () => {
  for (const model of ["--help", "a b", "a\nb", "x\u0000y", "x".repeat(257), 42, null]) {
    assert.throws(() => normalizeAiSettings(settings({ claude: { provider: "", model } })), /AI settings/i);
  }
  for (const provider of ["--help", "a/b", "a b", "a\nb", "x".repeat(81), 42]) {
    assert.throws(() => normalizeAiSettings(settings({ opencode: { provider, model: "test" } })), /AI settings/i);
  }
  assert.doesNotThrow(() => normalizeAiSettings(settings({ claude: { provider: "", model: "sonnet[1m]" }, codex: { provider: "company-gateway", model: "my_model.v2:latest@main" } })));
});

test("OpenCode provider selection requires a model and qualifies nested model IDs", () => {
  assert.throws(() => normalizeAiSettings(settings({ opencode: { provider: "openrouter", model: "" } })), /model/i);
  assert.deepEqual(applyAiModelArgs("opencode", ["run", "prompt"], { provider: "openrouter", model: "anthropic/claude-sonnet-5" }), ["run", "--model", "openrouter/anthropic/claude-sonnet-5", "prompt"]);
  assert.deepEqual(applyAiModelArgs("opencode", ["run", "prompt"], { provider: "", model: "openai/gpt-6.1-sol" }), ["run", "--model", "openai/gpt-6.1-sol", "prompt"]);
});

test("native model overrides precede prompts and preserve tool fences", () => {
  const args = ["-p", "--model", "--allowedTools", "Read", "--disallowedTools", "Bash", "--strict-mcp-config"];
  const original = [...args];
  assert.deepEqual(applyAiModelArgs("claude", args, { provider: "", model: "sonnet" }), ["--model", "sonnet", ...args]);
  assert.deepEqual(args, original);
  assert.deepEqual(applyAiModelArgs("gemini", ["-p", "prompt"], { provider: "", model: "gemini-2.5-pro" }), ["--model", "gemini-2.5-pro", "-p", "prompt"]);
});

test("Codex provider/model overrides stay after exec and before prompt delimiters", () => {
  const args = ["exec", "--sandbox", "read-only", "--", "prompt"];
  assert.deepEqual(applyAiModelArgs("codex", args, { provider: "openai", model: "gpt-6.1-sol" }), ["exec", "--model", "gpt-6.1-sol", "-c", 'model_provider="openai"', "--sandbox", "read-only", "--", "prompt"]);
  assert.deepEqual(applyAiModelArgs("codex", ["exec", "prompt"], { provider: "ollama", model: "qwen:latest" }), ["exec", "--model", "qwen:latest", "--oss", "--local-provider", "ollama", "prompt"]);
  assert.deepEqual(applyAiModelArgs("codex", ["exec", "prompt"], { provider: "lmstudio", model: "local-model" }), ["exec", "--model", "local-model", "--oss", "--local-provider", "lmstudio", "prompt"]);
  assert.throws(() => applyAiModelArgs("codex", ["prompt"], { provider: "", model: "gpt-6.1-sol" }), /exec/);
});

test("explicit choice replaces old model flags but never prompt text or unrelated config", () => {
  assert.deepEqual(applyAiModelArgs("claude", ["-p", "--model", "--model", "fable", "--system-prompt", "--model"], { provider: "", model: "sonnet" }), ["--model", "sonnet", "-p", "--model", "--system-prompt", "--model"]);
  assert.deepEqual(applyAiModelArgs("codex", ["exec", "--model=old", "-c", 'model_provider="old"', "-c", 'model_reasoning_effort="high"', "--oss", "--local-provider", "ollama", "--", "--model"], { provider: "openai", model: "gpt-6.1-sol" }), ["exec", "--model", "gpt-6.1-sol", "-c", 'model_provider="openai"', "-c", 'model_reasoning_effort="high"', "--", "--model"]);
});

test("empty selection preserves existing CLI configuration and explicit flags", () => {
  const args = ["run", "--model", "existing/model", "prompt"];
  assert.deepEqual(applyAiModelArgs("opencode", args, { provider: "", model: "" }), args);
  assert.notEqual(applyAiModelArgs("opencode", args, { provider: "", model: "" }), args);
});

test("catalog differentiates provider support and offers default/custom model paths", () => {
  assert.equal(aiOptionsFor("claude").supportsModel, true);
  assert.equal(aiOptionsFor("claude").supportsProvider, false);
  assert.ok(aiOptionsFor("claude").models.some((m) => m.id === "sonnet"));
  assert.ok(aiOptionsFor("opencode").providers.some((p) => p.id === "openrouter"));
  assert.equal(aiOptionsFor("codex").supportsProvider, true);
  assert.equal(aiOptionsFor("pi").supportsModel, false);
});
