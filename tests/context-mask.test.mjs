// tests/context-mask.test.mjs — lib/context-evidence.mjs masks every quantity
// in modes/_context.md before an evaluator sees it, and keeps dates, years,
// identifiers and versions. The number rule of the context tier (AGENTS.md,
// Source-of-Truth Boundary) is enforced here, not asked of the model.
//
// Run:  node --test tests/context-mask.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MASK, maskContextNumbers, readMaskedContext } from '../lib/context-evidence.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const m = maskContextNumbers;

test('integers, thousands separators and decimals become [n]', () => {
  assert.equal(m('a team of 9 engineers'), `a team of ${MASK} engineers`);
  assert.equal(m('scaled to over 1,000 stores'), `scaled to over ${MASK} stores`);
  assert.equal(m('CI p50 from 24 to 5.5 minutes'), `CI p50 from ${MASK} to ${MASK} minutes`);
  assert.equal(m('App Store rating from 3.3 to 4.9'), `App Store rating from ${MASK} to ${MASK}`);
  assert.equal(m('sub-200 ms API responses'), `sub-${MASK} ms API responses`);
});

test('percentages keep the unit and lose the value', () => {
  assert.equal(m('coverage from about 14% to 59%'), `coverage from about ${MASK}% to ${MASK}%`);
  assert.equal(m('90%+ developer retention'), `${MASK}%+ developer retention`);
  assert.equal(m('99.95% uptime'), `${MASK}% uptime`);
  assert.equal(m('change failure rate down over 40 %'), `change failure rate down over ${MASK}% `.trimEnd());
});

test('currency and magnitude suffixes are masked as one quantity', () => {
  assert.equal(m('supported a EUR 2 million seed round'), `supported a EUR ${MASK} seed round`);
  assert.equal(m('budget of €1.2M and $300k'), `budget of € ${MASK} and $ ${MASK}`);
  assert.equal(m('80-90k EUR base'), `${MASK} EUR base`);
  assert.equal(m('2 million users'), `${MASK} users`);
});

test('ranges, approximations, multipliers and ordinals', () => {
  assert.equal(m('a product team of 6 to 10'), `a product team of ${MASK} to ${MASK}`);
  assert.equal(m('a group of 2-5 teams'), `a group of ${MASK} teams`);
  assert.equal(m('about 20 developers, ~10 engineers'), `about ${MASK} developers, ${MASK} engineers`);
  assert.equal(m('throughput about 2.6x'), `throughput about ${MASK}x`);
  assert.equal(m('the 1st pilot store'), `the ${MASK} pilot store`);
});

test('number words from one to twenty, the tens and the magnitudes are masked', () => {
  assert.equal(m('five engineering teams'), `${MASK} engineering teams`);
  assert.equal(m('Four publications; nine engineers in two distributed teams'), `${MASK} publications; ${MASK} engineers in ${MASK} distributed teams`);
  assert.equal(m('Twelve years, eighteen months, forty people, a hundred stores, a dozen projects'),
    `${MASK} years, ${MASK} months, ${MASK} people, a ${MASK} stores, a ${MASK} projects`);
  assert.equal(m('more than ten fixed-scope projects'), `more than ${MASK} fixed-scope projects`);
});

test('dates, years and times are preserved', () => {
  assert.equal(m('Preferences confirmed by Renato on 2026-10-17'), 'Preferences confirmed by Renato on 2026-10-17');
  assert.equal(m('confirmed_on: 2026-07-01'), 'confirmed_on: 2026-07-01');
  assert.equal(m('April 2023 to November 2025, Berlin'), 'April 2023 to November 2025, Berlin');
  assert.equal(m('04/2023 – 11/2025'), '04/2023 – 11/2025');
  assert.equal(m('17/10/2026 and 2026-10'), '17/10/2026 and 2026-10');
  assert.equal(m('BSc 2012 to 2018; four publications in 2013'), `BSc 2012 to 2018; ${MASK} publications in 2013`);
  assert.equal(m('standup at 09:30, on-call 24/7'), 'standup at 09:30, on-call 24/7');
  assert.equal(m('weekly 1:1s and quarterly reviews'), 'weekly 1:1s and quarterly reviews');
});

