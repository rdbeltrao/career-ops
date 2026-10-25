// tests/answer-bank.test.mjs — the application answer bank.
//
// Answers drafted and reviewed on the web Apply page used to live only in React
// state: nothing reached disk, so every prefill started from zero and a second
// application to the same company could not be checked against the first. The
// bank (data/application-answers.jsonl) is the cross-application record both the
// web page and the CLI apply mode write, and these tests pin its contract:
//
//   - what is never stored (passwords, empty answers);
//   - how a question is classified, because the class decides whether a saved
//     answer may be suggested at all (consent never, knockout only with a
//     confirmation the user must give);
//   - how a saved answer is matched to a new form's question;
//   - the guard that runs on the planner's output, which is the code-level
//     version of modes/apply.md's "ask every time" rule for knockout questions;
//   - the per-company history the repeat-application check reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ANSWER_BANK_FILE,
  answerBankPath,
  appendBankRecord,
  bankRecordFromSnapshot,
  classifyQuestion,
  companyHistory,
  companyKey,
  guardAnswers,
  mergeSnapshots,
  snapshotHasAnswers,
  matchPriorAnswers,
  normalizeQuestion,
  readBank,
  reportMeta,
  snapshotFromForm,
} from '../answer-bank.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'answer-bank-'));
}

const fields = [
  { id: 'co0', type: 'text', label: 'First name*', required: true },
  { id: 'co1', type: 'email', label: 'Email', required: true },
  { id: 'co2', type: 'textarea', label: 'Why do you want to work at Acme?', required: true },
  { id: 'co3', type: 'select', label: 'Do you require visa sponsorship?', required: true, options: ['Yes', 'No'] },
  { id: 'co4', type: 'text', label: 'Notice period', required: false },
  { id: 'co5', type: 'checkbox', label: 'I agree to the privacy policy', required: true },
  { id: 'co6', type: 'text', label: 'Password', required: true },
  { id: 'co7', type: 'file', label: 'Resume/CV', required: true },
  { id: 'co8', type: 'text', label: 'Website', required: false },
];

const answers = {
  co0: 'Renata',
  co1: 'r@example.com',
  co2: 'Because the product matters to me.',
  co3: 'No',
  co4: '3 months',
  co5: 'true',
  co6: 'hunter2',
  co8: '   ',
};

test('classifyQuestion: password, consent, sensitive, knockout, identity, other', () => {
  assert.equal(classifyQuestion('Password'), 'password');
  assert.equal(classifyQuestion('Passwort bestätigen'), 'password');
  assert.equal(classifyQuestion('Hasło'), 'password');
  assert.equal(classifyQuestion('Do you agree to relocate to Berlin?'), 'knockout', 'a knockout question phrased as agreement stays knockout');
  assert.equal(classifyQuestion('I agree to the privacy policy'), 'consent');
  assert.equal(classifyQuestion('Datenschutzerklärung akzeptieren'), 'consent');
  assert.equal(classifyQuestion('Gender'), 'sensitive');
  assert.equal(classifyQuestion('Date of birth'), 'sensitive');
  assert.equal(classifyQuestion('Do you require visa sponsorship?'), 'knockout');
  assert.equal(classifyQuestion('Are you authorized to work in Germany?'), 'knockout');
  assert.equal(classifyQuestion('Notice period'), 'knockout');
  assert.equal(classifyQuestion('Kündigungsfrist'), 'knockout');
  assert.equal(classifyQuestion('Salary expectations (EUR)'), 'knockout');
  assert.equal(classifyQuestion('How many years of experience do you have with React?'), 'knockout');
  assert.equal(classifyQuestion('Earliest start date'), 'knockout');
  assert.equal(classifyQuestion('First name'), 'identity');
  assert.equal(classifyQuestion('LinkedIn profile'), 'identity');
  assert.equal(classifyQuestion('Why do you want to work here?'), 'other');
});

test('normalizeQuestion drops required marks, optional tags, punctuation and accents', () => {
  assert.equal(normalizeQuestion('  First name* (optional) '), 'first name');
  assert.equal(normalizeQuestion('Kündigungsfrist?'), 'kundigungsfrist');
});

