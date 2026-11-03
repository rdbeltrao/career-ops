import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportJevReader } from '../../src/lib/report-jev-cache.mjs';
import { readReportJev } from '../../src/lib/core/evaluation-report.mjs';

test('unchanged reports parse once and edited complete text is read immediately', () => {
  let calls = 0;
  const read = createReportJevReader(text => { calls++; return readReportJev(text); });
  const report = '**URL:** https://example.test/1\n**Jev:** 4/5 (fit 80, apply)';
  assert.equal(read(report).jev.fit, 80);
  assert.equal(read(report).jev.fit, 80);
  assert.equal(calls, 1);
  assert.equal(read(report.replace('80', '60')).jev.fit, 60);
  assert.equal(calls, 2);
  assert.equal(read(report + '\n## Machine Summary\n```yaml\njev: null\n```').status, 'not-run');
});

test('a caller cannot mutate cached Jev evidence through a returned result', () => {
  const read = createReportJevReader();
  const report = '**Jev:** 4/5 (fit 80, apply)';
  const first = read(report);
  first.jev.fit = 1;
  first.status = 'invalid';
  const second = read(report);
  assert.equal(second.jev.fit, 80);
  assert.equal(second.status, 'rated');
  second.jev.fit = 2;
  assert.equal(read(report).jev.fit, 80);
});

test('least recently read entries are evicted by both text size and entry count', () => {
  const calls = [];
  const read = createReportJevReader(text => { calls.push(text); return { text }; }, { maxCharacters: 6, maxEntries: 2 });
  read('aa'); read('bbb'); read('aa'); read('cc');
  read('aa'); read('bbb');
  assert.deepEqual(calls, ['aa', 'bbb', 'cc', 'bbb']);
  read('dddddd'); read('aa');
  assert.deepEqual(calls.slice(-2), ['dddddd', 'aa']);
});

test('oversized reports bypass the cache without evicting normal evidence', () => {
  const calls = [];
  const read = createReportJevReader(text => { calls.push(text); return { text }; }, { maxCharacters: 3 });
  read('abc'); read('larger'); read('larger'); read('abc');
  assert.deepEqual(calls, ['abc', 'larger', 'larger']);
});
