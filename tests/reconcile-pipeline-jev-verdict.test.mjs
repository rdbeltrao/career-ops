// tests/reconcile-pipeline-jev-verdict.test.mjs — a pending row takes the Jev
// verdict the batch reached when it declined to evaluate it.
//
// jev-rank.mjs pre-screens a row when it lands; the batch runner pre-screens it
// again at evaluation time, with the full JD. When the second verdict is skip
// the batch records the row as skipped and never evaluates it, but the row kept
// its first verdict ("maybe"), so the inbox showed it as waiting for an
// evaluation that would never come.
//
// Run:  node --test tests/reconcile-pipeline-jev-verdict.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeSpawn } from './helpers/describe-spawn.mjs';
import { withJevSegment } from '../lib/pipeline-processed.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'reconcile-pipeline.mjs');

test('withJevSegment replaces an existing jev: segment and appends a missing one', () => {
  const base = '- [ ] https://x.test/1 | Acme | EM | Berlin | note: linkedin';
  assert.equal(withJevSegment(`${base} | jev: 23 maybe — a, b`, 'jev: 14 skip — c'), `${base} | jev: 14 skip — c`);
  assert.equal(withJevSegment(base, 'jev: 14 skip — c'), `${base} | jev: 14 skip — c`);
  assert.equal(withJevSegment(`${base} | jev: 14 skip — c`, 'jev: 14 skip — c'), `${base} | jev: 14 skip — c`);
});

test('reconcile writes the batch Jev skip onto the pending row, and only for skipped rows', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-jev-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }));
  for (const d of ['data', 'reports', 'batch']) mkdirSync(join(root, d), { recursive: true });
  const pipeline = join(root, 'data', 'pipeline.md');
  writeFileSync(pipeline, [
    '# Pipeline', '', '## Pending', '',
    '- [ ] https://www.linkedin.com/jobs/view/4446441768/ | Space Dinosaurs | Director of Engineering | Spain | jev: 23 maybe — seniority match',
    '- [ ] https://www.linkedin.com/jobs/view/4483526443/ | Finanz Informatik | Abteilungsleitung | Frankfurt',
    '- [ ] https://jobs.example.test/gamma | Gamma | Lead | jev: 50 maybe — product',
    '', '## Processed', '',
  ].join('\n'));
  writeFileSync(join(root, 'data', 'applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
  const state = join(root, 'batch', 'batch-state.tsv');
  writeFileSync(state, [
    'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries',
    '1133\thttps://www.linkedin.com/jobs/view/4446441768/\tskipped\t2026-10-26\t2026-10-26\t-\t-\tjev: 14 skip verdict-skip (seniority_match=above, location_ok=no, stack_fit=required_mismatch)\t0',
    '1131\thttps://www.linkedin.com/jobs/view/4483526443/\tskipped\t2026-10-26\t2026-10-26\t-\t-\tjev: 11 skip verdict-skip (location_ok=no, language_blocker=missing)\t0',
    '1140\thttps://jobs.example.test/gamma\tfailed\t2026-10-26\t2026-10-26\t-\t-\tworker crashed\t1',
    '',
  ].join('\n'));
  const env = { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_TRACKER: join(root, 'data', 'applications.md'), CAREER_OPS_ADDITIONS: join(root, 'batch', 'tracker-additions'), CAREER_OPS_BATCH_STATE: state };
  delete env.CAREER_OPS_DATA_DIR;
  delete env.CAREER_OPS_CODE_ROOT;
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--pipeline', pipeline, '--state', state, '--no-tracker', ...args], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });

  const before = readFileSync(pipeline, 'utf8');
  const dry = run('--dry-run');
  assert.equal(dry.status, 0, describeSpawn(dry, ''));
  assert.match(dry.stdout, /2 pending rows take the Jev verdict the batch reached/);
  assert.equal(readFileSync(pipeline, 'utf8'), before, 'a dry run writes nothing');

  const r = run();
  assert.equal(r.status, 0, describeSpawn(r, ''));
  const text = readFileSync(pipeline, 'utf8');
  assert.match(text, /^- \[ \] https:\/\/www\.linkedin\.com\/jobs\/view\/4446441768\/ \| Space Dinosaurs \| Director of Engineering \| Spain \| jev: 14 skip — seniority_match=above, location_ok=no, stack_fit=required_mismatch$/m, text);
  assert.match(text, /^- \[ \] https:\/\/www\.linkedin\.com\/jobs\/view\/4483526443\/ \| Finanz Informatik \| Abteilungsleitung \| Frankfurt \| jev: 11 skip — location_ok=no, language_blocker=missing$/m, text);
  assert.match(text, /^- \[ \] https:\/\/jobs\.example\.test\/gamma \| Gamma \| Lead \| jev: 50 maybe — product$/m, 'a failed row keeps its verdict');

  const again = run();
  assert.equal(again.status, 0, describeSpawn(again, ''));
  assert.equal(readFileSync(pipeline, 'utf8'), text, 'idempotent');
});