test('snapshotFromForm: sorts by kind, never keeps a password or an empty answer', () => {
  const snap = snapshotFromForm({ fields, answers, cvFile: 'output/cv-renata-acme.pdf' });
  assert.deepEqual(snap.freeText, [{ question: 'Why do you want to work at Acme?', answer: 'Because the product matters to me.' }]);
  assert.deepEqual(snap.selections, [
    { question: 'Do you require visa sponsorship?', selection: 'No' },
    { question: 'I agree to the privacy policy', selection: 'true' },
  ]);
  assert.deepEqual(snap.fieldValues, [
    { question: 'First name', answer: 'Renata' },
    { question: 'Email', answer: 'r@example.com' },
    { question: 'Notice period', answer: '3 months' },
  ]);
  assert.deepEqual(snap.files, [{ field: 'Resume/CV', path: 'output/cv-renata-acme.pdf' }]);
  assert.ok(!JSON.stringify(snap).includes('hunter2'));
});

test('bankRecordFromSnapshot + append + read round-trip into data/application-answers.jsonl', () => {
  const root = tmpRoot();
  const snap = snapshotFromForm({ fields, answers });
  const record = bankRecordFromSnapshot(snap, { date: '2026-10-01', state: 'submitted', report: '067', company: 'Acme GmbH', role: 'EM', url: 'https://jobs.ashbyhq.com/acme/1' });
  assert.equal(appendBankRecord(root, record), true);
  assert.equal(answerBankPath(root), join(root, ANSWER_BANK_FILE));
  const { records, skipped } = readBank(root);
  assert.equal(skipped, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].company, 'Acme GmbH');
  assert.equal(records[0].state, 'submitted');
  assert.ok(records[0].answers.some((a) => a.q === 'Notice period' && a.a === '3 months' && a.kind === 'field'));
  assert.ok(!readFileSync(answerBankPath(root), 'utf8').includes('hunter2'));
});

test('appendBankRecord refuses an empty record and a bad state', () => {
  const root = tmpRoot();
  assert.equal(appendBankRecord(root, bankRecordFromSnapshot({}, { state: 'filled' })), false);
  assert.throws(() => bankRecordFromSnapshot({ freeText: [{ question: 'q', answer: 'a' }] }, { state: 'sent' }), /state/);
});

test('readBank: a missing file is empty, a corrupt line is skipped and counted', () => {
  const root = tmpRoot();
  assert.deepEqual(readBank(root), { records: [], skipped: 0 });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(answerBankPath(root), '{"v":1,"date":"2026-01-01","state":"filled","company":"X","answers":[{"q":"a","a":"b","kind":"free"}]}\nnot json\n{"v":1}\n');
  const { records, skipped } = readBank(root);
  assert.equal(records.length, 1);
  assert.equal(skipped, 2);
});

test('companyKey folds case, punctuation and a trailing legal form only', () => {
  assert.equal(companyKey('Acme GmbH'), companyKey('ACME'));
  assert.equal(companyKey('Acme, Inc.'), 'acme');
  assert.equal(companyKey('Acme Holding SE & Co. KG'), companyKey('acme holding'));
  assert.notEqual(companyKey('Acme'), companyKey('Acmeo'));
  assert.notEqual(companyKey('AS Software'), companyKey('Software AG'), 'a leading word is part of the name');
  assert.equal(companyKey('SE Ranking'), 'seranking');
  assert.equal(companyKey('Co-op'), 'coop');
  assert.equal(companyKey('?'), '');
});

function rec(over) {
  return { v: 1, date: '2026-09-01', state: 'filled', report: null, company: 'Other Co', role: 'EM', url: '', answers: [], ...over };
}

test('matchPriorAnswers: same label wins, same company preferred, then submitted, then newest', () => {
  const records = [
    rec({ date: '2026-08-01', company: 'Other Co', state: 'submitted', answers: [{ q: 'Notice period', a: '1 month', kind: 'field' }] }),
    rec({ date: '2026-09-01', company: 'Acme', state: 'submitted', answers: [{ q: 'Notice Period *', a: '3 months', kind: 'field' }] }),
    rec({ date: '2026-10-01', company: 'Third', state: 'filled', answers: [{ q: 'Notice period', a: '2 months', kind: 'field' }] }),
  ];
  const priors = matchPriorAnswers(records, [{ id: 'f', type: 'text', label: 'Notice period' }], { company: 'ACME GmbH' });
  assert.equal(priors.f.answer, '3 months');
  assert.equal(priors.f.sameCompany, true);
  assert.equal(priors.f.class, 'knockout');

  const elsewhere = matchPriorAnswers(records, [{ id: 'f', type: 'text', label: 'Notice period' }], { company: 'Nobody' });
  assert.equal(elsewhere.f.answer, '3 months', 'submitted beats a newer filled one');
});

