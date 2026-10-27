import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { spawnHeadlessCli } from "../../src/lib/spawn-cli.mjs";
import { claudeCliArgs } from "../../src/lib/claude-invocation.mjs";
import { CAPS } from "../../src/lib/worker-capabilities.mjs";

function recordLaunch(settings, cliId, args, capabilities = CAPS.localReadOnly, input = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-model-launch-"));
  const realSpawn = childProcess.spawn;
  const calls = [];
  try {
    fs.mkdirSync(path.join(root, "data"));
    if (settings !== undefined) fs.writeFileSync(path.join(root, "data", "ai-settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
    childProcess.spawn = (command, argv, options) => {
      calls.push({ command, args: argv, options });
      return { stdin: { once() {}, end() {} } };
    };
    syncBuiltinESMExports();
    spawnHeadlessCli("/fake/ai", args, {
      cwd: root,
      env: { ...process.env, CAREER_OPS_ROOT: root },
    }, { cliId, capabilities }, input);
    return calls[0];
  } finally {
    childProcess.spawn = realSpawn;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("CV workers use the saved Claude model while keeping their tool fence", () => {
  const prompt = "Tailor this CV";
  const launch = recordLaunch({ version: 1, cliId: "claude", models: { claude: { provider: "", model: "sonnet" } } }, "claude", claudeCliArgs({ kind: "pdf", prompt, inlineInputs: true }));
  assert.equal(launch.args[launch.args.indexOf("--model") + 1], "sonnet");
  assert.ok(launch.args.includes("--strict-mcp-config"));
  assert.equal(launch.args[launch.args.indexOf("--tools") + 1], "");
  assert.ok(launch.args.includes(prompt));
});

test("models bind to the actual CLI rather than another tool's saved model", () => {
  const launch = recordLaunch({ version: 1, cliId: "claude", models: { claude: { provider: "", model: "sonnet" }, gemini: { provider: "", model: "gemini-test" } } }, "gemini", ["-p", "hello"]);
  assert.equal(launch.args[launch.args.indexOf("--model") + 1], "gemini-test");
  assert.ok(!launch.args.includes("sonnet"));
});

test("Codex provider/model selection retains its verified sandbox", () => {
  const launch = recordLaunch({ version: 1, cliId: "codex", models: { codex: { provider: "openai", model: "gpt-6.1-sol" } } }, "codex", ["exec", "hello"]);
  assert.equal(launch.args[launch.args.indexOf("--model") + 1], "gpt-6.1-sol");
  assert.ok(launch.args.includes('model_provider="openai"'));
  assert.ok(launch.args.includes("sandbox_mode=read-only"));
  assert.equal(launch.args[launch.args.indexOf("--ask-for-approval") + 1], "never");
});

test("missing settings preserve CLI defaults", () => {
  const launch = recordLaunch(undefined, "gemini", ["-p", "hello"]);
  assert.deepEqual(launch.args, ["-p", "hello"]);
});

test("malformed saved settings refuse the worker instead of using its global model", () => {
  assert.throws(() => recordLaunch("{broken", "gemini", ["-p", "hello"]), /AI settings|ai-settings/i);
});

test("large CV prompts still use stdin with the selected model", () => {
  const prompt = "CV facts. ".repeat(2000);
  const launch = recordLaunch({ version: 1, cliId: "claude", models: { claude: { provider: "", model: "sonnet" } } }, "claude", claudeCliArgs({ kind: "pdf", prompt, inlineInputs: true }), CAPS.localReadOnly, { prompt });
  assert.equal(launch.args[launch.args.indexOf("--model") + 1], "sonnet");
  assert.ok(!launch.args.includes(prompt));
  assert.equal(launch.options.stdio[0], "pipe");
});
