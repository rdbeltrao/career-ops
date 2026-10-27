// tests/reconcile-pipeline-sources.test.mjs — reconcile-pipeline.mjs reads
// reports/ and the tracker, not only batch-state.tsv; matches rows by posting
// key; creates a tracker row for a report that has none through
// merge-tracker.mjs; and is idempotent, so it can run as a one-time backfill
// and after every scan.
//
// Run:  node --test tests/reconcile-pipeline-sources.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeSpawn } from './helpers/describe-spawn.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'reconcile-pipeline.mjs');

const REPORT = (company, role, url, score, date = '2026-10-02') => [
  `# Evaluation: ${company} — ${role}`,
  '',
  `**Date:** ${date}`,
  '**Archetype:** Engineering Manager',
  `**Score:** ${score}`,
  '**Decision:** Apply',
  `**URL:** ${url}`,
  '**PDF:** pending',
  '',
  '## Machine Summary',
  '',
  '```yaml',
  `company: "${company}"`,
  `role: "${role}"`,
  `score: ${score.replace('/5', '')}`,
  '```',
  '',
  '## Job Description (archived verbatim)',
  '',
  'Posted: not visible in source',
  'A posting.',
  '',
].join('\n');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-sources-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }));
  for (const d of ['data', 'reports', 'batch']) mkdirSync(join(root, d), { recursive: true });
  const pipeline = join(root, 'data', 'pipeline.md');
  writeFileSync(pipeline, [
    '# Pipeline', '', '## Pending', '',
    '- [ ] https://jobs.example.test/alpha/ | Alpha | Engineer | posted: 2026-10-01',          // report, no tracker row
    '- [ ] http://jobs.example.test/beta?utm_source=li | Beta | Manager',                     // tracker row with URL column + report
    '- [ ] https://jobs.example.test/gamma | Gamma | Lead',                                   // truly pending
    '- [ ] https://jobs.example.test/delta | Delta | Head',                                   // batch-state completed
    '', '## Processed', '',
  ].join('\n'));
  writeFileSync(join(root, 'reports', '101-alpha-2026-10-02.md'), REPORT('Alpha', 'Engineer', 'https://jobs.example.test/alpha', '4.1/5'));
  writeFileSync(join(root, 'reports', '102-beta-2026-10-02.md'), REPORT('Beta', 'Manager', 'https://jobs.example.test/beta', '3.4/5'));
  writeFileSync(join(root, 'reports', '103-delta-2026-10-03.md'), REPORT('Delta', 'Head', 'https://jobs.example.test/delta', '2.9/5', '2026-10-03'));
  writeFileSync(join(root, 'reports', '104-RESERVED.md'), '');
  writeFileSync(join(root, 'data', 'applications.md'), [
    '# Applications Tracker', '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|-----|',
    '| 102 | 2026-10-02 | Beta | Manager | 3.4/5 | Evaluated | ❌ | [102](../reports/102-beta-2026-10-02.md) | - | https://jobs.example.test/beta |',
    '| 103 | 2026-10-03 | Delta | Head | 2.9/5 | Evaluated | ❌ | [103](../reports/103-delta-2026-10-03.md) | - | https://jobs.example.test/delta |',
    '',
  ].join('\n'));
  const state = join(root, 'batch', 'batch-state.tsv');
  writeFileSync(state, 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n1\thttps://jobs.example.test/delta\tcompleted\t2026-10-03\t2026-10-03\t103\t2.9\t\t0\n');
  const additions = join(root, 'batch', 'tracker-additions');
  const env = { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_TRACKER: join(root, 'data', 'applications.md'), CAREER_OPS_ADDITIONS: additions, CAREER_OPS_BATCH_STATE: state };
  delete env.CAREER_OPS_DATA_DIR;
  delete env.CAREER_OPS_CODE_ROOT;
  const run = (...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, '--pipeline', pipeline, '--state', state, ...args], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
    assert.ifError(r.error);
    return r;
  };
  return { root, pipeline, additions, run };
}