test('matchPriorAnswers: a reworded question matches on strong token overlap only', () => {
  const records = [rec({ answers: [{ q: 'What is your earliest possible start date?', a: '2027-01-01', kind: 'field' }] })];
  const hit = matchPriorAnswers(records, [{ id: 'a', type: 'text', label: 'Earliest possible start date' }], {});
  assert.equal(hit.a?.answer, '2027-01-01');
  const miss = matchPriorAnswers(records, [{ id: 'b', type: 'text', label: 'Start of studies' }], {});
  assert.equal(miss.b, undefined);
});

test('matchPriorAnswers: never consent, never password, never files; options must still exist', () => {
  const records = [rec({ answers: [
    { q: 'I agree to the privacy policy', a: 'true', kind: 'select' },
    { q: 'Password', a: 'x', kind: 'field' },
    { q: 'Resume/CV', a: 'output/cv.pdf', kind: 'file' },
    { q: 'Do you require visa sponsorship?', a: 'No', kind: 'select' },
    { q: 'Work location', a: 'Berlin office', kind: 'select' },
  ] })];
  const priors = matchPriorAnswers(records, [
    { id: 'c', type: 'checkbox', label: 'I agree to the privacy policy' },
    { id: 'p', type: 'text', label: 'Password' },
    { id: 'r', type: 'file', label: 'Resume/CV' },
    { id: 'v', type: 'select', label: 'Do you require visa sponsorship?', options: ['yes', 'no'] },
    { id: 'l', type: 'select', label: 'Work location', options: ['Remote', 'Munich'] },
  ], {});
  assert.deepEqual(Object.keys(priors), ['v']);
  assert.equal(priors.v.answer, 'no', 'mapped to the exact option text of the new form');
});

test('guardAnswers: a saved knockout or sensitive answer is a suggestion, never a value the fill sends', () => {
  const guarded = guardAnswers(
    [
      { id: 'n', type: 'text', label: 'Notice period' },
      { id: 's', type: 'select', label: 'Salary expectation', options: [] },
      { id: 'g', type: 'select', label: 'Gender', options: ['Female', 'Male'] },
      { id: 'g2', type: 'select', label: 'Gender identity', options: ['Female', 'Male'] },
      { id: 'c', type: 'checkbox', label: 'I consent to the talent pool' },
      { id: 'w', type: 'textarea', label: 'Why us?' },
      { id: 'e', type: 'text', label: 'Earliest start date' },
      { id: 'v', type: 'text', label: 'Visa status' },
    ],
    {
      n: { value: '3 months', needs_confirmation: false },
      s: { value: '90000', needs_confirmation: false },
      g: { value: 'Female', needs_confirmation: false },
      g2: { value: 'Male', needs_confirmation: false },
      c: { value: 'true', needs_confirmation: false },
      w: { value: 'Because.', needs_confirmation: false },
      v: { value: 'EU citizen', needs_confirmation: false },
    },
    {
      n: { answer: '3 months', company: 'Acme', date: '2026-09-01' },
      e: { answer: '2027-01-01', company: 'Beta', date: '2026-08-01' },
      g2: { answer: 'Male', company: 'Acme', date: '2026-09-01' },
      v: { answer: 'Blue Card', company: 'Acme', date: '2026-09-01' },
    },
  );
  assert.deepEqual(guarded.n, { value: '', needs_confirmation: true, suggestion: '3 months', suggestion_from: 'Acme, 2026-09-01' }, 'the planner copying the saved answer still leaves the value empty');
  assert.deepEqual(guarded.e, { value: '', needs_confirmation: true, suggestion: '2027-01-01', suggestion_from: 'Beta, 2026-08-01' });
  assert.deepEqual(guarded.v, { value: 'EU citizen', needs_confirmation: true, suggestion: 'Blue Card', suggestion_from: 'Acme, 2026-09-01' }, 'a draft that differs came from the profile and is kept, flagged');
  assert.deepEqual(guarded.s, { value: '90000', needs_confirmation: true }, 'a profile-sourced knockout draft with no saved answer is kept, flagged');
  assert.deepEqual(guarded.g, { value: '', needs_confirmation: true }, 'no saved answer: a demographic is never invented');
  assert.deepEqual(guarded.g2, { value: '', needs_confirmation: true, suggestion: 'Male', suggestion_from: 'Acme, 2026-09-01' });
  assert.deepEqual(guarded.c, { value: '', needs_confirmation: true }, 'consent is never ticked for the user');
  assert.deepEqual(guarded.w, { value: 'Because.', needs_confirmation: false });
});

