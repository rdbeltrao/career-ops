import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openScanCoverage } from '../lib/scan-coverage.mjs';

test('coverage resumes pending boards and reconciles directory changes without repeating completed boards', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-coverage-'));
  const file = path.join(root, 'coverage.json');
  let coverage;
  try {
    coverage = await openScanCoverage(file, 'filters');
    coverage.register('greenhouse', ['a', 'b', 'c']);
    coverage.done('greenhouse', 'a');
    coverage.save(); coverage.close();
    coverage = await openScanCoverage(file, 'filters');
    coverage.register('greenhouse', ['a', 'b', 'd']);
    assert.equal(coverage.pending('greenhouse', 'a'), false);
    assert.equal(coverage.pending('greenhouse', 'b'), true);
    assert.equal(coverage.pending('greenhouse', 'd'), true);
    assert.equal(coverage.summary().remaining, 2);
    coverage.done('greenhouse', 'b'); coverage.done('greenhouse', 'd');
    coverage.save(); coverage.close();
    coverage = await openScanCoverage(file, 'filters');
    coverage.register('greenhouse', ['a', 'b', 'd']);
    assert.equal(coverage.summary().companiesCompleted, 0, 'completed cycle starts a fresh sweep');
  } finally { coverage?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('filter changes reset progress and unavailable datasets cannot complete a cycle', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-coverage-'));
  const file = path.join(root, 'coverage.json');
  let coverage;
  try {
    coverage = await openScanCoverage(file, 'old');
    coverage.register('greenhouse', ['a', 'b']);
    coverage.done('greenhouse', 'a');
    coverage.save(); coverage.close();
    coverage = await openScanCoverage(file, 'new');
    coverage.register('greenhouse', ['a']);
    coverage.register('lever', [], 'empty');
    assert.equal(coverage.pending('greenhouse', 'a'), true);
    coverage.done('greenhouse', 'a'); coverage.save();
    assert.equal(JSON.parse(fs.readFileSync(file)).complete, false);
    assert.deepEqual(coverage.summary().sourcesUnavailable, ['lever']);
  } finally { coverage?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('corrupt coverage is an error and remains untouched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-coverage-'));
  const file = path.join(root, 'coverage.json');
  try {
    fs.writeFileSync(file, 'broken');
    await assert.rejects(openScanCoverage(file, 'filters'), SyntaxError);
    assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
    assert.equal(fs.existsSync(`${file}.lock`), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('permanent failures cannot starve healthy boards indefinitely', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-coverage-'));
  const file = path.join(root, 'coverage.json');
  let coverage;
  try {
    coverage = await openScanCoverage(file, 'filters');
    coverage.register('greenhouse', ['healthy', 'broken']);
    coverage.done('greenhouse', 'healthy'); coverage.save(); coverage.close();
    for (let i = 0; i < 3; i++) {
      coverage = await openScanCoverage(file, 'filters');
      coverage.register('greenhouse', ['healthy', 'broken']);
      assert.equal(coverage.pending('greenhouse', 'healthy'), false);
      assert.equal(coverage.pending('greenhouse', 'broken'), true);
      coverage.save(); coverage.close();
    }
    coverage = await openScanCoverage(file, 'filters');
    coverage.register('greenhouse', ['healthy', 'broken']);
    assert.equal(coverage.pending('greenhouse', 'healthy'), true);
    assert.equal(coverage.pending('greenhouse', 'broken'), true);
  } finally { coverage?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
