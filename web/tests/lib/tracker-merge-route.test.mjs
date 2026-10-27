import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../helpers/web-ts-alias-loader.mjs";

const codeRoot = mkdtempSync(join(tmpdir(), "co-merge-route-code-"));
const dataRoot = mkdtempSync(join(tmpdir(), "co-merge-route-data-"));
const keys = ["CAREER_OPS_CODE_ROOT", "CAREER_OPS_ROOT", "CAREER_OPS_DATA_DIR", "CAREER_OPS_TRACKER"];
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const realExecFile = childProcess.execFile;
const launches = [];
let POST;
let registry;

function standIn(body = 'console.log(JSON.stringify({kept: "326", merged: ["181","83"], backup: "tracker.bak", changed: true}));') {
  writeFileSync(join(codeRoot, "merge-listings.mjs"), body);
}

before(async () => {
  process.env.CAREER_OPS_CODE_ROOT = codeRoot;
  process.env.CAREER_OPS_ROOT = dataRoot;
  process.env.CAREER_OPS_DATA_DIR = "";
  process.env.CAREER_OPS_TRACKER = "";
  childProcess.execFile = function recordingExecFile(file, args, options, callback) {
    launches.push({ file, args, options });
    return realExecFile.call(this, file, args, options, callback);
  };
  syncBuiltinESMExports();
  ({ POST } = await import("@/app/api/tracker/merge/route.ts"));
  registry = await import("@/lib/core/run-registry.ts");
});

after(() => {
  childProcess.execFile = realExecFile;
  syncBuiltinESMExports();
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(codeRoot, { recursive: true, force: true });
  rmSync(dataRoot, { recursive: true, force: true });
});

async function call(body = { keep: "326", nums: ["326", "181", "83"] }, raw = false) {
  launches.length = 0;
  const response = await POST(new Request("http://localhost/api/tracker/merge", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: raw ? body : JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json(), launches: [...launches] };
}

test("merge route validates the complete selection before launching a core writer", async () => {
  for (const body of [null, [], "x", {}, { keep: "1", nums: ["1"] }, { keep: "1", nums: ["1", "1"] },
    { keep: "3", nums: ["1", "2"] }, { keep: "1", nums: ["1", "2;touch bad"] },
    { keep: "1", nums: ["1", {}] }, { keep: "1", nums: ["1", 0] },
    { keep: "1", nums: ["1", Number.MAX_SAFE_INTEGER + 1] },
    { keep: "1", nums: ["1", "2"], dryRun: "false" },
    { keep: "1", nums: Array.from({ length: 101 }, (_, i) => String(i + 1)) }]) {
    const result = await call(body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.launches.length, 0);
  }
  assert.equal((await call("{", true)).status, 400);
});

test("merge route invokes the core under split code/data roots and relays its result", async () => {
  standIn();
  process.env.CAREER_OPS_TRACKER = "fixtures/custom.md";
  try {
    const result = await call();
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, kept: "326", merged: ["181", "83"], backup: "tracker.bak", changed: true });
    assert.equal(result.launches.length, 1);
    const launch = result.launches[0];
    assert.equal(launch.file, process.execPath);
    assert.deepEqual(launch.args, [join(codeRoot, "merge-listings.mjs"), "--keep", "326", "--nums", "326,181,83"]);
    assert.equal(launch.options.cwd, dataRoot);
    assert.equal(launch.options.windowsHide, true);
    assert.equal(launch.options.shell, undefined);
    assert.equal(launch.options.env.CAREER_OPS_TRACKER, join(codeRoot, "fixtures/custom.md"));
    assert.equal(launch.options.env.CAREER_OPS_ROOT, dataRoot);
    assert.ok(launch.options.timeout > 0 && launch.options.timeout <= 30_000);
    assert.ok(launch.options.maxBuffer > 0);
  } finally {
    process.env.CAREER_OPS_TRACKER = "";
  }
});

test("merge route passes dry-run only when explicitly true", async () => {
  standIn('console.log(JSON.stringify({kept:"326",merged:["181","83"],backup:null,changed:false}));');
  const result = await call({ keep: 326, nums: [326, 181, 83], dryRun: true });
  assert.equal(result.status, 200);
  assert.equal(result.launches[0].args.at(-1), "--dry-run");
  assert.equal(result.body.changed, false);
});

test("merge route refuses writes while evaluation owns the tracker", async () => {
  const token = registry.acquireTrackerWrite();
  try {
    const result = await call();
    assert.equal(result.status, 409);
    assert.equal(result.launches.length, 0);
  } finally {
    registry.releaseTrackerWrite(token);
  }
});

test("merge route rejects concurrent writes and releases its guard after completion", async () => {
  standIn('setTimeout(() => console.log(JSON.stringify({kept:"326",merged:["181","83"],backup:"tracker.bak",changed:true})), 80);');
  const first = call();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await call()).status, 409);
  assert.equal((await first).status, 200);
  standIn();
  assert.equal((await call()).status, 200);
});

test("merge route reports core failures and never accepts invalid success output", async () => {
  for (const script of [
    'console.error("Different employer requisitions cannot be merged.");process.exit(1);',
    'process.exit(1);',
    'console.log("not JSON");',
    'console.log("{}");',
    'console.log(JSON.stringify({kept:"999",merged:["181","83"],backup:"tracker.bak",changed:true}));',
  ]) {
    standIn(script);
    const result = await call();
    assert.ok(result.status >= 400);
    assert.ok(result.body.error);
    assert.equal(result.body.ok, undefined);
  }
  standIn('console.error("Tracker is locked by another process");process.exit(1);');
  assert.equal((await call()).status, 409);
});