test('mergeSnapshots: a new save updates matching questions and keeps the rest of the section', () => {
  const existing = {
    state: 'submitted',
    freeText: [{ question: 'Why Acme?', answer: 'Old.' }, { question: 'Anything else?', answer: 'Kept.' }],
    selections: [],
    fieldValues: [{ question: 'Notice period', answer: '3 months' }],
    files: [{ field: 'Cover letter', path: 'output/cover.pdf' }, { field: 'Resume/CV', path: 'output/old.pdf' }],
  };
  const incoming = {
    freeText: [{ question: 'Why Acme?', answer: 'New.' }],
    selections: [{ question: 'Sponsorship', selection: 'No' }],
    fieldValues: [],
    files: [{ field: 'Resume/CV', path: 'output/new.pdf' }],
  };
  const merged = mergeSnapshots(existing, incoming, 'filled');
  assert.equal(merged.state, 'submitted', 'a later fill never downgrades a submitted section');
  assert.deepEqual(merged.freeText, [{ question: 'Why Acme?', answer: 'New.' }, { question: 'Anything else?', answer: 'Kept.' }]);
  assert.deepEqual(merged.selections, [{ question: 'Sponsorship', selection: 'No' }]);
  assert.deepEqual(merged.fieldValues, [{ question: 'Notice period', answer: '3 months' }]);
  assert.deepEqual(merged.files, [{ field: 'Cover letter', path: 'output/cover.pdf' }, { field: 'Resume/CV', path: 'output/new.pdf' }]);
  assert.equal(mergeSnapshots(null, incoming, 'filled').state, 'filled');
  assert.equal(mergeSnapshots({ ...existing, state: 'filled' }, incoming, 'submitted').state, 'submitted');
});

test('snapshotHasAnswers: an empty snapshot is never worth writing', () => {
  assert.equal(snapshotHasAnswers({ freeText: [], selections: [], fieldValues: [], files: [] }), false);
  assert.equal(snapshotHasAnswers({ files: [{ field: 'Resume/CV', path: 'x.pdf' }] }), false, 'a CV path alone is not an answer');
  assert.equal(snapshotHasAnswers({ fieldValues: [{ question: 'a', answer: 'b' }] }), true);
});

test('snapshotFromForm: a field extract flags as a password is dropped whatever its label', () => {
  const snap = snapshotFromForm({ fields: [{ id: 'p', type: 'text', label: 'Confirm', password: true }], answers: { p: 'hunter2' } });
  assert.deepEqual(snap.fieldValues, []);
});

test('companyHistory: one entry per application, newest first, latest state wins', () => {
  const records = [
    rec({ date: '2026-05-01', company: 'Acme', report: '010', state: 'filled', role: 'EM', answers: [{ q: 'Why?', a: 'v1', kind: 'free' }] }),
    rec({ date: '2026-05-01', company: 'ACME GmbH', report: '010', state: 'submitted', role: 'EM', answers: [{ q: 'Why?', a: 'v2', kind: 'free' }] }),
    rec({ date: '2026-09-01', company: 'Acme', report: null, url: 'https://jobs.lever.co/acme/2', state: 'filled', role: 'Director', answers: [{ q: 'Why?', a: 'v3', kind: 'free' }] }),
    rec({ date: '2026-09-02', company: 'Beta', answers: [{ q: 'Why?', a: 'x', kind: 'free' }] }),
  ];
  const history = companyHistory(records, 'acme');
  assert.equal(history.length, 2);
  assert.equal(history[0].role, 'Director');
  assert.equal(history[1].state, 'submitted');
  assert.equal(history[1].answers[0].a, 'v2');

  const refilled = companyHistory([...records, rec({ date: '2026-06-01', company: 'Acme', report: '010', state: 'filled', role: 'EM', answers: [{ q: 'Why?', a: 'v4', kind: 'free' }] })], 'acme');
  assert.equal(refilled.find((h) => h.report === '010').state, 'submitted', 'a later fill keeps the application submitted');
  assert.equal(refilled.find((h) => h.report === '010').answers[0].a, 'v4');

  const others = companyHistory(records, 'acme', { exclude: { report: '10', url: '' } });
  assert.deepEqual(others.map((h) => h.role), ['Director'], 'the application being filled is not an earlier one');
  const byUrl = companyHistory(records, 'acme', { exclude: { report: '', url: 'https://jobs.lever.co/acme/2' } });
  assert.deepEqual(byUrl.map((h) => h.report), ['010']);
});

