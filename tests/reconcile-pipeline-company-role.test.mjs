// tests/reconcile-pipeline-company-role.test.mjs — a pending row whose company
// and role already have an evaluation report moves to Processed, even when the
// report was written for another URL.
//
// The same role often reaches the pipeline twice: once from a LinkedIn search
// and again from the employer's own Ashby or Greenhouse board. reconcile matched
// pending rows to reports by posting URL only, so the second copy stayed in the
// inbox after the first was evaluated.
//
// Run:  node --test tests/reconcile-pipeline-company-role.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeSpawn } from './helpers/describe-spawn.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'reconcile-pipeline.mjs');

// The shape report #200 has in the real data: a comma title, no Machine Summary.
const COMMA_REPORT = [
  '# Evaluation: Statista, Engineering Manager, Data Platform (m/f/d)',
  '',
  '**Date:** 2026-10-24',
  '**URL:** https://www.linkedin.com/jobs/view/4478464833/',
  '**Score:** 2.0/5',
  '',
].join('\n');

// A file under reports/ that stopped at a gate is not an evaluation.
const GATE_STOP = '**URL:** https://www.linkedin.com/jobs/view/4476314224/\n\nStopped at the agency gate.\n';

test('pending rows match an evaluated report by company and role, not only by URL', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-company-role-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }));
  for (const d of ['data', 'reports', 'batch']) mkdirSync(join(root, d), { recursive: true });
  const pipeline = join(root, 'data', 'pipeline.md');
  writeFileSync(pipeline, [
    '# Pipeline', '', '## Pending', '',
    '- [ ] https://jobs.ashbyhq.com/statista/d13572c5 | statista | Engineering Manager - Data Platform (m/f/d) | Berlin | jev: 21 maybe — x',
    '- [ ] https://jobs.ashbyhq.com/pragmatike/023fa634 | pragmatike | Engineering Manager (Distributed P2P Systems) | Remote',
    '- [ ] https://jobs.example.test/gamma | Gamma | Lead',
    '', '## Processed', '',
  ].join('\n'));
  writeFileSync(join(root, 'reports', '200-statista-2026-10-24.md'), COMMA_REPORT);
  writeFileSync(join(root, 'reports', '236-pragmatike-2026-10-24.md'), GATE_STOP);
  writeFileSync(join(root, 'data', 'applications.md'), [
    '# Applications Tracker', '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 200 | 2026-10-24 | Statista | (see report) | 2/5 | Evaluated | ❌ | [200](../reports/200-statista-2026-10-24.md) |  |',
    '',
  ].join('\n'));
  const state = join(root, 'batch', 'batch-state.tsv');
  const env = { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_TRACKER: join(root, 'data', 'applications.md'), CAREER_OPS_ADDITIONS: join(root, 'batch', 'tracker-additions'), CAREER_OPS_BATCH_STATE: state };
  delete env.CAREER_OPS_DATA_DIR;
  delete env.CAREER_OPS_CODE_ROOT;
  const run = () => spawnSync(process.execPath, [SCRIPT, '--pipeline', pipeline, '--state', state, '--no-tracker'], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });

  const r = run();
  assert.equal(r.status, 0, describeSpawn(r, ''));
  const text = readFileSync(pipeline, 'utf8');
  assert.match(text, /^- \[x\] \[200\]\(\.\.\/reports\/200-statista-2026-10-24\.md\) \| https:\/\/jobs\.ashbyhq\.com\/statista\/d13572c5 \| statista \| Engineering Manager - Data Platform \(m\/f\/d\) \| 2\.0\/5 \| PDF ❌$/m, text);
  assert.match(text, /^- \[ \] https:\/\/jobs\.ashbyhq\.com\/pragmatike\/023fa634 /m, 'a gate stop is not an evaluation, so its role stays pending');
  assert.match(text, /^- \[ \] https:\/\/jobs\.example\.test\/gamma \| Gamma \| Lead$/m);
  assert.match(r.stdout, /#200 statista — Engineering Manager - Data Platform \(m\/f\/d\) \(2\.0\/5\)/);

  const again = run();
  assert.equal(again.status, 0, describeSpawn(again, ''));
  assert.equal(readFileSync(pipeline, 'utf8'), text, 'idempotent');
});
