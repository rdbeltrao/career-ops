// tests/merge-tracker-pipeline-row.test.mjs — merge-tracker.mjs moves the
// pipeline.md row of every addition it merges under Processed, so the
// interactive mode (which writes a TSV and merges) and every other path that
// merges never leave an evaluated posting in the web INBOX.
//
// Run:  node --test tests/merge-tracker-pipeline-row.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MERGE = join(ROOT, 'merge-tracker.mjs');
const HEADER = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |';
const SEP = '|---|---|---|---|---|---|---|---|---|---|';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'merge-pipeline-row-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 10 }));
  for (const d of ['data', 'reports', 'batch/tracker-additions']) mkdirSync(join(base, d), { recursive: true });
  const tracker = join(base, 'data', 'applications.md');
  writeFileSync(tracker, ['# Applications Tracker', '', HEADER, SEP, ''].join('\n'));
  writeFileSync(join(base, 'reports', '077-acme-2026-10-02.md'), '# Evaluation: Acme — Engineer\n\n**Score:** 4.2/5\n**URL:** https://jobs.example.test/77\n');
  writeFileSync(join(base, 'reports', '078-beta-2026-10-02.md'), '# Evaluation: Beta — Manager\n\n**Score:** 3.1/5\n**URL:** https://jobs.example.test/78\n');
  const pipeline = join(base, 'data', 'pipeline.md');
  writeFileSync(pipeline, '# Pipeline\n\n## Pending\n\n- [ ] http://jobs.example.test/77/ | Acme | Engineer\n- [ ] https://jobs.example.test/78?utm_medium=x | Beta | Manager\n- [ ] https://jobs.example.test/79 | Gamma | Lead\n\n## Processed\n\n');
  // One headed addition with a URL, one nine-column addition whose URL comes from its report.
  writeFileSync(join(base, 'batch', 'tracker-additions', '077-acme.tsv'),
    'num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\turl\n077\t2026-10-02\tAcme\tEngineer\tEvaluated\t4.2/5\t❌\t[077](reports/077-acme-2026-10-02.md)\t\thttps://jobs.example.test/77\n');
  writeFileSync(join(base, 'batch', 'tracker-additions', '078-beta.tsv'),
    '078\t2026-10-02\tBeta\tManager\tEvaluated\t3.1/5\t❌\t[078](reports/078-beta-2026-10-02.md)\t\n');
  const env = { ...process.env, CAREER_OPS_ROOT: base, CAREER_OPS_TRACKER: tracker, CAREER_OPS_ADDITIONS: join(base, 'batch', 'tracker-additions') };
  delete env.CAREER_OPS_DATA_DIR;
  delete env.CAREER_OPS_BATCH_STATE;
  delete env.CAREER_OPS_CODE_ROOT;
  const run = (...args) => execFileSync(process.execPath, [MERGE, ...args], { encoding: 'utf-8', env, cwd: base });
  return { base, pipeline, tracker, run };
}

test('a merge moves the merged postings under Processed and leaves the rest pending', (t) => {
  const f = fixture(t);
  const dry = f.run('--dry-run');
  assert.match(dry, /dry-run/);
  assert.doesNotMatch(readFileSync(f.pipeline, 'utf8'), /- \[x\]/, 'a dry merge moves nothing');
  const out = f.run();
  assert.match(out, /pipeline\.md: 2 row\(s\) moved to Processed/);
  const text = readFileSync(f.pipeline, 'utf8');
  assert.match(text, /^- \[x\] \[077\]\(\.\.\/reports\/077-acme-2026-10-02\.md\) \| http:\/\/jobs\.example\.test\/77\/ \| Acme \| Engineer \| 4\.2\/5 \| PDF ❌$/m);
  assert.match(text, /^- \[x\] \[078\]\(\.\.\/reports\/078-beta-2026-10-02\.md\) \| https:\/\/jobs\.example\.test\/78\?utm_medium=x \| Beta \| Manager \| 3\.1\/5 \| PDF ❌$/m);
  assert.match(text, /^- \[ \] https:\/\/jobs\.example\.test\/79 \| Gamma \| Lead$/m);
  assert.match(readFileSync(f.tracker, 'utf8'), /\| 77 \| 2026-10-02 \| Acme \|/);
  // A second merge with nothing to merge touches neither file.
  const again = f.run();
  assert.doesNotMatch(again, /moved to Processed/);
  assert.equal(readFileSync(f.pipeline, 'utf8'), text);
});
