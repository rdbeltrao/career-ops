import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { discoverCodexModels } from "../../src/lib/codex-model-catalog.mjs";

function fakeServer(respond) {
  const calls = [];
  const messages = [];
  const signals = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, encoding, done) {
    for (const line of String(chunk).trim().split("\n")) {
      const message = JSON.parse(line);
      messages.push(message);
      queueMicrotask(() => respond?.(message, (value) => child.stdout.write(JSON.stringify(value) + "\n"), child));
    }
    done();
  } });
  child.kill = (signal) => { signals.push(signal); queueMicrotask(() => child.emit("close", 0)); return true; };
  return { child, messages, signals, calls, spawnFn: (...args) => { calls.push(args); return child; } };
}

const model = (id, extra = {}) => ({ model: id, displayName: id.toUpperCase(), hidden: false, isDefault: false, ...extra });

test("catalog queries the installed client and projects only visible models without inference", async () => {
  const server = fakeServer((message, send) => {
    if (message.id === 1) send({ id: 1, result: { userAgent: "fixture" } });
    if (message.id === 2) send({ id: 2, result: { data: [model("gpt-5.6-sol", { isDefault: true, internalInstructions: "private" }), model("hidden-model", { hidden: true }), model("gpt-5.6-sol"), model("--bad"), model("bad model")], nextCursor: null } });
  });
  const result = await discoverCodexModels({ binPath: "/fixture/codex", spawnFn: server.spawnFn });
  assert.deepEqual(result, { models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-SOL", isDefault: true }], warning: null });
  assert.deepEqual(server.calls[0].slice(0, 2), ["/fixture/codex", ["app-server", "--stdio"]]);
  assert.deepEqual(server.messages.map((message) => message.method), ["initialize", "initialized", "model/list"]);
  assert.equal(server.messages[2].params.includeHidden, false);
  assert.ok(server.signals.includes("SIGTERM"));
  assert.ok(!JSON.stringify(result).includes("gpt-6"));
  assert.ok(!JSON.stringify(result).includes("private"));
});

test("catalog follows pagination and keeps model/provider selection tied to the invoked client", async () => {
  const server = fakeServer((message, send) => {
    if (message.id === 1) send({ id: 1, result: {} });
    if (message.method === "model/list") send({ id: message.id, result: { data: [model(message.params.cursor ? "second" : "first")], nextCursor: message.params.cursor ? null : "page-two" } });
  });
  const result = await discoverCodexModels({ binPath: "/fixture/codex", provider: "openai", spawnFn: server.spawnFn });
  assert.deepEqual(result.models.map((entry) => entry.id), ["first", "second"]);
  assert.deepEqual(server.messages.filter((message) => message.method === "model/list").map((message) => message.params.cursor), [undefined, "page-two"]);
  assert.ok(server.calls[0][1].includes('model_provider="openai"'));
});

test("custom and local providers do not receive the native OpenAI model catalog", async () => {
  for (const provider of ["ollama", "lmstudio", "company-gateway"]) {
    let spawned = false;
    const result = await discoverCodexModels({ binPath: "/fixture/codex", provider, spawnFn: () => { spawned = true; } });
    assert.equal(spawned, false);
    assert.deepEqual(result.models, []);
    assert.match(result.warning, /custom model/i);
  }
});

test("protocol errors, invalid catalogs and empty catalogs produce safe warnings without raw data", async () => {
  for (const response of [{ error: { message: "secret upstream body" } }, { result: {} }, { result: { data: null } }, { result: { data: [] } }]) {
    const server = fakeServer((message, send) => {
      if (message.id === 1) send({ id: 1, result: {} });
      if (message.id === 2) send({ id: 2, ...response });
    });
    const result = await discoverCodexModels({ binPath: "/fixture/codex", spawnFn: server.spawnFn });
    assert.deepEqual(result.models, []);
    assert.match(result.warning, /CLI default|sign-in|model/i);
    assert.ok(!JSON.stringify(result).includes("secret upstream body"));
  }
});

test("a repeated cursor fails bounded discovery rather than returning a partial catalog", async () => {
  const server = fakeServer((message, send) => {
    if (message.id === 1) send({ id: 1, result: {} });
    if (message.method === "model/list") send({ id: message.id, result: { data: [model("fixture")], nextCursor: "same-page" } });
  });
  const result = await discoverCodexModels({ binPath: "/fixture/codex", spawnFn: server.spawnFn });
  assert.deepEqual(result.models, []);
  assert.ok(result.warning);
  assert.equal(server.messages.filter((message) => message.method === "model/list").length, 2);
});

test("discovery timeout, early exit and spawn failure never leak errors or leave the child running", async () => {
  const server = fakeServer();
  const result = await discoverCodexModels({ binPath: "/fixture/codex", spawnFn: server.spawnFn, timeoutMs: 5 });
  assert.deepEqual(result.models, []);
  assert.ok(result.warning);
  assert.ok(server.signals.includes("SIGTERM"));
  const early = fakeServer((message, send, child) => child.emit("close", 1));
  assert.ok((await discoverCodexModels({ binPath: "/fixture/codex", spawnFn: early.spawnFn })).warning);
  const failed = await discoverCodexModels({ binPath: "/fixture/codex", spawnFn: () => { throw new Error("secret profile details"); } });
  assert.deepEqual(failed.models, []);
  assert.ok(!failed.warning.includes("secret"));
});

test("oversized stdout is rejected and consecutive calls rediscover rather than sharing a cache", async () => {
  const oversized = fakeServer((message, send, child) => child.stdout.write("x".repeat(1024 * 1024 + 1)));
  assert.ok((await discoverCodexModels({ binPath: "/fixture/codex", spawnFn: oversized.spawnFn })).warning);
  for (const id of ["first-account", "second-account"]) {
    const server = fakeServer((message, send) => {
      if (message.id === 1) send({ id: 1, result: {} });
      if (message.id === 2) send({ id: 2, result: { data: [model(id)] } });
    });
    assert.equal((await discoverCodexModels({ binPath: "/fixture/codex", spawnFn: server.spawnFn })).models[0].id, id);
  }
});

test("a failed graceful stop still escalates and releases probe listeners after close", async () => {
  const server = fakeServer();
  server.child.kill = (signal) => {
    server.signals.push(signal);
    if (signal === "SIGTERM") throw new Error("fixture graceful-stop failure");
    queueMicrotask(() => server.child.emit("close", 0));
    return true;
  };
  await discoverCodexModels({ binPath: "/fixture/codex", spawnFn: server.spawnFn, timeoutMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.deepEqual(server.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(server.child.stdout.listenerCount("data"), 0);
  assert.equal(server.child.listenerCount("close"), 0);
});
