// tests/publish-cv.test.mjs — publish-cv.mjs treats unsourced advisory facts as a
// publication block unless the caller passes --allow-warnings.
//
// A diagnostic of 45 sent applications found tailored CVs shipped while the
// fact gate had printed warnings nobody read. The CLI is now strict by default
// and keeps an explicit escape; the end-to-end render path has its own
// Chromium coverage in tests/cv-publication.test.mjs.
//
// Run:  node --test tests/publish-cv.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFactGate, parsePublishArgs } from '../publish-cv.mjs';

const warned = { verdict: 'warn', warnings: ['around'], advisoryFacts: [{ kind: 'adoption', value: 'used daily', line: 'Tooling used daily by the team' }], coverage: null };

test('unsourced advisory facts block publication by default and the error names every warning', () => {
  assert.throws(() => assertFactGate(warned), error => {
    assert.match(error.message, /unsourced advisory facts/);
    assert.match(error.message, /--allow-warnings/);
    assert.match(error.message, /advisory phrase: around/);
    assert.match(error.message, /unsourced adoption claim: used daily/);
    return true;
  });
  assert.throws(() => assertFactGate(warned, { allowWarnings: false }));
  const printed = [];
  const hedgeOnly = { verdict: 'warn', warnings: ['about'], advisoryFacts: [], coverage: { reason: 'scope-not-checked', message: 'non-English CV', spans: [] } };
  assert.doesNotThrow(() => assertFactGate(hedgeOnly, { print: line => printed.push(line) }), 'hedge words and coverage notes are printed, never a block');
  assert.ok(printed.some(line => line.includes('about')));
});

test('--allow-warnings prints the warnings instead of throwing; pass and block verdicts are untouched', () => {
  const printed = [];
  assert.doesNotThrow(() => assertFactGate(warned, { allowWarnings: true, print: line => printed.push(line) }));
  assert.ok(printed.some(line => line.includes('advisory phrase: around')));
  assert.doesNotThrow(() => assertFactGate({ verdict: 'pass', warnings: [], advisoryFacts: [], coverage: null }));
  assert.doesNotThrow(() => assertFactGate({ verdict: 'block' }), 'a block is thrown by assertFacts before this helper runs');
});

test('the CLI is strict by default, accepts --strict explicitly and --allow-warnings as the escape', () => {
  const base = ['--html=a.html', '--payload=a.json', '--pdf=a.pdf', '--report=12'];
  assert.equal(parsePublishArgs(base).allowWarnings, false);
  assert.equal(parsePublishArgs([...base, '--strict']).allowWarnings, false);
  assert.equal(parsePublishArgs([...base, '--allow-warnings']).allowWarnings, true);
  assert.throws(() => parsePublishArgs([...base, '--strict', '--allow-warnings']), /--strict and --allow-warnings/);
  assert.throws(() => parsePublishArgs([...base, '--loud']), /Unknown option: --loud/);
  assert.throws(() => parsePublishArgs([...base, '--allow-warnings=yes']), /Unknown option/);
  assert.deepEqual(parsePublishArgs([...base, '--format=a4']), { html: 'a.html', payload: 'a.json', pdf: 'a.pdf', report: '12', format: 'a4', allowWarnings: false });
});
