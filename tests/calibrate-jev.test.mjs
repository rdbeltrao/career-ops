// tests/calibrate-jev.test.mjs — calibrate.mjs --jev reads the Jev block out
// of each report's Machine Summary and reports Jev score bands and verdicts
// next to the LLM score bands, with the same band and sample-floor rules.
//
// Read-only and advisory, like the rest of calibrate.mjs: without --jev the
// output is byte-for-byte what it was.
//
// Run: node --test tests/calibrate-jev.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeJevCalibration, loadTrackerJev, loadTrackerRows, readReportJev } from '../calibrate.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'calibrate.mjs');

function report({ company, role, score, jev }) {
  return [
    `# Evaluation — ${company} — ${role}`,
    '',
    `**Score:** ${score}/5`,
    jev ? `**Jev:** ${jev.score}/5 (fit ${jev.fit}, ${jev.verdict})` : '**Jev:** not run',
    '',
    '## Machine Summary',
    '',
    '```yaml',
    `company: "${company}"`,
    `role: "${role}"`,
    `score: ${score}`,
    'final_decision: "Apply"',
    ...(jev ? [
      'jev:',
      '  model: "typesafe/jev-1.13"',
      `  fit: ${jev.fit}`,
      `  score: ${jev.score}`,
      `  verdict: "${jev.verdict}"`,
      '  blocking: []',
      '  reasons:',
      '    seniority_match: "match"',
      '    location_ok: "yes"',
      '    language_blocker: "none"',
      '    team_type: "product"',
      '    stack_fit: "stack_agnostic"',
    ] : ['jev: null']),
    '```',
    '',
  ].join('\n');
}

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'calibrate-jev-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  mkdirSync(join(dataRoot, 'reports'), { recursive: true });
  writeFileSync(join(dataRoot, 'reports', '001-acme-engineering-lead.md'), report({ company: 'Acme', role: 'Engineering Lead', score: 4.5, jev: { fit: 79, score: 4.2, verdict: 'apply' } }));
  writeFileSync(join(dataRoot, 'reports', '002-globex-platform-lead.md'), report({ company: 'Globex', role: 'Platform Lead', score: 3.8, jev: null }));
  writeFileSync(join(dataRoot, 'reports', '004-initech-head.md'), report({ company: 'Initech', role: 'Head of Engineering', score: 4.1, jev: { fit: 30, score: 2.2, verdict: 'skip' } }));
  writeFileSync(join(dataRoot, 'data', 'applications.md'), [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-09-01 | Acme | Engineering Lead | 4.5/5 | Interview | ✅ | [1](../reports/001-acme-engineering-lead.md) | n |',
    '| 2 | 2026-09-02 | Globex | Platform Lead | 3.8/5 | Rejected | ✅ | [2](../reports/002-globex-platform-lead.md) | n |',
    '| 3 | 2026-09-03 | Hooli | Dead Link | 4.0/5 | Rejected | ❌ | [3](../reports/003-missing.md) | n |',
    '| 4 | 2026-09-04 | Initech | Head of Engineering | 4.1/5 | Rejected | ✅ | [4](../reports/004-initech-head.md) | n |',
    '| 5 | 2026-09-05 | Umbrella | In Flight | 4.4/5 | Applied | ✅ | [1](../reports/001-acme-engineering-lead.md) | n |',
    '',
  ].join('\n'));
  return dataRoot;
}

function run(args, dataRoot) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '' },
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  return r;
}

test('readReportJev reads the jev block out of the Machine Summary fence', () => {
  const withJev = readReportJev(report({ company: 'A', role: 'R', score: 4.5, jev: { fit: 79, score: 4.2, verdict: 'apply' } }));
  assert.deepEqual(withJev, { fit: 79, score: 4.2, verdict: 'apply', blocking: [] });
  assert.equal(readReportJev(report({ company: 'A', role: 'R', score: 4.5, jev: null })), null);
  assert.equal(readReportJev('# No machine summary here\n'), null);
  assert.equal(readReportJev('## Machine Summary\n\n```yaml\njev: [unclosed\n```\n'), null);
  const loose = readReportJev('## Machine Summary\n\n```yaml\njev:\n  score: "4.2"\n  verdict: "Apply"\n  blocking:\n    - "location_ok=no"\n```\n');
  assert.deepEqual(loose, { fit: null, score: 4.2, verdict: 'apply', blocking: ['location_ok=no'] });
});

