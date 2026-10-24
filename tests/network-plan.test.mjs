// tests/network-plan.test.mjs — the weekly LinkedIn connection plan ranks the
// companies in the funnel and prints the search links, nothing more.
//
// network-plan.mjs reads data/applications.md and the pending rows of
// data/pipeline.md, ranks companies by how much the candidate has invested in
// them (an application in progress, then Jev or rank verdicts), leaves out the
// companies marked done in data/network.json, and renders a checklist with one
// people-search URL per role. It never opens LinkedIn.
//
// Run:  node --test tests/network-plan.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, NODE } from './helpers.mjs';
import {
  rankCompanies, renderPlan, parsePipelineRows, readTrackerRows, loadDone,
  peopleSearchUrl, companySearchUrl, DEFAULT_ROLES,
} from '../network-plan.mjs';

const tracker = (status, company, extra = {}) => ({
  num: 1, date: '2026-10-01', company, role: 'Engineering Manager', score: '', status, url: 'https://x/t', ...extra,
});
const pipe = (company, { jev, rank } = {}) => ({
  url: `https://x/${encodeURIComponent(company)}`, company, title: 'Engineering Manager',
  jev: jev ? { fit: 80, verdict: jev } : null, rank: rank ?? null,
});
const names = (plans) => plans.map((p) => p.company);

// ── ranking ─────────────────────────────────────────────────────────────────

test('an applied company outranks one with three apply verdicts', () => {
  const plans = rankCompanies(
    [tracker('Applied', 'Applied Co')],
    [pipe('Apply Co', { jev: 'apply' }), pipe('Apply Co', { jev: 'apply' }), pipe('Apply Co', { jev: 'apply' })],
    { perCompany: 10 },
  );
  assert.deepEqual(names(plans), ['Applied Co', 'Apply Co']);
  assert.equal(plans[0].score, 10);
  assert.equal(plans[1].score, 9);
  assert.equal(plans[0].applied, true);
  assert.equal(plans[1].applied, false);
});

test('every active status counts 10; apply and rank 4.0 count 3; maybe and rank 3.5 count 1; below that nothing', () => {
  const plans = rankCompanies(
    [tracker('Interview', 'Interview Co'), tracker('Responded', 'Responded Co'), tracker('Assessment', 'Assessment Co'), tracker('Offer', 'Offer Co')],
    [pipe('Rank Four', { rank: 4.0 }), pipe('Rank Three Five', { rank: 3.5 }), pipe('Rank Three', { rank: 3.0 }), pipe('Maybe Co', { jev: 'maybe' }), pipe('Skip Co', { jev: 'skip' }), pipe('No Signal')],
    { perCompany: 10 },
  );
  const score = Object.fromEntries(plans.map((p) => [p.company, p.score]));
  assert.equal(score['Interview Co'], 10);
  assert.equal(score['Responded Co'], 10);
  assert.equal(score['Assessment Co'], 10);
  assert.equal(score['Offer Co'], 10);
  assert.equal(score['Rank Four'], 3);
  assert.equal(score['Rank Three Five'], 1);
  assert.equal(score['Maybe Co'], 1);
  assert.ok(!('Rank Three' in score), 'a rank below 3.5 must not list the company');
  assert.ok(!('Skip Co' in score), 'a skip verdict must not list the company');
  assert.ok(!('No Signal' in score), 'a pending row with no verdict must not list the company');
});

test('the per-company cap holds', () => {
  const rows = Array.from({ length: 5 }, () => pipe('Many Co', { jev: 'apply' }));
  const [plan] = rankCompanies([], rows, { perCompany: 2 });
  assert.equal(plan.openings.length, 2);
  assert.equal(plan.score, 6);
});

test('closed and terminal tracker rows count for nothing', () => {
  const plans = rankCompanies(
    [tracker('Rejected', 'Rejected Co'), tracker('Discarded', 'Discarded Co'), tracker('SKIP', 'Skip Co'), tracker('Hired', 'Hired Co'),
      tracker('Rejected', 'Mixed Co', { url: 'https://x/rejected' }), tracker('Applied', 'Mixed Co', { url: 'https://x/applied' })],
    [],
    { perCompany: 10 },
  );
  assert.deepEqual(names(plans), ['Mixed Co']);
  assert.deepEqual(plans[0].openings.map((o) => o.url), ['https://x/applied']);
});

