// tests/auto-evaluate.test.mjs — pending rows are evaluated without anyone
// pressing Score.
//
// After the Jev pass that ingestion starts, jev-rank.mjs --auto starts
// `auto-evaluate.mjs --background`, which runs the daily batch (sync, then the
// batch runner with --skip-jev-verdict skip). Runs are serialized per data
// root, a busy run is asked to go again rather than dropped, and a batch runner
// started some other way is waited for, never run twice.
//
// Run: node --test tests/auto-evaluate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, BATCH_ARGS } from '../auto-evaluate.mjs';
import { autoEvaluateDisabled, evaluateLockDir, evaluateLogPath, evaluateRerunMarker, startEvaluatePass } from '../lib/auto-evaluate.mjs';
import { tryAcquireDirLockSync } from '../lib/dir-lock.mjs';
import { main as jevRank } from '../jev-rank.mjs';

function dataRoot({ pipeline = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'auto-evaluate-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  if (pipeline) writeFileSync(join(root, 'data', 'pipeline.md'), '# Pipeline\n\n## Pending\n\n## Processed\n');
  return root;
}

function recorder(onRun = () => {}) {
  const runs = [];
  const run = (command, args, options) => {
    runs.push({ command, args, options });
    onRun(runs.length);
    return 0;
  };
  return { run, runs, out: () => {} };
}

const scripts = (runs) => runs.map(({ args }) => args[0].split('/').pop());

test('automatic evaluation is off inside tests and behind its own switch', () => {
  assert.equal(autoEvaluateDisabled({ NODE_TEST_CONTEXT: 'child-v8' }), true);
  assert.equal(autoEvaluateDisabled({ CAREER_OPS_NO_AUTO_EVALUATE: '1' }), true);
  assert.equal(autoEvaluateDisabled({ CAREER_OPS_NO_AUTO_JEV: '1' }), true, 'no pre-screen, no evaluation');
  assert.equal(autoEvaluateDisabled({}), false);
});

test('startEvaluatePass starts a detached auto-evaluate --background against the data root', () => {
  const root = dataRoot();
  try {
    const calls = [];
    const spawnFn = (execPath, args, options) => { calls.push({ execPath, args, options }); return { on() {}, unref() {} }; };
    assert.equal(startEvaluatePass({ dataRoot: root, env: {}, spawnFn }).reason, 'temporary data root');
    assert.deepEqual(startEvaluatePass({ dataRoot: root, codeRoot: '/checkout', env: {}, spawnFn, execPath: '/node', allowTemporaryRoot: true }), { started: true });
    assert.deepEqual(calls[0].args, ['/checkout/auto-evaluate.mjs', '--background']);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.env.CAREER_OPS_ROOT, root);
    assert.ok(existsSync(evaluateLogPath(root)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a run syncs the pipeline into the batch, then runs the batch the daily job runs', async () => {
  const root = dataRoot();
  try {
    const r = recorder();
    assert.equal(await main([], { dataRoot: root, codeRoot: '/checkout', batchRunning: () => false, ...r }), 0);
    assert.deepEqual(scripts(r.runs), ['sync-batch-input.mjs', 'batch-runner.sh', 'batch-runner.sh']);
    assert.equal(r.runs[1].command, 'bash');
    assert.deepEqual(r.runs[1].args.slice(1), BATCH_ARGS);
    assert.deepEqual(r.runs[2].args.slice(1), ['--resume-paused', ...BATCH_ARGS], 'rows a rate limit paused are resumed');
    assert.deepEqual(BATCH_ARGS, ['--skip-jev-verdict', 'skip', '--skip-pdf', '--parallel', '2']);
    assert.equal(r.runs[0].options.env.CAREER_OPS_ROOT, root);
    assert.equal(existsSync(evaluateLockDir(root)), false, 'the lock is released');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a background run that finds another run in progress asks it to go again', async () => {
  const root = dataRoot();
  const held = tryAcquireDirLockSync(evaluateLockDir(root), { staleMs: 60_000 });
  try {
    const r = recorder();
    assert.equal(await main(['--background'], { dataRoot: root, batchRunning: () => false, ...r }), 0);
    assert.equal(r.runs.length, 0);
    assert.ok(existsSync(evaluateRerunMarker(root)));
  } finally {
    held.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test('rows that arrive during a batch get a second batch in the same run', async () => {
  const root = dataRoot();
  try {
    const r = recorder((n) => { if (n === 2) writeFileSync(evaluateRerunMarker(root), ''); });
    await main(['--background'], { dataRoot: root, batchRunning: () => false, ...r });
    assert.deepEqual(scripts(r.runs), ['sync-batch-input.mjs', 'batch-runner.sh', 'batch-runner.sh', 'sync-batch-input.mjs', 'batch-runner.sh', 'batch-runner.sh']);
    assert.equal(existsSync(evaluateRerunMarker(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a batch runner started some other way is waited for, not run twice', async () => {
  const root = dataRoot();
  try {
    let busy = 2;
    const sleeps = [];
    const r = recorder();
    await main([], { dataRoot: root, batchRunning: () => busy-- > 0, sleep: async (ms) => { sleeps.push(ms); }, ...r });
    assert.equal(sleeps.length, 2);
    assert.deepEqual(scripts(r.runs), ['sync-batch-input.mjs', 'batch-runner.sh', 'batch-runner.sh']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no pipeline means nothing to evaluate', async () => {
  const root = dataRoot({ pipeline: false });
  try {
    const r = recorder();
    assert.equal(await main([], { dataRoot: root, batchRunning: () => false, ...r }), 0);
    assert.equal(r.runs.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an automatic Jev pass hands the rows to automatic evaluation', async () => {
  const root = dataRoot();
  try {
    const started = [];
    const code = await jevRank(['--auto'], { dataRoot: root, out: () => {}, log: () => {}, startEvaluate: (opts) => { started.push(opts); return { started: true }; } });
    assert.equal(code, 0);
    assert.deepEqual(started, [{ dataRoot: root }]);

    const manual = [];
    await jevRank([], { dataRoot: root, out: () => {}, log: () => {}, startEvaluate: (opts) => { manual.push(opts); } });
    assert.equal(manual.length, 0, 'a manual or daily jev-rank leaves evaluation to its caller');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
