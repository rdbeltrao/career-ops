import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../helpers/web-ts-alias-loader.mjs';

const { applicationsWithJev, findReportFile } = await import('../../src/lib/career-ops.ts');

function fixture(t, count = 32) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-read-cost-'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.mkdirSync(path.join(root, 'reports'));
  const previous = process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CAREER_OPS_ROOT;
    else process.env.CAREER_OPS_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const tracker = path.join(root, 'data', 'applications.md');
  const rows = ['| # | Date | Company | Role | Score | Status | PDF | Report | Notes |', '|---|---|---|---|---|---|---|---|---|'];
  const report = (n, fit = 80) => `**URL:** https://example.test/jobs/${n}\n**Jev:** 4/5 (fit ${fit}, apply)\n`;
  for (let n = 1; n <= count; n++) {
    const file = `${1000 + n}-fixture.md`; // report number differs from application
    fs.writeFileSync(path.join(root, 'reports', file), report(n));
    rows.push(`| ${n} | 2026-11-01 | Fixture ${n} | Engineer | 4/5 | Evaluated | | [report](../reports/${file}) | |`);
  }
  fs.writeFileSync(tracker, rows.join('\n'));
  return { root, tracker, report };
}

test('joining Jev reads the tracker once regardless of application count', (t) => {
  const { tracker } = fixture(t);
  const canonicalTracker = fs.realpathSync(tracker);
  const original = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (String(file) === canonicalTracker) reads++;
    return original.call(this, file, ...args);
  });
  const applications = applicationsWithJev();
  assert.equal(applications.length, 32);
  assert.ok(applications.every(app => app.jev?.fit === 80 && app.jevStatus === 'rated'));
  assert.equal(reads, 1, 'full tracker must not be reparsed for each linked report');
});

test('subsequent joins see tracker and report edits without restarting', (t) => {
  const { root, tracker, report } = fixture(t, 1);
  assert.equal(applicationsWithJev()[0].jev.fit, 80);
  fs.writeFileSync(path.join(root, 'reports', '1001-fixture.md'), report(1, 60));
  fs.writeFileSync(tracker, fs.readFileSync(tracker, 'utf8').replace('Fixture 1', 'Updated 1'));
  const [updated] = applicationsWithJev();
  assert.equal(updated.company, 'Updated 1');
  assert.equal(updated.jev.fit, 60);
  assert.equal(findReportFile('001'), path.join(root, 'reports', '1001-fixture.md'));
});

test('joining Jev preserves filename fallback and rejects links outside the data root', (t) => {
  const { root, tracker, report } = fixture(t, 2);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsideReport = path.join(outside, 'private.md');
  fs.writeFileSync(outsideReport, report(2, 99));
  fs.writeFileSync(tracker, fs.readFileSync(tracker, 'utf8')
    .replace('../reports/1001-fixture.md', '../reports/absent.md')
    .replace('../reports/1002-fixture.md', outsideReport));
  fs.writeFileSync(path.join(root, 'reports', '001-fallback.md'), report(1, 70));
  fs.writeFileSync(path.join(root, 'reports', '001-RESERVED.md'), '');
  const rows = applicationsWithJev();
  assert.equal(rows[0].jev.fit, 70);
  assert.equal(rows[1].jev, null);
  assert.equal(rows[1].jevStatus, 'missing');
});