test('dry run lists the moves and the missing tracker row, and writes nothing', (t) => {
  const f = fixture(t);
  const before = readFileSync(f.pipeline, 'utf8');
  const r = f.run('--dry-run');
  assert.equal(r.status, 0, describeSpawn(r, ''));
  assert.match(r.stdout, /3 processed entries moved/);
  assert.match(r.stdout, /#101 Alpha — Engineer \(4\.1\/5\)/);
  assert.match(r.stdout, /#102 Beta — Manager \(3\.4\/5\)/);
  assert.match(r.stdout, /#103 Delta — Head \(2\.9\/5\)/);
  assert.match(r.stdout, /Pendientes now: 1 entry \(was 4\)/);
  assert.match(r.stdout, /1 report\(s\) have no tracker row/);
  assert.match(r.stdout, /dry-run — no tracker additions written/);
  assert.equal(readFileSync(f.pipeline, 'utf8'), before);
  assert.equal(existsSync(f.additions), false, 'a dry run writes no addition');
});

test('live run moves rows from every source by posting key, gives the orphan report a tracker row, and is idempotent', (t) => {
  const f = fixture(t);
  const r = f.run();
  assert.equal(r.status, 0, describeSpawn(r, ''));
  const text = readFileSync(f.pipeline, 'utf8');
  assert.match(text, /^- \[x\] \[101\]\(\.\.\/reports\/101-alpha-2026-10-02\.md\) \| https:\/\/jobs\.example\.test\/alpha\/ \| Alpha \| Engineer \| 4\.1\/5 \| PDF ❌$/m, 'the report-only posting moved, keyed through its trailing slash');
  assert.match(text, /^- \[x\] \[102\]\(\.\.\/reports\/102-beta-2026-10-02\.md\) \| http:\/\/jobs\.example\.test\/beta\?utm_source=li \| Beta \| Manager \| 3\.4\/5 \| PDF ❌$/m, 'the tracker posting moved, keyed through scheme and tracking parameter');
  assert.match(text, /^- \[x\] \[103\]\(\.\.\/reports\/103-delta-2026-10-03\.md\) \| https:\/\/jobs\.example\.test\/delta \| Delta \| Head \| 2\.9\/5 \| PDF ❌$/m);
  assert.match(text, /^- \[ \] https:\/\/jobs\.example\.test\/gamma \| Gamma \| Lead$/m, 'a posting with no report stays pending');
  assert.equal((text.match(/^- \[x\]/gm) || []).length, 3);
  // The orphan report got a tracker row through merge-tracker.mjs.
  const tracker = readFileSync(join(f.root, 'data', 'applications.md'), 'utf8');
  assert.match(tracker, /\| 101 \| 2026-10-02 \| Alpha \| Engineer \| 4\.1\/5 \| Evaluated \| ❌ \| \[101\]\(\.\.\/reports\/101-alpha-2026-10-02\.md\) \|/);
  assert.match(tracker, /tracker row added by reconcile-pipeline\.mjs/);
  assert.equal((tracker.match(/^\| 10[123] \|/gm) || []).length, 3, 'one row per report, no duplicates');
  const merged = readdirSync(join(f.additions, 'merged'));
  assert.deepEqual(merged, ['rc-101-alpha.tsv']);
  assert.ok(existsSync(`${f.pipeline}.pre-reconcile.bak`));
  // Second run: nothing to do, no second addition.
  const again = f.run();
  assert.equal(again.status, 0, describeSpawn(again, ''));
  assert.match(again.stdout, /already in sync/);
  assert.doesNotMatch(again.stdout, /have no tracker row/);
  assert.equal(readFileSync(f.pipeline, 'utf8'), text);
  assert.equal(readFileSync(join(f.root, 'data', 'applications.md'), 'utf8'), tracker);
});

test('--no-tracker moves the rows and leaves the orphan report without a tracker row', (t) => {
  const f = fixture(t);
  const r = f.run('--no-tracker');
  assert.equal(r.status, 0, describeSpawn(r, ''));
  assert.match(r.stdout, /3 processed entries moved/);
  assert.match(r.stdout, /1 report\(s\) have no tracker row \(--no-tracker: left alone\)/);
  assert.equal(existsSync(f.additions), false);
  assert.doesNotMatch(readFileSync(join(f.root, 'data', 'applications.md'), 'utf8'), /Alpha/);
});

test('without batch-state.tsv the reports and the tracker still reconcile', (t) => {
  const f = fixture(t);
  rmSync(join(f.root, 'batch', 'batch-state.tsv'));
  const r = f.run('--no-tracker');
  assert.equal(r.status, 0, describeSpawn(r, ''));
  assert.match(r.stdout, /3 processed entries moved/);
  assert.match(r.stdout, /Sources: 0 batch-state, 3 reports, 0 tracker/);
});

test('a runner-shaped report (a "(pasted)" URL line first, a comma title, Machine Summary scalars) still reconciles and gets its tracker row', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-runner-shape-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }));
  for (const d of ['data', 'reports', 'batch']) mkdirSync(join(root, d), { recursive: true });
  const pipeline = join(root, 'data', 'pipeline.md');
  writeFileSync(pipeline, '# Pipeline\n\n## Pending\n\n- [ ] https://www.linkedin.com/jobs/view/4436712394/ | Deluxe | Director | jev: 20 maybe\n- [ ] https://www.linkedin.com/jobs/view/4480292808/ | Jobgether | EM\n\n## Processed\n\n');
  writeFileSync(join(root, 'reports', '025-company-2026-10-24.md'), [
    '**URL:** (pasted)', '**Legitimacy:** Proceed with Caution', '',
    '# Evaluation: Deluxe, Director, AI Engineering & Platform', '',
    '**Date:** not set in this chat (no file written)',
    '**URL:** https://www.linkedin.com/jobs/view/4436712394/',
    '**Score:** 2.6/5', '**Decision:** Skip', '**PDF:** not generated', '',
    '## Machine Summary', '', '```yaml', 'company: "Deluxe"', 'role: "Director, AI Engineering & Platform"', 'score: 2.6', '```', '',
  ].join('\n'));
  // A pause, not an evaluation: a header URL but no score, no title, no summary. Its row stays pending and it gets no tracker row.
  writeFileSync(join(root, 'reports', '062-jobgether-2026-10-24.md'), '**URL:** https://www.linkedin.com/jobs/view/4480292808/\n**Legitimacy:** unconfirmed\n\nI have paused before evaluating because this looks like an agency posting.\n');
  writeFileSync(join(root, 'data', 'applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
  const env = { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_TRACKER: join(root, 'data', 'applications.md'), CAREER_OPS_ADDITIONS: join(root, 'batch', 'tracker-additions'), CAREER_OPS_BATCH_STATE: join(root, 'batch', 'batch-state.tsv') };
  delete env.CAREER_OPS_DATA_DIR;
  delete env.CAREER_OPS_CODE_ROOT;
  const r = spawnSync(process.execPath, [SCRIPT, '--pipeline', pipeline], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, describeSpawn(r, ''));
  assert.match(r.stdout, /1 processed entry moved/);
  assert.match(r.stdout, /#25 Deluxe — Director, AI Engineering & Platform \(2\.6\/5\)/);
  assert.match(r.stdout, /1 report\(s\) have no tracker row/);
  assert.doesNotMatch(r.stderr + r.stdout, /062-jobgether/, 'a pause is not a report: no move, no tracker row, no warning');
  const text = readFileSync(pipeline, 'utf8');
  assert.match(text, /^- \[x\] \[25\]\(\.\.\/reports\/025-company-2026-10-24\.md\) \| https:\/\/www\.linkedin\.com\/jobs\/view\/4436712394\/ \| Deluxe \| Director \| 2\.6\/5 \| PDF ❌ \| jev: 20 maybe$/m);
  assert.match(text, /^- \[ \] https:\/\/www\.linkedin\.com\/jobs\/view\/4480292808\/ \| Jobgether \| EM$/m);
  const tracker = readFileSync(join(root, 'data', 'applications.md'), 'utf8');
  assert.match(tracker, /\| 25 \| 2026-10-24 \| Deluxe \| Director, AI Engineering & Platform \| 2\.6\/5 \| Evaluated \| ❌ \| \[025\]\(\.\.\/reports\/025-company-2026-10-24\.md\) \|/);
});