test('identifiers and version numbers are preserved where they are not quantities', () => {
  assert.equal(m('p50 latency, EX-01 to EX-05, S3, B2B SaaS, Q4 planning, OAuth2'), 'p50 latency, EX-01 to EX-05, S3, B2B SaaS, Q4 planning, OAuth2');
  assert.equal(m('PHP (Symfony 6.4), Vue 3, Node.js 22.1, v1.2.3'), 'PHP (Symfony 6.4), Vue 3, Node.js 22.1, v1.2.3');
  assert.equal(m('one of the leads; one-on-one; no one; one another'), 'one of the leads; one-on-one; no one; one another');
  // A single digit after a product name is a version; after a plain word it is a count.
  assert.equal(m('led 3 teams'), `led ${MASK} teams`);
});

test('the mask is idempotent and leaves text without quantities untouched', () => {
  const plain = '## Technical profile\n\n- Core: PHP, TypeScript, Vue.js, Node.js, SQL.\n';
  assert.equal(m(plain), plain);
  const once = m('Scope grew from two teams to five; about 20 developers; EUR 2 million.');
  assert.equal(m(once), once);
  assert.equal(m(''), '');
});

test('readMaskedContext reads the data root file masked, raw on request, null when absent', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-mask-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }));
  assert.equal(readMaskedContext(root), null);
  mkdirSync(join(root, 'modes'));
  writeFileSync(join(root, 'modes', '_context.md'), '﻿# Fit profile\n\nFive teams, about 20 developers, since 2025-11-01.\n');
  const masked = readMaskedContext(root);
  assert.equal(masked.masked, true);
  assert.equal(masked.text, `# Fit profile\n\n${MASK} teams, about ${MASK} developers, since 2025-11-01.`);
  const raw = readMaskedContext(root, { raw: true });
  assert.equal(raw.masked, false);
  assert.match(raw.text, /Five teams, about 20 developers/);
});

test('node context-evidence.mjs prints the masked file with the notice, --raw without, exit 1 when absent', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }));
  const cli = join(ROOT, 'context-evidence.mjs');
  const env = { ...process.env, CAREER_OPS_ROOT: root };
  delete env.CAREER_OPS_DATA_DIR;
  const absent = spawnSync(process.execPath, [cli], { encoding: 'utf-8', env });
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /modes\/_context\.md not found/);
  mkdirSync(join(root, 'modes'));
  writeFileSync(join(root, 'modes', '_context.md'), '# Fit profile\n\nNine engineers in two teams since 2021.\n');
  const masked = spawnSync(process.execPath, [cli], { encoding: 'utf-8', env });
  assert.equal(masked.status, 0, masked.stderr);
  assert.match(masked.stdout, /^<!-- Numbers in this context are masked as \[n\]/);
  assert.match(masked.stdout, new RegExp(`\\${MASK} engineers in \\${MASK} teams since 2021`));
  const raw = spawnSync(process.execPath, [cli, '--raw', '--no-notice'], { encoding: 'utf-8', env });
  assert.equal(raw.stdout, '# Fit profile\n\nNine engineers in two teams since 2021.\n');
  const byFile = spawnSync(process.execPath, [cli, '--file', join(root, 'modes', '_context.md'), '--no-notice'], { encoding: 'utf-8', env: { ...env, CAREER_OPS_ROOT: join(root, 'nowhere') } });
  assert.equal(byFile.status, 0, byFile.stderr);
  assert.equal(byFile.stdout, `# Fit profile\n\n${MASK} engineers in ${MASK} teams since 2021.\n`);
  const bad = spawnSync(process.execPath, [cli, '--bogus'], { encoding: 'utf-8', env });
  assert.equal(bad.status, 1);
});

test('the real context file, when present, masks every quantity the dry runs leaked', async () => {
  const { getCareerOpsRoot } = await import(pathToFileURL(join(ROOT, 'path-resolver.mjs')).href);
  const found = readMaskedContext(getCareerOpsRoot());
  if (!found) return;
  for (const leak of [/\b20 developers/, /\b9 to 10 engineers/, /\bfive\b/i, /\b2\.6x/, /\b4\.9\b/, /\b1,000\b/, /\b99\.95/]) {
    assert.ok(!leak.test(found.text), `masked context still contains ${leak}`);
  }
});
