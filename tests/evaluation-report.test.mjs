import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluationReportState, readReportJev, prepareEvaluationReport, withJevHeader } from '../lib/evaluation-report.mjs';

const report = (jev = '  fit: 78\n  score: 4.1\n  verdict: apply', extra = '') => `# Evaluation: Acme — Manager

**Score:** 3.8/5
**URL:** https://example.test/jobs/1
${extra}

## Machine Summary
\`\`\`yaml
company: Acme
role: Manager
score: 3.8
final_decision: Apply
jev:${jev === 'null' ? ' null' : `\n${jev}`}
\`\`\`

${'ABCDEFG'.split('').map(l => `## ${l}) Evaluation\nEvidence.`).join('\n\n')}
`;

test('web report evidence mirror differs only by its YAML adapter import', () => {
  // The web bundle cannot statically import the core helper outside its root.
  // Empty YAML remains invalid report evidence with either parser adapter.
  const core = readFileSync(new URL('../lib/evaluation-report.mjs', import.meta.url), 'utf8');
  const web = readFileSync(new URL('../web/src/lib/core/evaluation-report.mjs', import.meta.url), 'utf8');
  assert.equal(core.replace("import { loadYaml } from './yaml-document.mjs';", "import { load as loadYaml } from 'js-yaml';"), web);
});

test('structured Jev after a long JD is recovered without confusing global score', () => {
  const markdown = report().replace('## Machine Summary', `## Job Description (archived verbatim)\n\n${'Posting text. '.repeat(1200)}\n\n## Machine Summary`);
  assert.deepEqual(readReportJev(markdown).jev, { fit: 78, score: 4.1, verdict: 'apply' });
  assert.equal(prepareEvaluationReport(markdown).ok, true);
});

test('new saves derive a canonical header and normalization is idempotent', () => {
  const prepared = prepareEvaluationReport(report());
  assert.equal(prepared.ok, true);
  assert.match(prepared.markdown, /\*\*Score:\*\* 3.8\/5\n\*\*Jev:\*\* 4.1\/5 \(fit 78, apply\)/);
  assert.equal(prepareEvaluationReport(prepared.markdown).markdown, prepared.markdown);
});

test('contradictory, malformed and missing Jev cannot be persisted', () => {
  assert.match(prepareEvaluationReport(report(undefined, '**Jev:** 2/5 (fit 25, skip)')).error, /disagrees/);
  assert.match(prepareEvaluationReport(report('  fit: 178\n  score: 4.1\n  verdict: apply')).error, /Invalid Jev/);
  assert.match(prepareEvaluationReport(report().replace(/jev:\n(?:  .*\n)+/, '')).error, /must record jev/);
  assert.equal(readReportJev(report('  fit: 178\n  score: 4.1\n  verdict: apply')).status, 'invalid');
});

test('explicit not-run requires a reason and does not become a zero or older rating', () => {
  assert.match(prepareEvaluationReport(report('null')).error, /not-run reason/);
  const markdown = report('null', '**Scoring note:** no Jev gate\nnot run: provider unavailable');
  assert.equal(prepareEvaluationReport(markdown).ok, true);
  assert.equal(readReportJev(markdown).status, 'not-run');
  assert.equal(readReportJev(markdown).jev, null);
});

test('stopped notes cannot pass with a title, score or invented summary alone', () => {
  const note = '# Evaluation: Acme — Manager\n**Score:** 4/5\nStopped before Block A. Which agency did this posting come through?';
  assert.equal(evaluationReportState(note), 'needs-review');
  assert.equal(prepareEvaluationReport(note).ok, false);
  assert.equal(prepareEvaluationReport(report().replace(/## [A-G]\) Evaluation\nEvidence\./g, '')).ok, false);
});

test('legacy passages preserve actual quantities and do not infer missing fit', () => {
  assert.deepEqual(readReportJev('**Jev pre-screen:** 2.5/5 (fit 37, verdict `maybe`).').jev, { fit: 37, score: 2.5, verdict: 'maybe' });
  assert.deepEqual(readReportJev('**Jev pre-screen:** 29/100, `maybe`, 2.2/5.').jev, { fit: 29, score: 2.2, verdict: 'maybe' });
  assert.deepEqual(readReportJev('Jev returned maybe, no blocking answer.').jev, { fit: null, score: null, verdict: 'maybe' });
});

test('archived JD and unrelated fenced examples cannot supply a Jev rating', () => {
  const markdown = '# Evaluation: Acme\n\n## Job Description (archived verbatim)\n**Jev:** 5/5 (fit 100, apply)\n\n## A) Role Summary\n```text\n**Jev:** 5/5 (fit 100, apply)\n```';
  assert.equal(readReportJev(markdown).jev, null);
  assert.equal(readReportJev('Jev fit 60 maybe\nJev fit 90 apply').status, 'invalid');
});

test('canonicalizing a late header does not modify archived JD text', () => {
  const markdown = report(undefined, '**Jev:** 4.1/5 (fit 78, apply)').replace('## Machine Summary', '## Job Description (archived verbatim)\n**Jev:** 1/5 (fit 1, skip)\n\n## Machine Summary');
  assert.match(withJevHeader(markdown, '4.1/5 (fit 78, apply)'), /## Job Description \(archived verbatim\)\n\*\*Jev:\*\* 1\/5 \(fit 1, skip\)/);
});
