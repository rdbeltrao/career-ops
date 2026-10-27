import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { planEvaluationRepairs } from '../repair-evaluations.mjs';

const url = 'https://example.test/jobs/1';
const gate = `**URL:** ${url}\n\nStopped before Block A.\nJev pre-screen: 2.5/5 (fit 37, maybe).\nWhich agency did this posting come through?\n`;
const row = { num: 1, company: 'Acme', role: 'Manager', status: 'Evaluated', report: '[8](../reports/008-acme.md)', url };

test('repair distinguishes report and tracker numbers; preserves downstream states and unknown quantities', () => {
  const plan = planEvaluationRepairs([row, { ...row, num: 2, status: 'Applied' }], () => ({ file: '/reports/008-acme.md', text: gate }));
  assert.equal(plan.statuses.length, 1);
  assert.equal(plan.statuses[0].num, 1);
  assert.equal(plan.statuses[0].to, 'Needs review');
  assert.equal(plan.reports.length, 1);
  assert.match(plan.reports[0].after, /\*\*Jev:\*\* 2.5\/5 \(fit 37, maybe\)/);
});

test('repair refuses another posting even when its report number matches a tracker number', () => {
  const plan = planEvaluationRepairs([row], () => ({ file: '/reports/001-wrong.md', text: gate.replace(url, 'https://example.test/jobs/2') }));
  assert.equal(plan.reports.length, 0);
  assert.equal(plan.statuses.length, 0);
  assert.match(plan.gaps[0].reason, /another posting/);
});

test('explicit not-run does not borrow a saved rating', () => {
  const markdown = `# Evaluation: Acme\n**URL:** ${url}\n## Machine Summary\n\`\`\`yaml\njev: null\n\`\`\`\n`;
  const cache = new Map([['example.test/jobs/1', { jev: { fit: 99, score: 5, verdict: 'apply' }, source: 'old' }]]);
  const plan = planEvaluationRepairs([{ ...row, status: 'Applied' }], () => ({ file: '/reports/current.md', text: markdown }), cache);
  assert.match(plan.reports[0].after, /\*\*Jev:\*\* not run/);
  assert.doesNotMatch(plan.reports[0].after, /99|source:.*old/);
});

test('live repair backs up evidence, uses canonical status ledger and is idempotent', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-evaluations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['data', 'reports']) fs.mkdirSync(path.join(root, dir));
  const tracker = path.join(root, 'data/applications.md');
  fs.writeFileSync(tracker, '# Applications\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | 2026-10-24 | Acme | Manager | 3/5 | Evaluated | ❌ | [8](../reports/008-acme.md) | history | '+url+' |\n');
  fs.writeFileSync(path.join(root, 'reports/008-acme.md'), gate);
  const script = new URL('../repair-evaluations.mjs', import.meta.url);
  const run = flag => spawnSync(process.execPath, [script.pathname, flag], { encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_TRACKER: tracker } });
  const dry = run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).statusCorrections, 1);
  assert.equal(fs.existsSync(path.join(root, 'output')), false);
  const result = run('--apply');
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.match(fs.readFileSync(tracker, 'utf8'), /Needs review/);
  assert.match(fs.readFileSync(path.join(root, 'data/status-log.tsv'), 'utf8'), /Evaluated\tNeeds review\tset-status/);
  assert.equal(fs.readFileSync(path.join(receipt.backup, 'reports/008-acme.md'), 'utf8'), gate);
  const again = run('--dry-run');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).statusCorrections, 0);
  assert.equal(JSON.parse(again.stdout).reportHeaders, 0);
});