test('loadTrackerRows now carries the report cell and loadTrackerJev resolves report links', () => {
  const dataRoot = fixture();
  const rows = loadTrackerRows(join(dataRoot, 'data', 'applications.md'));
  assert.equal(rows[0].report, '[1](../reports/001-acme-engineering-lead.md)');
  const jev = loadTrackerJev(join(dataRoot, 'data', 'applications.md'), dataRoot);
  assert.equal(jev.get(1).score, 4.2);
  assert.equal(jev.get(1).verdict, 'apply');
  assert.equal(jev.get(2), null, 'a report with jev: null reads as not run');
  assert.equal(jev.has(3), false, 'a dead link has no entry');
  assert.equal(jev.get(4).verdict, 'skip');
});

test('computeJevCalibration bands the Jev score with the same floor rules', () => {
  const mk = (num, status) => ({ num, company: `C${num}`, score: 4, status });
  const rows = [mk(1, 'Interview'), mk(2, 'Rejected'), mk(3, 'Rejected'), mk(4, 'Rejected'), mk(5, 'Applied')];
  const jevByNum = new Map([[1, { fit: 79, score: 4.2, verdict: 'apply', blocking: [] }], [2, null], [4, { fit: 30, score: 2.2, verdict: 'skip', blocking: [] }]]);
  const r = computeJevCalibration(rows, new Map(), jevByNum, { minBandN: 1 });
  assert.equal(r.resolved, 4);
  assert.equal(r.scored, 2);
  assert.equal(r.notRun, 1);
  assert.equal(r.noReport, 1);
  const band = r.bands.find((b) => b.band === '4.0-4.4');
  assert.deepEqual(band, { band: '4.0-4.4', n: 1, interviews: 1, offers: 0, interviewRate: 100, offerRate: 0 });
  assert.equal(r.bands.find((b) => b.band === '<3.5').n, 1);
  assert.deepEqual(r.verdicts.map((v) => [v.verdict, v.n, v.interviews]), [['apply', 1, 1], ['maybe', 0, 0], ['skip', 1, 0]]);
  const floored = computeJevCalibration(rows, new Map(), jevByNum, { minBandN: 5 });
  assert.ok(floored.bands.every((b) => b.interviewRate === null));
  assert.ok(floored.verdicts.every((v) => v.interviewRate === null));
});

test('--json --jev lists one row in band 4.0-4.4 and one not_run', () => {
  const dataRoot = fixture();
  const r = run(['--json', '--jev', '--min-band-n', '1'], dataRoot);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.jev, 'jev block present');
  const band = out.jev.bands.find((b) => b.band === '4.0-4.4');
  assert.equal(band.n, 1);
  assert.equal(band.interviews, 1);
  assert.equal(out.jev.notRun, 1);
  assert.equal(out.jev.noReport, 1);
  assert.equal(out.jev.scored, 2);
  assert.equal(out.jev.verdicts.find((v) => v.verdict === 'apply').n, 1);
  assert.equal(out.jev.verdicts.find((v) => v.verdict === 'skip').n, 1);
  // The existing calibration is untouched by the flag.
  assert.equal(out.resolved, 4);
  assert.equal(out.inFlight, 1);
});

test('without --jev the output has no jev block and the human report gains the tables only with it', () => {
  const dataRoot = fixture();
  const plain = run(['--json'], dataRoot);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal('jev' in JSON.parse(plain.stdout), false);
  const human = run(['--jev'], dataRoot);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Jev score bands/);
  assert.match(human.stdout, /Jev verdicts/);
  assert.match(human.stdout, /not run: 1/);
  const humanPlain = run([], dataRoot);
  assert.doesNotMatch(humanPlain.stdout, /Jev score bands/);
  assert.match(run(['--help'], dataRoot).stdout, /--jev/);
});
