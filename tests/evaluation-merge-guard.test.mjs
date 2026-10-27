import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

function fixture(t, status = 'Needs review') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaluation-merge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['data', 'reports', 'batch/tracker-additions']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const url = 'https://example.test/jobs/42';
  const tracker = path.join(root, 'data/applications.md');
  fs.writeFileSync(tracker, `# Applications\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |\n|---|---|---|---|---|---|---|---|---|---|\n| 7 | 2026-10-24 | Acme | Manager | N/A | ${status} | ❌ | - | historical note | ${url} |\n`);
  const report = path.join(root, 'reports/042-acme-2026-10-26.md');
  fs.writeFileSync(path.join(root, 'batch/tracker-additions/042-acme.tsv'), `num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\turl\n042\t2026-10-26\tAcme\tManager\tEvaluated\t4.2/5\t❌\t[042](reports/042-acme-2026-10-26.md)\tnew evaluation\t${url}\n`);
  const run = () => spawnSync(process.execPath, [new URL('../merge-tracker.mjs', import.meta.url).pathname], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_TRACKER: tracker, CAREER_OPS_ADDITIONS: path.join(root, 'batch/tracker-additions'), CAREER_OPS_BATCH_STATE: path.join(root, 'batch/batch-state.tsv') },
  });
  return { root, tracker, report, run, url };
}

test('a confirmation request cannot merge as Evaluated or resolve Needs review', t => {
  const f = fixture(t);
  fs.writeFileSync(f.report, `**URL:** ${f.url}\n# Evaluation: Acme — Manager\n**Score:** 4.2/5\nStopped before Block A. Which agency did this posting come through?`);
  const result = f.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /cannot be merged as Evaluated/);
  const tracker = fs.readFileSync(f.tracker, 'utf8');
  assert.match(tracker, /Needs review/);
  assert.doesNotMatch(tracker, /4.2\/5/);
  assert.equal(fs.existsSync(path.join(f.root, 'batch/tracker-additions/042-acme.tsv')), true);
});

test('a finished same-posting evaluation resolves Needs review through canonical status writer', t => {
  const f = fixture(t);
  fs.writeFileSync(f.report, `# Evaluation: Acme — Manager\n**URL:** ${f.url}\n**Score:** 4.2/5\n\n${'ABCDEFG'.split('').map(l => `## ${l}) Evaluation\nEvidence.`).join('\n\n')}`);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(f.tracker, 'utf8'), /\| 7 \|[^\n]*\| Evaluated \|/);
  assert.match(fs.readFileSync(path.join(f.root, 'data/status-log.tsv'), 'utf8'), /Needs review\tEvaluated\tset-status/);
});

test('a finished re-evaluation preserves an Applied status', t => {
  const f = fixture(t, 'Applied');
  fs.writeFileSync(f.report, `# Evaluation: Acme — Manager\n**URL:** ${f.url}\n**Score:** 4.2/5\n\n${'ABCDEFG'.split('').map(l => `## ${l}) Evaluation\nEvidence.`).join('\n\n')}`);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(f.tracker, 'utf8'), /\| Applied \|/);
});
