// tests/openrouter-key.test.mjs — lib/openrouter-key.mjs resolves the OpenRouter
// key in one documented order and names where it came from.
//
// Order (contract C2 of the job-hunt consolidation plan): the process
// environment, `.env` in the code checkout, `.env` in the data root, then the
// macOS Keychain, each tried for OPENROUTER_API_KEY_JOB_SEARCH before
// OPENROUTER_API_KEY. The Keychain is injected here so no test spawns
// `security` or reads a real key.
//
// Run: node --test tests/openrouter-key.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENROUTER_KEY_NAMES, parseDotEnv, resolveOpenRouterKey } from '../lib/openrouter-key.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'openrouter-key-'));
const noKeychain = () => null;

test('env wins and names its source', () => {
  const r = resolveOpenRouterKey({ env: { OPENROUTER_API_KEY: 'k1' }, codeRoot: tmp(), dataRoot: tmp(), keychain: noKeychain });
  assert.deepEqual(r, { key: 'k1', source: 'env' });
});

test('OPENROUTER_API_KEY_JOB_SEARCH beats OPENROUTER_API_KEY', () => {
  const env = { OPENROUTER_API_KEY: 'k1', OPENROUTER_API_KEY_JOB_SEARCH: 'k2' };
  const r = resolveOpenRouterKey({ env, codeRoot: tmp(), dataRoot: tmp(), keychain: noKeychain });
  assert.deepEqual(r, { key: 'k2', source: 'env' });
  assert.deepEqual(OPENROUTER_KEY_NAMES, ['OPENROUTER_API_KEY_JOB_SEARCH', 'OPENROUTER_API_KEY']);
});

test('a blank env value does not count as a key', () => {
  const codeRoot = tmp();
  writeFileSync(join(codeRoot, '.env'), 'OPENROUTER_API_KEY=from-code\n');
  const r = resolveOpenRouterKey({ env: { OPENROUTER_API_KEY: '   ' }, codeRoot, dataRoot: tmp(), keychain: noKeychain });
  assert.deepEqual(r, { key: 'from-code', source: 'code-env' });
});

test('code-root .env is read before data-root .env', () => {
  const codeRoot = tmp();
  const dataRoot = tmp();
  writeFileSync(join(codeRoot, '.env'), '# comment\nOPENROUTER_API_KEY="from-code"\n');
  writeFileSync(join(dataRoot, '.env'), 'OPENROUTER_API_KEY_JOB_SEARCH=from-data\n');
  const r = resolveOpenRouterKey({ env: {}, codeRoot, dataRoot, keychain: noKeychain });
  assert.deepEqual(r, { key: 'from-code', source: 'code-env' });
});

test('data-root .env is read when the code root has no key', () => {
  const codeRoot = tmp();
  const dataRoot = tmp();
  writeFileSync(join(codeRoot, '.env'), 'CAREER_OPS_CLI=claude\n');
  writeFileSync(join(dataRoot, '.env'), "OPENROUTER_API_KEY='from-data'\n");
  const r = resolveOpenRouterKey({ env: {}, codeRoot, dataRoot, keychain: noKeychain });
  assert.deepEqual(r, { key: 'from-data', source: 'data-env' });
});

test('keychain is last and is asked for both names', () => {
  const asked = [];
  const keychain = (name) => {
    asked.push(name);
    return name === 'OPENROUTER_API_KEY' ? 'from-keychain' : null;
  };
  const r = resolveOpenRouterKey({ env: {}, codeRoot: tmp(), dataRoot: tmp(), keychain });
  assert.deepEqual(r, { key: 'from-keychain', source: 'keychain' });
  assert.deepEqual(asked, ['OPENROUTER_API_KEY_JOB_SEARCH', 'OPENROUTER_API_KEY']);
});

test('the keychain is not consulted when a .env file answers', () => {
  const dataRoot = tmp();
  writeFileSync(join(dataRoot, '.env'), 'OPENROUTER_API_KEY=from-data\n');
  let asked = 0;
  const r = resolveOpenRouterKey({ env: {}, codeRoot: tmp(), dataRoot, keychain: () => { asked += 1; return 'x'; } });
  assert.equal(r.source, 'data-env');
  assert.equal(asked, 0);
});

test('CAREER_OPS_SKIP_KEYCHAIN in the env skips the keychain lookup', () => {
  let asked = 0;
  const r = resolveOpenRouterKey({
    env: { CAREER_OPS_SKIP_KEYCHAIN: '1' },
    codeRoot: tmp(),
    dataRoot: tmp(),
    keychain: () => { asked += 1; return 'x'; },
  });
  assert.deepEqual(r, { key: null, source: 'none' });
  assert.equal(asked, 0);
});

test('nothing found returns null and source none', () => {
  const r = resolveOpenRouterKey({ env: {}, codeRoot: tmp(), dataRoot: tmp(), keychain: noKeychain });
  assert.deepEqual(r, { key: null, source: 'none' });
});

test('missing roots are tolerated', () => {
  const r = resolveOpenRouterKey({ env: {}, keychain: noKeychain });
  assert.deepEqual(r, { key: null, source: 'none' });
});

test('parseDotEnv reads the same shape openrouter-runner does', () => {
  const vars = parseDotEnv([
    '# a comment',
    'OPENROUTER_API_KEY=plain',
    'QUOTED="with quotes"',
    "SINGLE='single'",
    'lowercase=ignored',
    'SPACED = not matched',
    'EMPTY=',
    '',
  ].join('\n'));
  assert.deepEqual(vars, { OPENROUTER_API_KEY: 'plain', QUOTED: 'with quotes', SINGLE: 'single', EMPTY: '' });
});
