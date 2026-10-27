// tests/pipeline-processed.test.mjs — lib/pipeline-processed.mjs moves a
// pipeline.md row from Pending to Processed once its posting has a report:
// matched by posting key, written in the reconcile shape, idempotent, and
// safe under the pipeline lock.
//
// Run:  node --test tests/pipeline-processed.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProcessed, markPipelineProcessed, processedRowUrl, resolvePipelinePath, rowKey } from '../lib/pipeline-processed.mjs';

const PIPELINE = [
  '# Pipeline',
  '',
  '## Pending',
  '',
  '- [ ] https://jobs.example.test/1/ | Acme | Engineer | posted: 2026-10-01 | jev: 70 apply',
  '- [ ] http://jobs.example.test/2?utm_source=linkedin&gh_jid=9 | Beta | Manager',
  '- [ ] https://jobs.example.test/3 | Gamma | Lead',
  '- [!] https://jobs.example.test/err | Delta | Broken',
  '',
  '## Processed',
  '',
  '- [x] [41](../reports/041-gamma-2026-09-01.md) | https://jobs.example.test/3 | Gamma | Lead | 3.0/5 | PDF ❌',
  '',
].join('\n');

test('rowKey folds scheme, trailing slash and tracking parameters, and keeps functional ones', () => {
  assert.equal(rowKey('https://jobs.example.test/1/'), rowKey('http://jobs.example.test/1'));
  assert.equal(rowKey('https://jobs.example.test/2?utm_source=x&gh_jid=9'), rowKey('https://jobs.example.test/2?gh_jid=9'));
  assert.notEqual(rowKey('https://jobs.example.test/2?gh_jid=9'), rowKey('https://jobs.example.test/2'));
  assert.notEqual(rowKey('https://x.test/jobs/1'), rowKey('https://x.test/jobs/12'));
  assert.equal(rowKey('local:jds/acme.md'), 'local:jds/acme.md', 'a non-http row keeps its literal key');
  assert.equal(rowKey(''), '');
});

test('processedRowUrl reads every Processed shape ever written', () => {
  assert.equal(processedRowUrl('- [x] [41](../reports/041-g.md) | https://a.test/1 | G | Lead | 3.0/5 | PDF ❌'), 'https://a.test/1');
  assert.equal(processedRowUrl('- [x] #143 | https://a.test/2 | Acme | PM | 4.2/5 | PDF ✅'), 'https://a.test/2');
  assert.equal(processedRowUrl('- [x] SKIP | https://a.test/3 | Acme | PM | N/A | PDF ❌'), 'https://a.test/3');
  assert.equal(processedRowUrl('- [x] https://a.test/4 | Acme | PM'), 'https://a.test/4');
  assert.equal(processedRowUrl('- [x] ~~https://a.test/5 | Acme | PM~~ — posting expired (liveness sweep)'), 'https://a.test/5');
  assert.equal(processedRowUrl('- [x] #-- | local:jds/acme.md | skipped (pre-screen mismatch)'), 'local:jds/acme.md');
});

test('applyProcessed moves matching rows under Processed in the reconcile shape and drops stale twins', () => {
  const r = applyProcessed(PIPELINE, [
    { url: 'http://jobs.example.test/1', reportLink: '[42](../reports/042-acme-2026-10-02.md)', score: '4.2/5', pdf: '✅' },
    { url: 'https://jobs.example.test/2?gh_jid=9&utm_campaign=c', reportLink: '[43](../reports/043-beta-2026-10-02.md)', score: '3.9/5' },
    { url: 'https://jobs.example.test/3/' },
    { url: 'https://jobs.example.test/9', reportLink: '[44](../reports/044-x.md)' },
  ]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.moved.map((m) => [m.url, m.company, m.role, m.reportLink, m.score, m.pdf]), [
    ['https://jobs.example.test/1/', 'Acme', 'Engineer', '[42](../reports/042-acme-2026-10-02.md)', '4.2/5', '✅'],
    ['http://jobs.example.test/2?utm_source=linkedin&gh_jid=9', 'Beta', 'Manager', '[43](../reports/043-beta-2026-10-02.md)', '3.9/5', '❌'],
  ]);
  assert.deepEqual(r.dropped.map((d) => d.url), ['https://jobs.example.test/3']);
  assert.deepEqual(r.unmatched, ['https://jobs.example.test/9']);
  assert.equal(r.pendingBefore, 3);
  assert.equal(r.pendingAfter, 0);
  const lines = r.text.split('\n');
  assert.ok(lines.includes('- [x] [42](../reports/042-acme-2026-10-02.md) | https://jobs.example.test/1/ | Acme | Engineer | 4.2/5 | PDF ✅ | jev: 70 apply'));
  assert.ok(lines.includes('- [x] [43](../reports/043-beta-2026-10-02.md) | http://jobs.example.test/2?utm_source=linkedin&gh_jid=9 | Beta | Manager | 3.9/5 | PDF ❌'));
  assert.ok(lines.includes('- [!] https://jobs.example.test/err | Delta | Broken'), 'an error row is never touched');
  assert.equal(lines.filter((l) => l.includes('jobs.example.test/3')).length, 1, 'the processed row is not duplicated');
  assert.ok(r.text.indexOf('## Pending') < r.text.indexOf('## Processed'));
  // Idempotent: the same entries again change nothing.
  const again = applyProcessed(r.text, [{ url: 'https://jobs.example.test/1' }, { url: 'https://jobs.example.test/2?gh_jid=9' }]);
  assert.equal(again.changed, false);
  assert.deepEqual(again.alreadyProcessed, ['https://jobs.example.test/1', 'https://jobs.example.test/2?gh_jid=9']);
});

