// Tests for jd-prefetch.mjs: the backend reads the posting from the ATS's public
// API before the evaluate worker starts.
//
// Why: the evaluate worker holds no Bash (#3629), so it cannot run fetch-jd.mjs
// itself, and WebFetch on a JavaScript-rendered board (Ashby, Workday, LinkedIn)
// returns an empty page shell. The worker then follows the mode's "posting
// appears closed" rule and emits no report, so every such evaluation failed with
// "The agent emitted no <<report-md>> envelope".
//
// Run:  node --test tests/lib/jd-prefetch.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prefetchJd, MIN_JD_CHARS } from "../../src/lib/jd-prefetch.mjs";

const JD = "Engineering Manager (Distributed P2P Systems)\n\n" + "We are looking for an Engineering Manager. ".repeat(20);

/** A fake spawn whose child prints `stdout` and exits with `code`. */
function fakeSpawn({ stdout = "", code = 0, hang = false } = {}) {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit("close", null));
    };
    if (!hang) {
      setImmediate(() => {
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        child.emit("close", code);
      });
    }
    return child;
  };
  return { spawnFn, calls };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jd-prefetch-"));
}

test("prefetchJd: writes the API's JD to a file and returns its path", async () => {
  const outDir = tmpDir();
  const { spawnFn, calls } = fakeSpawn({ stdout: JD });
  const result = await prefetchJd({
    spawnFn, execPath: "/usr/bin/node", codeRoot: "/checkout",
    url: "https://jobs.ashbyhq.com/acme/123", outDir,
  });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(result.file, "utf8"), JD.trim() + "\n");
  assert.ok(result.file.startsWith(outDir));
  // fetch-jd.mjs runs from the checkout, with the url as its only argument.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [path.join("/checkout", "fetch-jd.mjs"), "https://jobs.ashbyhq.com/acme/123"]);
  assert.equal(calls[0].opts.cwd, "/checkout");
});

test("prefetchJd: the same url always maps to the same file", async () => {
  const outDir = tmpDir();
  const url = "https://jobs.ashbyhq.com/acme/123";
  const a = await prefetchJd({ ...fakeSpawn({ stdout: JD }), execPath: "node", codeRoot: "/c", url, outDir });
  const b = await prefetchJd({ ...fakeSpawn({ stdout: JD }), execPath: "node", codeRoot: "/c", url, outDir });
  assert.equal(a.file, b.file);
});

test("prefetchJd: a miss (exit 1) leaves no file and reports not ok", async () => {
  const outDir = tmpDir();
  const result = await prefetchJd({
    ...fakeSpawn({ code: 1 }), execPath: "node", codeRoot: "/c",
    url: "https://example.com/careers/9", outDir,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(fs.readdirSync(outDir), []);
});

test("prefetchJd: text too short to be a JD is treated as a miss", async () => {
  const outDir = tmpDir();
  const result = await prefetchJd({
    ...fakeSpawn({ stdout: "Engineering Manager" }), execPath: "node", codeRoot: "/c",
    url: "https://jobs.ashbyhq.com/acme/123", outDir,
  });
  assert.ok("Engineering Manager".length < MIN_JD_CHARS);
  assert.equal(result.ok, false);
  assert.deepEqual(fs.readdirSync(outDir), []);
});

test("prefetchJd: input that is not an http(s) url never spawns", async () => {
  const { spawnFn, calls } = fakeSpawn({ stdout: JD });
  for (const url of ["018", "file:///etc/passwd", "--help", ""]) {
    const result = await prefetchJd({ spawnFn, execPath: "node", codeRoot: "/c", url, outDir: tmpDir() });
    assert.equal(result.ok, false, url);
  }
  assert.equal(calls.length, 0);
});

test("prefetchJd: a hung fetch is killed at the timeout and counts as a miss", async () => {
  const { spawnFn } = fakeSpawn({ hang: true });
  const result = await prefetchJd({
    spawnFn, execPath: "node", codeRoot: "/c",
    url: "https://jobs.ashbyhq.com/acme/123", outDir: tmpDir(), timeoutMs: 20,
  });
  assert.equal(result.ok, false);
});

test("prefetchJd: a spawn that throws counts as a miss, never an exception", async () => {
  const spawnFn = () => { throw new Error("ENOENT"); };
  const result = await prefetchJd({
    spawnFn, execPath: "node", codeRoot: "/c",
    url: "https://jobs.ashbyhq.com/acme/123", outDir: tmpDir(),
  });
  assert.equal(result.ok, false);
});
