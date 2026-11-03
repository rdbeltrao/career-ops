import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { recordBoardFailure, recordBoardResult, shouldSkipDeadBoard } from '../dead-boards.mjs';

const now = Date.parse('2026-11-03T12:00:00Z');
const day = 86_400_000;

test('410 and mixed missing responses quarantine only after three misses and recheck after 30 days', () => {
  for (const statuses of [[410, 410, 410], [404, 410, 404]]) {
    const rows = new Map();
    statuses.forEach((status, index) => {
      recordBoardFailure(rows, 'lever', 'gone', { status, firstPage: true }, now + index * day);
      assert.equal(shouldSkipDeadBoard(rows, 'lever', 'gone', now + index * day), index === 2);
    });
    assert.equal(shouldSkipDeadBoard(rows, 'lever', 'gone', now + 31 * day), true);
    assert.equal(shouldSkipDeadBoard(rows, 'lever', 'gone', now + 32 * day), false);
    recordBoardResult(rows, 'lever', 'gone', 200, now + 32 * day);
    assert.equal(shouldSkipDeadBoard(rows, 'lever', 'gone', now + 32 * day), false);
    assert.equal(rows.size, 0);
  }
});

test('transient and later-page failures never retire a board', () => {
  for (const error of [{ status: 429 }, { status: 503 }, new Error('timeout'), { status: 410, firstPage: false }]) {
    const rows = new Map();
    for (let i = 0; i < 3; i++) recordBoardFailure(rows, 'lever', 'live', error, now);
    assert.equal(shouldSkipDeadBoard(rows, 'lever', 'live', now), false);
    assert.equal(rows.size, 0);
    recordBoardFailure(rows, 'lever', 'live', { status: 410 }, now);
    recordBoardFailure(rows, 'lever', 'live', { status: 410 }, now);
    recordBoardFailure(rows, 'lever', 'live', error, now);
    recordBoardFailure(rows, 'lever', 'live', { status: 410 }, now);
    assert.equal(shouldSkipDeadBoard(rows, 'lever', 'live', now), false);
  }
});

test('successive scanner cycles persist 404/410 quarantine and report skipped boards separately', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-missing-quarantine-'));
  const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const scanner = path.join(codeRoot, 'scan-ats-full.mjs');
  try {
    fs.mkdirSync(path.join(root, 'data/cache/ats-companies'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/cache/ats-companies/greenhouse.json'), JSON.stringify(['missing', 'gone', 'healthy']));
    fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: [Engineer]\n');
    const callsFile = path.join(root, 'calls.json');
    const launcher = path.join(root, 'launch.mjs');
    fs.writeFileSync(launcher, `
      import fs from 'node:fs';
      import greenhouse from ${JSON.stringify(pathToFileURL(path.join(codeRoot, 'providers/greenhouse.mjs')).href)};
      const calls = [];
      greenhouse.fetchListing = async (entry) => {
        calls.push(entry.name);
        fs.writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls));
        if (entry.name !== 'healthy') throw Object.assign(new Error('missing board'), { status: entry.name === 'gone' ? 410 : 404 });
        return [];
      };
    `);
    for (let run = 0; run < 4; run++) {
      const result = spawnSync(process.execPath, ['--import', launcher, scanner, '--ats', 'greenhouse', '--coverage-state', 'data/cache/coverage.json', '--json'], {
        encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_PORTALS: '', CAREER_OPS_PIPELINE: '', CAREER_OPS_SCAN_HISTORY: '', CAREER_OPS_TRACKER: '', CAREER_OPS_NO_AUTO_JEV: '1' },
      });
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.coverage.remaining, 0);
      assert.equal(receipt.unreachableBoards, 0);
      assert.equal(receipt.missingBoards, run < 3 ? 2 : 0);
      assert.equal(receipt.retiredBoardsSkipped, run < 3 ? 0 : 2);
      assert.equal(receipt.companiesScanned, run < 3 ? 3 : 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(callsFile)).sort(), run < 3 ? ['gone', 'healthy', 'missing'] : ['healthy']);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
