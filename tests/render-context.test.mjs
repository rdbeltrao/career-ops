// tests/render-context.test.mjs — the targeting blocks of config/profile.yml
// (preferences, interests, dealbreakers) are documented in the example, so
// validate-profile.mjs accepts them, and render-context.mjs prints them as
// markdown with a STALE marker once confirmed_on is older than 90 days.
//
// Run:  node --test tests/render-context.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { knownKeysFromExample, EXAMPLE_PATH } = await import(pathToFileURL(join(ROOT, 'validate-profile.mjs')).href);
const { isStale, renderContext, STALE_DAYS } = await import(pathToFileURL(join(ROOT, 'render-context.mjs')).href);

const EXAMPLE = readFileSync(EXAMPLE_PATH, 'utf-8');
const TODAY = '2026-10-24';

const PROFILE = {
  dealbreakers: ['German required', 'Contractor engagement'],
  preferences: {
    confirmed_on: '2026-09-01',
    hard_rules: ['Employee contract only'],
    minus: ['Agency work'],
    neutral: ['Company size'],
    plus: ['Remote-first'],
    no_penalty: ['Travel up to 10%'],
  },
  interests: {
    recorded_on: '2025-01-01',
    confirmed_on: '2026-09-01',
    role_balance: 'about 75% people management, 25% hands-on',
    team_size: '6 to 10 engineers',
    team_type: ['customer-facing product teams'],
    domains: ['marketplaces', 'health'],
    ways_of_working: ['remote-first'],
    learning: ['AI-assisted engineering'],
  },
};

test('config/profile.example.yml documents preferences, interests and dealbreakers', () => {
  const keys = knownKeysFromExample(EXAMPLE);
  for (const key of ['preferences', 'interests', 'dealbreakers']) {
    assert.ok(keys.includes(key), `${key} is not a documented top-level key: ${keys.join(', ')}`);
  }
});

test('isStale: older than 90 days is stale, newer is not, unparseable is stale', () => {
  assert.equal(STALE_DAYS, 90);
  assert.equal(isStale('2026-01-01', TODAY), true);
  assert.equal(isStale('2026-09-01', TODAY), false);
  assert.equal(isStale('2026-07-26', TODAY), false, 'exactly 90 days is still fresh');
  assert.equal(isStale('2026-07-25', TODAY), true, '91 days is stale');
  assert.equal(isStale(undefined, TODAY), true);
  assert.equal(isStale('yesterday', TODAY), true);
  assert.equal(isStale('2026-10-01', TODAY, 7), true, 'the window is a parameter');
});

test('renderContext prints the three sections and no STALE marker for fresh dates', () => {
  const out = renderContext(PROFILE, { today: TODAY });
  assert.match(out, /^## Preferences \(confirmed 2026-09-01\)$/m);
  assert.match(out, /^## Interests \(recorded 2025-01-01, confirmed 2026-09-01\)$/m);
  assert.match(out, /^## Hard DQ$/m);
  assert.doesNotMatch(out, /STALE/);
  for (const line of ['- Employee contract only', '- Agency work', '- Company size', '- Remote-first', '- Travel up to 10%']) {
    assert.ok(out.includes(line), `missing preference line: ${line}`);
  }
  assert.match(out, /Role balance: about 75% people management, 25% hands-on/);
  assert.match(out, /Domains: marketplaces, health/);
});

test('renderContext marks only the stale block as STALE', () => {
  const stalePrefs = { ...PROFILE, preferences: { ...PROFILE.preferences, confirmed_on: '2026-01-01' } };
  const out = renderContext(stalePrefs, { today: TODAY });
  assert.match(out, /^## Preferences \(confirmed 2026-01-01, STALE: reconfirm before deciding\)$/m);
  assert.match(out, /^## Interests \(recorded 2025-01-01, confirmed 2026-09-01\)$/m);

  const noDate = { ...PROFILE, interests: { ...PROFILE.interests, confirmed_on: undefined } };
  const out2 = renderContext(noDate, { today: TODAY });
  assert.match(out2, /^## Interests \(recorded 2025-01-01, confirmed_on not set, STALE: reconfirm before deciding\)$/m);
});

test('## Hard DQ lists every dealbreaker and every preferences.hard_rules entry, once', () => {
  const out = renderContext(PROFILE, { today: TODAY });
  const dq = out.split('## Hard DQ')[1];
  assert.ok(dq, 'no Hard DQ section');
  for (const rule of ['German required', 'Contractor engagement', 'Employee contract only']) {
    assert.equal((dq.match(new RegExp(`^- ${rule}$`, 'gm')) ?? []).length, 1, `${rule} should appear exactly once`);
  }
});

test('absent blocks render a placeholder instead of throwing', () => {
  const out = renderContext({}, { today: TODAY });
  assert.match(out, /^## Preferences$/m);
  assert.match(out, /no preferences block/);
  assert.match(out, /^## Hard DQ$/m);
  assert.match(out, /- \(none set/);
  assert.doesNotThrow(() => renderContext(null, { today: TODAY }));
});

test('CLI: --section dq prints only the Hard DQ section, from --profile and --today', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'render-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10 }));
  const profile = join(dir, 'profile.yml');
  writeFileSync(profile, [
    'candidate:',
    '  full_name: "Test Person"',
    'dealbreakers:',
    '  - "German required"',
    'preferences:',
    '  confirmed_on: "2026-01-01"',
    '  hard_rules: ["Employee contract only"]',
    '',
  ].join('\n'));
  const r = spawnSync(process.execPath, [join(ROOT, 'render-context.mjs'), '--profile', profile, '--today', TODAY, '--section', 'dq'], {
    cwd: ROOT, encoding: 'utf-8', timeout: 30_000,
    env: { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_DATA_DIR: '', CAREER_OPS_PROFILE: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^## Hard DQ$/m);
  assert.match(r.stdout, /^- German required$/m);
  assert.match(r.stdout, /^- Employee contract only$/m);
  assert.doesNotMatch(r.stdout, /## Preferences/);
  assert.doesNotMatch(r.stdout, /## Interests/);

  const all = spawnSync(process.execPath, [join(ROOT, 'render-context.mjs'), '--profile', profile, '--today', TODAY], {
    cwd: ROOT, encoding: 'utf-8', timeout: 30_000,
    env: { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_DATA_DIR: '', CAREER_OPS_PROFILE: '' },
  });
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /STALE: reconfirm before deciding/);

  const bad = spawnSync(process.execPath, [join(ROOT, 'render-context.mjs'), '--profile', profile, '--section', 'nope'], {
    cwd: ROOT, encoding: 'utf-8', timeout: 30_000,
  });
  assert.notEqual(bad.status, 0, 'an unknown --section must be a usage error');

  const missing = spawnSync(process.execPath, [join(ROOT, 'render-context.mjs'), '--profile', join(dir, 'absent.yml')], {
    cwd: ROOT, encoding: 'utf-8', timeout: 30_000,
  });
  assert.equal(missing.status, 1, 'a missing profile exits 1');
  assert.match(missing.stderr, /no profile at/);
});

test('validate-profile.mjs --help still works', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'validate-profile.mjs'), '--help'], { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: node validate-profile\.mjs/);
});
