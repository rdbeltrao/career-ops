import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { configuredExcludedBoards, filterFingerprints } from '../scan-ats-full.mjs';

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('board exclusions are explicit HTTPS URLs and participate in legacy checkpoint fingerprints', () => {
  const config = { full_scan: { excluded_boards: ['https://ACME.wd5.myworkdayjobs.com/private/?tracking=ignored#section'] } };
  assert.deepEqual([...configuredExcludedBoards(config)], ['https://acme.wd5.myworkdayjobs.com/private']);
  assert.ok(filterFingerprints(config).full_scan_excluded_boards);
  assert.equal(filterFingerprints({}).full_scan_excluded_boards, undefined);
  for (const value of ['private', ['https://user:password@example.test/board'], ['http://example.test/board'], [null]]) {
    assert.throws(() => configuredExcludedBoards({ full_scan: { excluded_boards: value } }), /credential-free HTTPS/);
  }
});

test('excluding a pending board preserves completed coverage and also excludes its history seed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-board-exclusion-'));
  try {
    fs.mkdirSync(path.join(root, 'data/cache/ats-companies'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/cache/ats-companies/workday.json'), JSON.stringify(['acme|wd5|careers', 'acme|wd5|private']));
    const portals = path.join(root, 'portals.yml');
    fs.writeFileSync(portals, 'title_filter:\n  positive: [Engineer]\n');
    fs.writeFileSync(path.join(root, 'data/scan-history.tsv'), 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\nhttps://acme.wd5.myworkdayjobs.com/private/job/Remote/Role_R1\t2026-09-01\tworkday\tEngineer\tAcme\tadded\tRemote\n');
    const calls = path.join(root, 'calls.json'), preload = path.join(root, 'preload.mjs');
    fs.writeFileSync(preload, `
      import fs from 'node:fs';
      import workday from ${JSON.stringify(pathToFileURL(path.join(codeRoot, 'providers/workday.mjs')).href)};
      const calls = [];
      workday.fetch = async entry => {
        calls.push(entry.careers_url); fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify(calls));
        if (entry.careers_url.endsWith('/private')) throw Object.assign(new Error('HTTP 502'), { status: 502 });
        return [];
      };
    `);
    const run = () => {
      fs.writeFileSync(calls, '[]');
      const result = spawnSync(process.execPath, ['--import', preload, path.join(codeRoot, 'scan-ats-full.mjs'), '--ats', 'workday', '--since', '14', '--coverage-state', 'data/cache/coverage.json', '--history-seeds', '--include-undated', '--json'], {
        encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_PORTALS: '', CAREER_OPS_PIPELINE: '', CAREER_OPS_SCAN_HISTORY: '', CAREER_OPS_TRACKER: '', CAREER_OPS_NO_AUTO_JEV: '1' },
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const first = run();
    assert.equal(first.coverage.companiesTotal, 2);
    assert.equal(first.coverage.companiesCompleted, 1);
    assert.equal(first.coverage.remaining, 1);
    fs.appendFileSync(portals, '\nfull_scan:\n  excluded_boards:\n    - https://acme.wd5.myworkdayjobs.com/private\n');
    const second = run();
    assert.equal(second.coverage.companiesTotal, 1);
    assert.equal(second.coverage.companiesCompleted, 1);
    assert.equal(second.coverage.remaining, 0);
    assert.equal(second.companiesScanned, 0, 'completed boards are retained, not reset by a scope change');
    assert.equal(second.boardsExcludedByConfig, 1);
    assert.equal(second.unreachableBoards, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(calls)), [], 'history must not bypass the saved exclusion');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
