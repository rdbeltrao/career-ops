import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stampReportJev } from '../lib/report-jev-write.mjs';
import { machineSummary, readReportJev, prepareEvaluationReport } from '../lib/evaluation-report.mjs';
import { recordJevReceipt, finalizeReportJev } from '../finalize-report-jev.mjs';
import { SYSTEM_PATHS } from '../lib/update-manifest.mjs';

const url = 'https://example.test/jobs/1';
const result = { model: 'typesafe/jev-test', fit: 56, score: 3.2, verdict: 'maybe', blocking: ['location_ok=no'], reasons: { location_ok: 'no', team_type: 'product' } };
const receipt = { url, result };
const report = (jev = 'null') => `# Evaluation: Acme — Manager
**Score:** 3.4/5
**URL:** ${url}
**Jev:** not run
**Scoring note:** no Jev gate, no web research

## Machine Summary
\`\`\`yaml
company: Acme
role: Manager
score: 3.4
final_decision: Consider
jev: ${jev}
extra:
  untouched: value
\`\`\`

## Job Description (archived verbatim)
**Jev:** not run
**Scoring note:** no Jev gate
not run: FAKE_JD_REASON

${[...'ABCDEFG'].map(l => `## ${l}) Evaluation\nEvidence for ${l}.`).join('\n\n')}
`;

test('trusted scorer replaces report null, header and scoring note; dashboard reads actual rating', async () => {
  const before = report();
  const after = stampReportJev(before, receipt);
  assert.deepEqual(machineSummary(after).data.jev, result);
  assert.equal(machineSummary(after).data.score, 3.4);
  assert.deepEqual(machineSummary(after).data.extra, { untouched: 'value' });
  assert.match(after, /\*\*Jev:\*\* 3.2\/5 \(fit 56, maybe\)/);
  assert.match(after, /\*\*Scoring note:\*\* no web research/);
  assert.ok(after.includes(before.split('## Job Description')[1].split('## A)')[0]));
  assert.deepEqual(readReportJev(after).jev, { fit: 56, score: 3.2, verdict: 'maybe' });
  if (existsSync(new URL('../web/src/lib/report-jev.mjs', import.meta.url))) {
    const { attachJev } = await import('../web/src/lib/report-jev.mjs');
    const [row] = attachJev([{ url, report: '001-acme.md' }], [], () => after);
    assert.equal(row.jevStatus, 'rated');
    assert.equal(row.jev.fit, 56);
  }
  assert.equal(stampReportJev(after, receipt), after, 'finalization must be idempotent');
});

test('trusted result also replaces agent-invented quantities and stale gate blocks', () => {
  const before = report('{fit: 100, score: 5, verdict: apply}').replace('## A)', '## Calibrated pre-screen (Jev)\n\nnot run: ignored input\n\n## A)');
  const after = stampReportJev(before, receipt);
  assert.deepEqual(machineSummary(after).data.jev, result);
  assert.equal((after.match(/^## Calibrated pre-screen \(Jev\)/gm) ?? []).length, 1);
  assert.ok(!after.includes('ignored input'));
});

test('real scoring failure is persisted with its reason instead of an invented rating', () => {
  const after = stampReportJev(report('{fit: 100, score: 5, verdict: apply}'), { url, result: null, reason: 'provider unavailable' });
  assert.equal(machineSummary(after).data.jev, null);
  assert.equal(machineSummary(after).data.jev_not_run_reason, 'provider unavailable');
  assert.match(after, /not run: provider unavailable/);
  assert.equal(prepareEvaluationReport(after).ok, true);
});

test('generic no-JEV note and reasons inside archived JD cannot justify new null writes', () => {
  assert.match(prepareEvaluationReport(report()).error, /not-run reason/);
});

test('wrong URL, invalid scorer output, duplicate summaries and incomplete reports are refused', () => {
  assert.throws(() => stampReportJev(report(), { ...receipt, url: 'https://example.test/jobs/2' }), /does not match/);
  assert.throws(() => stampReportJev(report(), { ...receipt, url: 'https://[' }), /posting URL/);
  for (const patch of [{ fit: 101 }, { fit: null }, { score: NaN }, { verdict: 'unknown' }, { error: 'API failed' }]) {
    assert.throws(() => stampReportJev(report(), { url, result: { ...result, ...patch } }), /Invalid trusted/);
  }
  assert.throws(() => stampReportJev(report(), { url, result: null, reason: 'no Jev gate' }), /concrete/);
  assert.throws(() => stampReportJev(report().replace('## B)', '## Missing)'), receipt), /incomplete/);
  const duplicate = report() + '\n## Machine Summary\n```yaml\ncompany: other\n```\n';
  assert.throws(() => stampReportJev(duplicate, receipt), /exactly one/);
});

test('receipt and finalizer persist actual output, refuse mismatches and preserve files on failure', t => {
  const root = mkdtempSync(join(tmpdir(), 'jev-finalize-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reports = join(root, 'reports'); mkdirSync(reports);
  const file = join(reports, '001-acme.md'); writeFileSync(file, report());
  const resultFile = join(root, 'scorer.json'); writeFileSync(resultFile, JSON.stringify(result));
  const receiptFile = join(root, 'receipt.json');
  recordJevReceipt(receiptFile, url, resultFile, '');
  assert.equal(JSON.parse(readFileSync(receiptFile)).url, url);
  assert.throws(() => finalizeReportJev(reports, '001', 'https://example.test/jobs/2', receiptFile), /another posting/);
  assert.equal(readFileSync(file, 'utf8'), report());
  finalizeReportJev(reports, '001', url, receiptFile);
  assert.equal(readReportJev(readFileSync(file, 'utf8')).jev.fit, 56);
  writeFileSync(join(reports, '001-duplicate.md'), report());
  assert.throws(() => finalizeReportJev(reports, '001', url, receiptFile), /exactly one report/);
});


test('updates ship both runtime dependencies of batch JEV finalization', () => {
  for (const file of ['finalize-report-jev.mjs', 'lib/report-jev-write.mjs']) assert.ok(SYSTEM_PATHS.includes(file), `${file} missing from updater`);
});
