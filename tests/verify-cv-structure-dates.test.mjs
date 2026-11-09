// tests/verify-cv-structure-dates.test.mjs — verify-cv-structure.mjs warns when a
// payload experience entry lacks month-level start and end dates.
//
// Tailored CVs shipped with year-only dates on the two latest roles, which
// verify-cv-facts.mjs cannot see (a year is true) and the structure check had
// no rule for. publish-cv.mjs blocks on the same rule; this script stays
// non-blocking by design, so the finding is a warning here.
//
// Run:  node --test tests/verify-cv-structure-dates.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { verifyStructure, checkMonthLevelDates } from '../verify-cv-structure.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const cvMd = ['## Experience', '', '### Acme Corp — Austin, TX · Series B fintech', '', '**VP of Engineering** · Feb 2023 – present', '', '### Beta Industries — Chicago, IL', '', '**CTO** · Mar 2011 – Jul 2021', ''].join('\n');
const dated = [
  { company: 'Acme Corp', location: 'Austin, TX · Series B fintech', dates: 'February 2023 – Present' },
  { company: 'Beta Industries', location: 'Chicago, IL', dates: '03/2011 – 07/2021' },
];

test('month-level dates in every accepted format pass', () => {
  assert.deepEqual(checkMonthLevelDates(dated), []);
  for (const dates of ['Jan 2020 – Mar 2023', '2020-01 – 2023-03', '2020-01 - Present', '1/2020 – Present']) assert.deepEqual(checkMonthLevelDates([{ company: 'X', dates }]), [], dates);
  assert.deepEqual(checkMonthLevelDates([{ company: 'X', period: 'January 2020 – Present' }]), [], 'period is read like dates');
  assert.deepEqual(verifyStructure({ experience: dated }, cvMd), { verdict: 'pass', orderViolations: [], descriptorViolations: [], dateViolations: [] });
});

test('year-only and missing dates are named per company and turn the verdict to warn', () => {
  const violations = checkMonthLevelDates([{ company: 'Acme Corp', dates: '2023 – Present' }, { company: 'Beta Industries' }]);
  assert.equal(violations.length, 2);
  assert.match(violations[0], /^Acme Corp: dates "2023 – Present" are not month-level/);
  assert.match(violations[1], /^Beta Industries: no dates given/);
  const result = verifyStructure({ experience: [{ ...dated[0], dates: '2023 – 2025' }, dated[1]] }, cvMd);
  assert.equal(result.verdict, 'warn');
  assert.equal(result.dateViolations.length, 1);
  assert.deepEqual(result.orderViolations, []);
});

test('date violations are reported even when cv.md has no recognised headers', () => {
  const result = verifyStructure({ experience: [{ company: 'Acme Corp', dates: '2023' }] }, 'Worked somewhere.');
  assert.equal(result.verdict, 'unverified');
  assert.equal(result.dateViolations.length, 1);
});

test('the CLI prints the date warning and still exits 0', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'verify-cv-structure-dates-'));
  try {
    writeFileSync(join(tmp, 'cv.md'), cvMd);
    const payload = join(tmp, 'payload.json');
    writeFileSync(payload, JSON.stringify({ experience: [{ ...dated[0], dates: '2023 – Present' }, dated[1]] }));
    const run = spawnSync(process.execPath, [join(ROOT, 'verify-cv-structure.mjs'), payload, '--source', 'cv.md'], { encoding: 'utf-8', env: { ...process.env, CAREER_OPS_ROOT: tmp } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /Experience entries without month-level dates/);
    assert.match(run.stderr, /Acme Corp: dates "2023 – Present" are not month-level/);
    writeFileSync(payload, JSON.stringify({ experience: dated }));
    const clean = spawnSync(process.execPath, [join(ROOT, 'verify-cv-structure.mjs'), payload, '--source', 'cv.md'], { encoding: 'utf-8', env: { ...process.env, CAREER_OPS_ROOT: tmp } });
    assert.equal(clean.status, 0);
    assert.match(clean.stdout, /CV structure check passed/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
