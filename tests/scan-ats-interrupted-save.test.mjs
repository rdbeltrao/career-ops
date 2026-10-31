import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { acquirePipelineLock } from '../pipeline-lock.mjs';

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const mode of ['save', 'dry-run', 'liveness', 'write-error', 'coverage', 'coverage-write-error', 'coverage-save-error', 'drain-during-save', 'signal-during-normal-save']) {
  const dryRun = mode === 'dry-run';
  const saveRace = mode === 'drain-during-save' || mode === 'signal-during-normal-save';
  test(`SIGTERM handles ${mode} without losing or falsely claiming saved matches`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-ops-interrupted-'));
    let pipelineLock;
    try {
      fs.mkdirSync(path.join(root, 'data/cache/ats-companies'), { recursive: true });
      fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: [Engineer]\n');
      fs.writeFileSync(path.join(root, 'data/cache/ats-companies/greenhouse.json'), JSON.stringify(['fixture-ready', 'fixture-slow']));
      if (saveRace) pipelineLock = await acquirePipelineLock(path.join(root, 'data/pipeline.md'));
      const scanner = path.join(codeRoot, 'scan-ats-full.mjs');
      const launcher = path.join(root, 'launch.mjs');
      fs.writeFileSync(launcher, `
        import greenhouse from ${JSON.stringify(pathToFileURL(path.join(codeRoot, 'providers/greenhouse.mjs')).href)};
        const job = { company:'Fixture', title:'Engineer', url:'https://job-boards.greenhouse.io/fixture-ready/jobs/1', location:'Remote', postedAt:Date.now() };
        greenhouse.fetchListing = async (entry) => {
          if (entry.name === 'fixture-slow') await ${saveRace ? 'new Promise(resolve => setTimeout(resolve, 100))' : 'new Promise(() => setInterval(() => {}, 1000))'};
          return [job];
        };
        greenhouse.fetch = async () => [job];
        process.argv[1] = ${JSON.stringify(scanner)};
        await import(${JSON.stringify(pathToFileURL(scanner).href)});
      `);
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [launcher, '--ats', 'greenhouse', '--json', ...(dryRun ? ['--dry-run'] : []), ...(mode === 'liveness' ? ['--liveness'] : []), ...(mode.startsWith('coverage') ? ['--coverage-state', 'data/cache/coverage.json'] : [])], {
          env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_PIPELINE: '', CAREER_OPS_TRACKER: '', CAREER_OPS_PORTALS: '', CAREER_OPS_NO_AUTO_JEV: '1', CAREER_OPS_CONNECTION_SCOPE: '0' },
        });
        let stdout = '', stderr = '', stopped = false;
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Fixture scanner hung: ${stderr}`)); }, 10_000);
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
          if (!stopped && stderr.includes('"kind":"offer"')) {
            stopped = true;
            if (mode.endsWith('write-error')) fs.mkdirSync(path.join(root, 'data/pipeline.md'));
            if (mode === 'coverage-save-error') fs.mkdirSync(path.join(root, 'data/cache/coverage.json'));
            if (mode === 'signal-during-normal-save') setTimeout(() => child.kill('SIGTERM'), 150);
            else child.kill('SIGTERM');
            if (saveRace) setTimeout(() => pipelineLock.release(), 450);
          }
        });
        child.on('error', reject);
        child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code, stopped }); });
      });
      assert.equal(result.stopped, true, result.stderr);
      if (mode.endsWith('write-error')) {
        assert.equal(result.code, 1);
        assert.match(result.stderr, /Could not save interrupted scan/);
        assert.equal(result.stdout, '');
        assert.equal(fs.existsSync(path.join(root, 'data/cache/coverage.json')), false, 'failed save must not advance coverage');
        return;
      }
      assert.equal(result.code, 0, result.stderr);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.stoppedEarly, true);
      assert.equal(receipt.postingsKept, 1);
      assert.equal(receipt.saved, mode === 'save' || mode.startsWith('coverage') || saveRace);
      if (mode === 'coverage-save-error') assert.ok(receipt.coverageSaveError, 'saved matches survive a coverage write failure');
      if (mode === 'coverage') {
        assert.equal(receipt.coverage.companiesCompleted, 1);
        assert.equal(receipt.coverage.remaining, 1);
        assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/cache/coverage.json'))).sources.greenhouse.done.length, 1);
      }
      const pipeline = path.join(root, 'data/pipeline.md');
      const history = path.join(root, 'data/scan-history.tsv');
      if (dryRun || mode === 'liveness') {
        assert.equal(fs.existsSync(pipeline), false);
        assert.equal(fs.existsSync(history), false);
      } else {
        const text = fs.readFileSync(pipeline, 'utf8');
        assert.equal((text.match(/fixture-ready\/jobs\/1/g) || []).length, 1, 'signal and normal completion never append twice');
        assert.match(fs.readFileSync(history, 'utf8'), /fixture-ready\/jobs\/1/);
      }
    } finally { pipelineLock?.release(); fs.rmSync(root, { recursive: true, force: true }); }
  });
}
