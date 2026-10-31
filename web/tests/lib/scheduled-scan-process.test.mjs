import test from "node:test";
import assert from "node:assert/strict";
import { runScheduledScanner } from "../../src/lib/scheduled-scan-process.mjs";

test("deadline allows a partial receipt to flush before returning", async () => {
  const result = await runScheduledScanner(process.execPath, ["-e", `
    process.on('SIGTERM', () => setTimeout(() => {
      process.stdout.write(JSON.stringify({saved:true,postingsKept:2}), () => process.exit(0));
    }, 30));
    setInterval(() => {}, 1000);
  `], { timeout: 500, graceMs: 500, maxBuffer: 1024 });
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).postingsKept, 2);
});

test("scanner that ignores SIGTERM is killed after its grace period", async () => {
  const startedAt = Date.now();
  const result = await runScheduledScanner(process.execPath, ["-e", `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `], { timeout: 500, graceMs: 100, maxBuffer: 1024 });
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(result.signal, "SIGKILL");
  assert.ok(Date.now() - startedAt < 3000);
});

test("missing executable and output overflow return failures", async () => {
  const missing = await runScheduledScanner("/no-such-scanner", [], { timeout: 500, maxBuffer: 1024 });
  assert.equal(missing.error.code, "ENOENT");
  const overflow = await runScheduledScanner(process.execPath, ["-e", "process.stdout.write('x'.repeat(2048)); setInterval(()=>{},1000)"], { timeout: 2000, graceMs: 100, maxBuffer: 1024 });
  assert.equal(overflow.error.code, "ENOBUFS");
});