test('companyHistory and matching: an unknown employer has no identity', () => {
  const records = [rec({ company: '?', state: 'submitted', answers: [{ q: 'Notice period', a: '1 month', kind: 'field' }] })];
  assert.deepEqual(companyHistory(records, '?'), []);
  assert.equal(matchPriorAnswers(records, [{ id: 'f', type: 'text', label: 'Notice period' }], { company: '?' }).f.sameCompany, false);
});

test('reportMeta reads company, role and URL from a report header', () => {
  const meta = reportMeta('# Evaluation: Acme GmbH — Engineering Manager\n\n**Date:** 2026-10-01\n**URL:** https://jobs.ashbyhq.com/acme/1\n');
  assert.deepEqual(meta, { company: 'Acme GmbH', role: 'Engineering Manager', url: 'https://jobs.ashbyhq.com/acme/1' });
  assert.deepEqual(reportMeta('no header'), { company: '', role: '', url: '' });
});

test('CLI: --company prints the history as JSON, read-only', () => {
  const root = tmpRoot();
  appendBankRecord(root, rec({ company: 'Acme', report: '067', state: 'submitted', answers: [{ q: 'Why?', a: 'Because.', kind: 'free' }] }));
  const r = spawnSync(process.execPath, [join(ROOT, 'answer-bank.mjs'), '--company', 'Acme', '--json'], {
    env: { ...process.env, CAREER_OPS_ROOT: root },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.company, 'Acme');
  assert.equal(out.applications.length, 1);
  assert.equal(out.applications[0].report, '067');

  const text = spawnSync(process.execPath, [join(ROOT, 'answer-bank.mjs'), '--company', 'Nobody'], {
    env: { ...process.env, CAREER_OPS_ROOT: root },
    encoding: 'utf8',
  });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /No saved answers for Nobody/);
});

test('application-answers.mjs: writing a report section also appends to the bank beside that report', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'reports'), { recursive: true });
  const report = join(root, 'reports', '067-acme-2026-10-01.md');
  writeFileSync(report, '# Evaluation: Acme — Engineering Manager\n\n**URL:** https://jobs.ashbyhq.com/acme/1\n');
  const input = join(root, 'answers.json');
  writeFileSync(input, JSON.stringify({ freeText: [{ question: 'Why Acme?', answer: 'Because.' }] }));
  const run = spawnSync(process.execPath, [join(ROOT, 'application-answers.mjs'), '--report', report, '--input', input, '--state', 'submitted'], {
    env: { ...process.env, CAREER_OPS_ROOT: join(root, 'elsewhere') },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).banked, true);
  const { records } = readBank(root);
  assert.equal(records.length, 1);
  assert.deepEqual(
    { report: records[0].report, company: records[0].company, role: records[0].role, url: records[0].url, state: records[0].state },
    { report: '067', company: 'Acme', role: 'Engineering Manager', url: 'https://jobs.ashbyhq.com/acme/1', state: 'submitted' },
  );
});

test('application-answers.mjs: a report outside a reports/ directory, or --no-bank, writes no bank', () => {
  const root = tmpRoot();
  const report = join(root, '067-acme.md');
  writeFileSync(report, '# Evaluation: Acme — EM\n');
  const input = join(root, 'answers.json');
  writeFileSync(input, JSON.stringify({ freeText: [{ question: 'Why?', answer: 'Because.' }] }));
  const loose = spawnSync(process.execPath, [join(ROOT, 'application-answers.mjs'), '--report', report, '--input', input], { encoding: 'utf8' });
  assert.equal(loose.status, 0, loose.stderr);
  assert.equal(JSON.parse(loose.stdout).banked, false);

  mkdirSync(join(root, 'reports'));
  const inReports = join(root, 'reports', '068-acme.md');
  writeFileSync(inReports, '# Evaluation: Acme — EM\n');
  const opted = spawnSync(process.execPath, [join(ROOT, 'application-answers.mjs'), '--report', inReports, '--input', input, '--no-bank'], { encoding: 'utf8' });
  assert.equal(opted.status, 0, opted.stderr);
  assert.equal(JSON.parse(opted.stdout).banked, false);
  assert.deepEqual(readBank(root), { records: [], skipped: 0 });
});
