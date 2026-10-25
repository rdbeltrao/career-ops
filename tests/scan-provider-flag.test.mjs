// tests/scan-provider-flag.test.mjs — `scan.mjs --provider <id>` scans only the
// targets whose resolved provider has that id.
//
// The web schedules use it to run the LinkedIn searches on their own
// (`--provider linkedin-browser`). The fixture is a local-parser board, so the
// scan runs offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function scan(args, extra = '') {
  const dir = mkdtempSync(join(tmpdir(), 'scan-provider-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
    writeFileSync(join(dir, 'data', 'pipeline.md'), '# Pipeline\n\n');
    const portals = join(dir, 'portals.yml');
    writeFileSync(portals, `title_filter:
  positive:
    - "Backend"
tracked_companies:
  - name: Fixture Feed
    careers_url: https://t.me/s/fixturejobs
    parser:
      command: node
      script: tests/fixtures/same-title-board.mjs
${extra}`);
    const r = spawnSync(process.execPath, [join(ROOT, 'scan.mjs'), ...args], {
      cwd: dir,
      env: { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_PORTALS: portals },
      encoding: 'utf-8',
    });
    const p = join(dir, 'data', 'pipeline.md');
    const entries = existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter((l) => /^- \[[ x]\]\s+https?:\/\//.test(l)) : [];
    return { ...r, entries };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('--provider keeps the targets of that provider', () => {
  const r = scan(['--provider', 'local-parser']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.entries.length > 0, `want pipeline entries, got none\n${r.stdout}\n${r.stderr}`);
});

test('--provider drops every other target', () => {
  const r = scan(['--provider', 'linkedin-browser']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.entries.length, 0);
  assert.match(r.stdout, /Scanning 0 companies/);
});

test('--provider with an id no provider has stops with the known ids', () => {
  const r = scan(['--provider', 'no-such-provider']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no-such-provider/);
  assert.match(r.stderr, /greenhouse/);
  assert.equal(r.entries.length, 0);
});

test('--help documents --provider', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scan.mjs'), '--help'], { encoding: 'utf-8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--provider/);
});

test('--provider: entries of other providers add no skip count', () => {
  // A company no provider claims counts as skipped in a full scan...
  const unclaimed = '  - name: Nobody Reads Me\n    careers_url: https://unclaimed.example/careers\n';
  assert.match(scan(['--dry-run'], unclaimed).stdout, /1 skipped — no provider matched/);
  // ...and is simply not part of a single-provider run.
  assert.match(scan(['--provider', 'local-parser', '--dry-run'], unclaimed).stdout, /0 skipped — no provider matched/);
});
