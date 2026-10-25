import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { preparePromptInput, MAX_INLINE_PROMPT_BYTES } from "../../src/lib/cli-prompt-input.mjs";
import { spawnHeadlessCli } from "../../src/lib/spawn-cli.mjs";
import { CAPS } from "../../src/lib/worker-capabilities.mjs";

const large = `BEGIN\n${"Career facts and reference data é\n".repeat(20000)}END`;

test("large prompts move intact to documented stdin adapters", () => {
  const cases = [
    ["codex", ["exec", "--json", large], ["exec", "--json", "-"]],
    ["claude", ["-p", large, "--output-format", "stream-json"], ["-p", "--output-format", "stream-json"]],
    ["gemini", ["-p", large], ["-p", "Follow the complete request supplied on stdin."]],
    ["opencode", ["run", large], ["run"]],
    ["pi", ["--no-session", "-p", large], ["--no-session", "-p"]],
  ];
  for (const [cliId, args, expected] of cases) {
    const result = preparePromptInput(cliId, args, large);
    assert.deepEqual(result.args, expected, cliId);
    assert.equal(result.stdin, large, cliId);
    assert.ok(Buffer.byteLength(result.args.join(" ")) < MAX_INLINE_PROMPT_BYTES, cliId);
    assert.ok(args.includes(large), "caller argv remains unchanged");
  }
});

test("short and unspecified prompts retain their existing invocation", () => {
  const args = ["-p", "short prompt"];
  assert.deepEqual(preparePromptInput("grok", args, "short prompt"), { args, stdin: null });
  assert.deepEqual(preparePromptInput("codex", args), { args, stdin: null });
});

test("unsupported adapters and ambiguous arguments refuse without disclosing prompt contents", () => {
  assert.throws(() => preparePromptInput("grok", ["-p", large], large), /Choose Codex, Claude, Gemini, OpenCode or Pi/);
  assert.throws(() => preparePromptInput("codex", ["exec", "other"], large), /exactly once/);
  assert.throws(() => preparePromptInput("codex", ["exec", large, large], large), /exactly once/);
});

test("the real shared spawner delivers a large full Context through stdin without E2BIG", async () => {
  const script = `const crypto=require('node:crypto'); const h=crypto.createHash('sha256'); let bytes=0; process.stdin.on('data',c=>{h.update(c);bytes+=c.length}); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({hash:h.digest('hex'),bytes,args:process.argv.slice(1)})));`;
  const child = spawnHeadlessCli(process.execPath, ["-e", script, "--", "exec", large], { env: process.env }, { cliId: "codex", capabilities: CAPS.localReadOnly }, { prompt: large });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0);
  const result = JSON.parse(output);
  assert.equal(result.hash, createHash("sha256").update(large).digest("hex"));
  assert.equal(result.bytes, Buffer.byteLength(large));
  assert.ok(result.args.some((arg) => arg.includes("read-only")), "permission fence retained");
  assert.equal(result.args.at(-1), "-");
  assert.ok(!result.args.includes(large));
});

test("a CLI closing large prompt input early reports an error instead of accepting partial Context", async () => {
  const child = spawnHeadlessCli(process.execPath, ["-e", "process.exit(0)", "--", "exec", large], {}, { cliId: "codex", capabilities: CAPS.localReadOnly }, { prompt: large });
  const errors = [];
  child.on("error", (error) => errors.push(error));
  await new Promise((resolve) => child.once("close", resolve));
  assert.ok(errors.some((error) => /complete Context/.test(error.message)));
});
