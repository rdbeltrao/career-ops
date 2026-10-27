// tests/persist-evaluation-pipeline.test.mjs — the persist CLI moves the
// posting's pipeline.md row under Processed the moment the report is written,
// matched by posting key, and a pipeline problem never fails the persist.
//
// Run:  node --test tests/persist-evaluation-pipeline.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'persist-evaluation-report.mjs');

const payload = (url) => JSON.stringify({
  markdown: `# Evaluation: Acme — Engineer

**Score:** 4.2/5
**Jev:** not run
**Scoring note:** no Jev gate

## Machine Summary
\`\`\`yaml
company: Acme
role: Engineer
score: 4.2
final_decision: Apply
jev: null
\`\`\`

${['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(letter => `## ${letter}) Evaluation\nEvidence.`).join('\n\n')}
`,
  num: '042', today: '2026-10-02', company: 'Acme', role: 'Engineer', score: '4.2/5',
  via: null, url, notes: '', reportFile: '042-acme-2026-10-02.md',
});

function fixture(t, pipelineText) {
  const root = mkdtempSync(join(tmpdir(), 'persist-pipeline-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }));
  mkdirSync(join(root, 'data'));
  if (pipelineText != null) writeFileSync(join(root, 'data', 'pipeline.md'), pipelineText);
  const run = (input) => spawnSync(process.execPath, [SCRIPT], { cwd: root, input, encoding: 'utf8', timeout: 30_000 });
  return { root, run };
}

test('the posting row moves under Processed with the report link and score, keyed through a tracking parameter', (t) => {
  const f = fixture(t, '# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.test/42/?utm_source=li | Acme | Engineer | posted: 2026-10-01\n- [ ] https://jobs.example.test/43 | Beta | Manager\n');
  const r = f.run(payload('https://jobs.example.test/42'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true, pipeline: { moved: 1, dropped: 0 } });
  const text = readFileSync(join(f.root, 'data', 'pipeline.md'), 'utf8');
  assert.match(text, /^- \[x\] \[042\]\(\.\.\/reports\/042-acme-2026-10-02\.md\) \| https:\/\/jobs\.example\.test\/42\/\?utm_source=li \| Acme \| Engineer \| 4\.2\/5 \| PDF ❌$/m);
  assert.match(text, /^- \[ \] https:\/\/jobs\.example\.test\/43 \| Beta \| Manager$/m);
  assert.match(text, /^## Processed$/m);
  assert.ok(readFileSync(join(f.root, 'reports', '042-acme-2026-10-02.md'), 'utf8').startsWith('# Evaluation'));
});

test('no pipeline file, or no URL in the payload, is a plain ok with no pipeline field', (t) => {
  const noPipeline = fixture(t, null);
  const r1 = noPipeline.run(payload('https://jobs.example.test/42'));
  assert.equal(r1.status, 0, r1.stderr);
  assert.deepEqual(JSON.parse(r1.stdout), { ok: true });
  const noUrl = fixture(t, '# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.test/42 | Acme | Engineer\n');
  const r2 = noUrl.run(payload(''));
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(JSON.parse(r2.stdout), { ok: true });
  assert.match(readFileSync(join(noUrl.root, 'data', 'pipeline.md'), 'utf8'), /^- \[ \] https:\/\/jobs\.example\.test\/42/m, 'without a URL nothing moves');
});