test('an evaluated tracker row counts by its score like a rank segment', () => {
  const plans = rankCompanies(
    [tracker('Evaluated', 'Eval High', { score: '4.2/5' }), tracker('Evaluated', 'Eval Mid', { score: '3.6/5' }), tracker('Evaluated', 'Eval Low', { score: '3.0/5' }), tracker('Evaluated', 'Eval None', { score: 'N/A' })],
    [],
    { perCompany: 10 },
  );
  const score = Object.fromEntries(plans.map((p) => [p.company, p.score]));
  assert.equal(score['Eval High'], 3);
  assert.equal(score['Eval Mid'], 1);
  assert.ok(!('Eval Low' in score));
  assert.ok(!('Eval None' in score));
});

test('a done company is excluded, matched without regard to case or legal form', () => {
  const plans = rankCompanies(
    [tracker('Applied', 'Done Co GmbH'), tracker('Applied', 'Kept Co')],
    [pipe('Done Co', { jev: 'apply' })],
    { perCompany: 10, done: { 'done co': '2026-10-12' } },
  );
  assert.deepEqual(names(plans), ['Kept Co']);
});

test('tracker and pipeline rows for one company merge under one entry, ties break by name', () => {
  const plans = rankCompanies(
    [tracker('Applied', 'Zeta')],
    [pipe('zeta', { jev: 'apply' }), pipe('Alpha', { jev: 'apply' }), pipe('Beta', { jev: 'apply' })],
    { perCompany: 10 },
  );
  assert.deepEqual(names(plans), ['Zeta', 'Alpha', 'Beta']);
  assert.equal(plans[0].openings.length, 2);
  assert.equal(plans[0].score, 13);
});

// ── rendering ───────────────────────────────────────────────────────────────

test('the rendered plan carries the week, the budget, the company search and one people-search URL per role', () => {
  const plans = rankCompanies([tracker('Applied', 'Acme GmbH', { url: 'https://x/acme' })], [], { perCompany: 10 });
  const text = renderPlan(plans, { quota: 100, roles: ['Engineering Manager', 'CTO'], date: '2026-10-19' });
  assert.ok(text.includes('# LinkedIn connection plan, week of 2026-10-19'));
  assert.ok(text.includes('100 invitations'));
  assert.ok(text.includes('## 1. Acme GmbH (applied)'));
  assert.ok(text.includes('[Applied](https://x/acme)'));
  assert.ok(text.includes('https://www.linkedin.com/search/results/companies/?keywords=Acme+GmbH'));
  assert.ok(text.includes('Engineering Manager: https://www.linkedin.com/search/results/people/?keywords=Acme+GmbH+Engineering+Manager&origin=GLOBAL_SEARCH_HEADER'));
  assert.ok(text.includes('CTO: https://www.linkedin.com/search/results/people/?keywords=Acme+GmbH+CTO&origin=GLOBAL_SEARCH_HEADER'));
  const peopleLinks = text.match(/search\/results\/people\//g) ?? [];
  assert.equal(peopleLinks.length, 2, 'one people-search URL per role');
  assert.match(text, /Connect/);
  assert.match(text, /--done/);
});

test('the default roles are the five role families and the search URLs encode like quote_plus', () => {
  assert.deepEqual(DEFAULT_ROLES, ['Engineering Manager', 'Head of Engineering', 'VP Engineering', 'CTO', 'Technical Recruiter']);
  assert.equal(peopleSearchUrl('Foo & Bar', 'CTO'), 'https://www.linkedin.com/search/results/people/?keywords=Foo+%26+Bar+CTO&origin=GLOBAL_SEARCH_HEADER');
  assert.equal(companySearchUrl('Foo & Bar'), 'https://www.linkedin.com/search/results/companies/?keywords=Foo+%26+Bar');
});

test('an empty plan says so', () => {
  assert.match(renderPlan([], { quota: 100, roles: ['CTO'], date: '2026-10-19' }), /Nothing to do/);
});

// ── parsing ─────────────────────────────────────────────────────────────────

test('parsePipelineRows reads pending rows with their jev and rank segments and skips done rows', () => {
  const text = [
    '# Pipeline', '', '## Pending', '',
    '- [ ] https://a | Acme | EM | Berlin | posted: 2026-10-01 | rank: 4.2/5 — strong fit | jev: 79 apply — seniority match, location yes',
    '- [x] https://b | Beta | EM | jev: 80 apply — done already',
    '- [ ] https://c | Gamma | EM',
    '- [ ] https://d | Delta | EM | jev: 40 skip — seniority below',
    'not a row',
  ].join('\n');
  const rows = parsePipelineRows(text);
  assert.deepEqual(rows.map((r) => r.company), ['Acme', 'Gamma', 'Delta']);
  assert.deepEqual(rows[0], { url: 'https://a', company: 'Acme', title: 'EM', rank: 4.2, jev: { fit: 79, verdict: 'apply' } });
  assert.deepEqual(rows[1], { url: 'https://c', company: 'Gamma', title: 'EM', rank: null, jev: null });
  assert.deepEqual(rows[2].jev, { fit: 40, verdict: 'skip' });
});

test('loadDone lower-cases the keys and tolerates a missing or broken file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'network-done-'));
  assert.deepEqual(loadDone(join(dir, 'missing.json')), {});
  writeFileSync(join(dir, 'broken.json'), '{not json');
  assert.deepEqual(loadDone(join(dir, 'broken.json')), {});
  writeFileSync(join(dir, 'ok.json'), JSON.stringify({ 'Acme GmbH': '2026-10-12' }));
  assert.deepEqual(loadDone(join(dir, 'ok.json')), { 'acme gmbh': '2026-10-12' });
});

