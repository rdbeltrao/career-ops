import test from 'node:test';
import assert from 'node:assert/strict';
import { createScanDeadline, withScanSignal } from '../lib/scan-deadline.mjs';
import { boardScope, runHistorySeedScan } from '../scan-ats-full.mjs';

test('wall clock expiry aborts a scan even after a delayed timer', () => {
  let now = 1;
  const deadline = createScanDeadline(5000, { now: () => now });
  try { now = 5001; assert.equal(deadline.expired(), true); assert.equal(deadline.signal.aborted, true); }
  finally { deadline.close(); }
});

test('cancellation does not start queued operations or wait for a stuck board', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(withScanSignal(controller.signal, () => { throw new Error('must not start'); }), /stop/);
  const active = new AbortController();
  const pending = boardScope({ singleHost: true }, 'fixture', 30_000, () => new Promise(() => {}), active.signal);
  active.abort(new Error('deadline'));
  await assert.rejects(pending, /deadline/);
});

test('history-derived boards honor the same cancellation signal', async () => {
  const controller = new AbortController();
  const provider = { detect: () => true, fetch: async () => { controller.abort(new Error('stop')); return new Promise(() => {}); } };
  const result = await runHistorySeedScan([{ vendor: 'fixture', company: 'Fixture', careersUrl: 'https://fixture.test' }], new Map([['fixture', provider]]),
    { limit: Infinity, companyTimeoutMs: 30_000 }, { signal: controller.signal }, () => { throw new Error('must not process'); });
  assert.equal(result.errors, 0, 'a planned budget stop is not a network failure');
});