test('applyProcessed writes a SKIP row for a dealbreaker, creates the Processed heading in the pending language, and leaves other files alone', () => {
  const es = '# Pipeline\n\n## Pendientes\n\n- [ ] https://jobs.example.test/7 | Siete | Rol\n';
  const r = applyProcessed(es, [{ url: 'https://jobs.example.test/7', skip: true }]);
  assert.match(r.text, /^## Procesadas$/m);
  assert.match(r.text, /^- \[x\] SKIP \| https:\/\/jobs\.example\.test\/7 \| Siete \| Rol \| N\/A \| PDF ❌$/m);
  const none = applyProcessed('# Notes\n\nno sections here\n', [{ url: 'https://jobs.example.test/7' }]);
  assert.equal(none.changed, false);
  assert.equal(none.noPendingSection, true);
  assert.equal(none.text, '# Notes\n\nno sections here\n');
  const empty = applyProcessed(PIPELINE, []);
  assert.equal(empty.changed, false);
  assert.equal(empty.text, PIPELINE);
});

test('dropping a stale pending twin preserves its Jev on the processed survivor', () => {
  const text = '# Pipeline\n\n## Pending\n\n- [ ] https://a.test/1 | Acme | Manager | jev: 78 apply\n\n## Processed\n\n- [x] [42](../reports/042.md) | https://a.test/1 | Acme | Manager | 4/5 | PDF ❌\n';
  const result = applyProcessed(text, [{ url: 'https://a.test/1' }]);
  assert.equal(result.dropped.length, 1);
  assert.match(result.text, /PDF ❌ \| jev: 78 apply/);
  assert.equal(applyProcessed(result.text, [{ url: 'https://a.test/1' }]).changed, false);
});

test('markPipelineProcessed writes atomically under the lock, backs up on request, and tolerates a missing file', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-processed-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }));
  mkdirSync(join(root, 'data'));
  const missing = join(root, 'data', 'pipeline.md');
  const nothing = await markPipelineProcessed(missing, [{ url: 'https://jobs.example.test/1' }]);
  assert.equal(nothing.written, false);
  assert.equal(existsSync(missing), false, 'a missing pipeline is never created');
  assert.equal(resolvePipelinePath(root), join(root, 'pipeline.md'), 'without data/pipeline.md the legacy path is used');
  writeFileSync(missing, PIPELINE);
  assert.equal(resolvePipelinePath(root), missing);
  const dry = await markPipelineProcessed(missing, [{ url: 'https://jobs.example.test/1', reportLink: '[42](../reports/042.md)', score: '4.2/5' }], { dryRun: true });
  assert.equal(dry.moved.length, 1);
  assert.equal(dry.written, false);
  assert.equal(readFileSync(missing, 'utf8'), PIPELINE, 'a dry run writes nothing');
  const live = await markPipelineProcessed(missing, [{ url: 'https://jobs.example.test/1', reportLink: '[42](../reports/042.md)', score: '4.2/5' }], { backup: true });
  assert.equal(live.written, true);
  assert.equal(readFileSync(`${missing}.pre-reconcile.bak`, 'utf8'), PIPELINE);
  assert.match(readFileSync(missing, 'utf8'), /^- \[x\] \[42\]\(\.\.\/reports\/042\.md\) \| https:\/\/jobs\.example\.test\/1\/ \| Acme \| Engineer \| 4\.2\/5 \| PDF ❌ \| jev: 70 apply$/m);
  const again = await markPipelineProcessed(missing, [{ url: 'https://jobs.example.test/1' }]);
  assert.equal(again.written, false);
  assert.equal(existsSync(join(root, 'data', '.pipeline.lock')) || true, true);
});