// ── CLI ─────────────────────────────────────────────────────────────────────

const TRACKER = [
  '# Applications Tracker', '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '| 1 | 2026-10-05 | Acme | Backend Engineer | 4.2/5 | Applied | ✅ | [1](reports/001-acme.md) | [posting](https://jobs.example/acme/1) |',
  '| 2 | 2026-10-06 | Rejected Co | Backend Engineer | 4.0/5 | Rejected | ❌ | - | - |',
  '',
].join('\n');
const PIPELINE = [
  '# Pipeline', '', '## Pending', '',
  '- [ ] https://jobs.example/beta/2 | Beta | Engineering Manager | Berlin | jev: 81 apply — seniority match',
  '- [ ] https://jobs.example/gamma/3 | Gamma | Engineering Manager | rank: 3.7/5 — decent',
  '',
].join('\n');

function dataRoot() {
  const root = mkdtempSync(join(tmpdir(), 'network-plan-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'applications.md'), TRACKER);
  writeFileSync(join(root, 'data', 'pipeline.md'), PIPELINE);
  return root;
}

function run(root, ...args) {
  const r = spawnSync(NODE, [join(ROOT, 'network-plan.mjs'), ...args], {
    cwd: root,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_TRACKER: '', CAREER_OPS_PIPELINE: '', CAREER_OPS_PROFILE: '' },
  });
  assert.equal(r.error, undefined, `failed to spawn: ${r.error?.message}`);
  return r;
}

test('readTrackerRows parses the tracker through the shared column mapping', () => {
  const root = dataRoot();
  const rows = readTrackerRows(join(root, 'data', 'applications.md'));
  assert.deepEqual(rows.map((r) => [r.company, r.status, r.url]), [
    ['Acme', 'Applied', 'https://jobs.example/acme/1'],
    ['Rejected Co', 'Rejected', ''],
  ]);
});

test('the CLI ranks the data root, --done hides a company on the next run, --out writes the file', () => {
  const root = dataRoot();
  const first = run(root, '--json', '--date', '2026-10-19');
  assert.equal(first.status, 0, first.stderr);
  const plan = JSON.parse(first.stdout);
  assert.equal(plan.date, '2026-10-19');
  assert.deepEqual(plan.companies.map((c) => c.company), ['Acme', 'Beta', 'Gamma']);
  assert.equal(plan.companies[0].people.length, DEFAULT_ROLES.length);

  const marked = run(root, '--done', 'Acme', '--date', '2026-10-19');
  assert.equal(marked.status, 0, marked.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'data', 'network.json'), 'utf-8')), { acme: '2026-10-19' });
  assert.ok(!marked.stdout.includes('## 1. Acme'), 'the plan printed after --done still lists Acme');
  assert.ok(marked.stdout.includes('## 1. Beta'));

  const out = join(root, 'plan.md');
  const written = run(root, '--out', out, '--roles', 'CTO', '--date', '2026-10-19');
  assert.equal(written.status, 0, written.stderr);
  assert.ok(existsSync(out));
  const text = readFileSync(out, 'utf-8');
  assert.ok(text.includes('## 1. Beta'));
  assert.ok(!text.includes('Acme'));
  assert.equal((text.match(/search\/results\/people\//g) ?? []).length, 2, 'one role, two companies');
});

test('the CLI prints usage on --help and rejects an unknown flag', () => {
  const root = dataRoot();
  const help = run(root, '--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage:/m);
  const bogus = run(root, '--bogus');
  assert.equal(bogus.status, 1);
  assert.match(bogus.stderr, /unrecognized flag/);
  const noValue = run(root, '--quota');
  assert.equal(noValue.status, 1);
  assert.match(noValue.stderr, /requires a value/);
});

test('a data root with no tracker and no pipeline prints an empty plan, not an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'network-empty-'));
  const r = run(root, '--date', '2026-10-19');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Nothing to do/);
});
