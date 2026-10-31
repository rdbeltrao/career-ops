import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('uncapped coverage retries failures, resumes only pending boards and keeps labeled undated matches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-coverage-e2e-'));
  try {
    fs.mkdirSync(path.join(root, 'data/cache/ats-companies'), { recursive: true });
    fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: [Engineer]\n');
    const companies = ['missing', 'retry', 'outage', 'undated', 'stale', ...Array.from({ length: 155 }, (_, i) => `company-${i}`)];
    fs.writeFileSync(path.join(root, 'data/cache/ats-companies/greenhouse.json'), JSON.stringify(companies));
    const scanner = path.join(codeRoot, 'scan-ats-full.mjs');
    const launcher = path.join(root, 'launch.mjs');
    fs.writeFileSync(launcher, `
      import fs from 'node:fs';
      import greenhouse from ${JSON.stringify(pathToFileURL(path.join(codeRoot, 'providers/greenhouse.mjs')).href)};
      const calls = {};
      globalThis.fetch = async (url) => {
        const slug = new URL(url).pathname.slice(1);
        calls[slug] = (calls[slug] || 0) + 1;
        fs.writeFileSync(${JSON.stringify(path.join(root, 'calls.json'))}, JSON.stringify(calls));
        const status = slug === 'missing' ? 404 : slug === 'retry' && calls[slug] === 1 ? 503 : slug === 'outage' && process.env.FIX_OUTAGE !== '1' ? 503 : 200;
        const jobs = ['undated', 'stale'].includes(slug) ? [{ company:slug, title:'Engineer', url:'https://job-boards.greenhouse.io/'+slug+'/jobs/1', location:'Remote', ...(slug === 'stale' ? { postedAt:1 } : {}) }] : [];
        return new Response(JSON.stringify(jobs), { status, headers:{'content-type':'application/json'} });
      };
      greenhouse.fetchListing = (entry, ctx) => ctx.fetchJson('https://fixture.test/'+entry.name);
      greenhouse.fetch = (entry, ctx) => ctx.fetchJson('https://fixture.test/'+entry.name);
      process.argv[1] = ${JSON.stringify(scanner)};
      await import(${JSON.stringify(pathToFileURL(scanner).href)});
    `);
    const sweep = (fixed = false) => {
      const result = spawnSync(process.execPath, [launcher, '--ats', 'greenhouse', '--since', '14', '--coverage-state', 'data/cache/coverage.json', '--include-undated', '--json'], {
        encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_PORTALS: '', CAREER_OPS_PIPELINE: '', CAREER_OPS_SCAN_HISTORY: '', CAREER_OPS_TRACKER: '', CAREER_OPS_NO_AUTO_JEV: '1', CAREER_OPS_TRUST_PROXY_EGRESS: '0', FIX_OUTAGE: fixed ? '1' : '0' },
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const first = sweep();
    assert.equal(first.companiesScanned, 160);
    assert.equal(first.capHit, false);
    assert.equal(first.coverage.remaining, 1);
    assert.equal(first.missingBoards, 1);
    assert.equal(first.unreachableBoards, 1);
    assert.equal(first.postingsDroppedNoDate, 0);
    assert.equal(first.postingsKept, 1, 'known stale posting still excluded');
    assert.equal(first.postingsKeptUndated, 1);
    const calls = JSON.parse(fs.readFileSync(path.join(root, 'calls.json')));
    assert.equal(calls.retry, 2, 'transient request recovered in the same run');
    assert.equal(calls.missing, 1, 'missing board is not retried');
    assert.match(fs.readFileSync(path.join(root, 'data/pipeline.md'), 'utf8'), /Posting date unknown; freshness not verified/);
    const second = sweep(true);
    assert.equal(second.companiesScanned, 1);
    assert.equal(second.coverage.remaining, 0);
    assert.equal(second.coverage.companiesCompleted, 160);
    assert.equal(second.postingsKept, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'calls.json'))), { outage: 1 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
