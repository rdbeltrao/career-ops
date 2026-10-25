// tests/jev-auto.test.mjs — the Jev pre-screen runs as part of ingestion.
//
// A row added to data/pipeline.md used to stay "not scored" until somebody ran
// jev-rank.mjs: only the daily script did, so rows from the web scheduler, the
// Explore page or a manual scan waited for the next morning. appendToPipeline()
// now starts a background `jev-rank.mjs --auto` pass after every write, and
// jev-rank serializes passes on one lock so concurrent writers never score the
// same rows twice or lose rows that arrive mid-pass.
//
// Run: node --test tests/jev-auto.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoJevDisabled, jevAutoLogPath, jevLockDir, jevRerunMarker, startJevPass } from '../lib/jev-auto.mjs';
import { tryAcquireDirLockSync } from '../lib/dir-lock.mjs';
import { main } from '../jev-rank.mjs';
import { appendToPipeline } from '../scan.mjs';

const SEGMENT = 'jev: 79 apply — seniority match, location yes, language none, product, stack agnostic';
const APPLY = {
  model: 'typesafe/jev-1.13', fit: 79, score: 4.2, verdict: 'apply',
  reasons: { seniority_match: 'match', location_ok: 'yes', language_blocker: 'none', team_type: 'product', stack_fit: 'stack_agnostic' },
  confidences: {}, probabilities: {}, blocking: [], fallback: false, error: null,
};

function dataRootWith(rows) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'jev-auto-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  writeFileSync(join(dataRoot, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n${rows.join('\n')}\n\n## Processed\n`);
  return dataRoot;
}

const row = (n) => `- [ ] https://jobs.ashbyhq.com/acme/${n} | Acme | Engineering Manager ${n} | Berlin`;
const io = () => { const lines = []; return { lines, log: (l) => lines.push(l), out: (l) => lines.push(l) }; };
const fetchJd = async () => ({ text: 'A real job description with enough words to score.' });
const scorerReturning = (onCall = () => {}) => {
  let calls = 0;
  const scorer = async () => {
    calls += 1;
    onCall(calls);
    return APPLY;
  };
  return { scorer, calls: () => calls };
};

test('auto Jev is off inside tests and when CAREER_OPS_NO_AUTO_JEV=1', () => {
  assert.equal(autoJevDisabled({ NODE_TEST_CONTEXT: 'child-v8' }), true);
  assert.equal(autoJevDisabled({ CAREER_OPS_NO_AUTO_JEV: '1' }), true);
  assert.equal(autoJevDisabled({}), false);
});

test('startJevPass starts a detached jev-rank --auto against the data root and logs it', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'jev-auto-start-'));
  try {
    const calls = [];
    let unrefs = 0;
    const spawnFn = (execPath, args, options) => {
      calls.push({ execPath, args, options });
      return { on() {}, unref() { unrefs += 1; } };
    };
    assert.equal(startJevPass({ dataRoot, env: {}, spawnFn }).reason, 'temporary data root', 'fixtures never reach OpenRouter');
    const result = startJevPass({ dataRoot, codeRoot: '/checkout', env: { PATH: '/bin' }, spawnFn, execPath: '/node', allowTemporaryRoot: true });
    assert.deepEqual(result, { started: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].execPath, '/node');
    assert.deepEqual(calls[0].args, ['/checkout/jev-rank.mjs', '--auto']);
    assert.equal(calls[0].options.cwd, '/checkout');
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.env.CAREER_OPS_ROOT, dataRoot);
    assert.equal(unrefs, 1);
    assert.ok(existsSync(jevAutoLogPath(dataRoot)), 'the background pass has a log file');

    const off = startJevPass({ dataRoot, env: { CAREER_OPS_NO_AUTO_JEV: '1' }, spawnFn });
    assert.equal(off.started, false);
    assert.equal(calls.length, 1);

    const broken = startJevPass({ dataRoot, env: {}, allowTemporaryRoot: true, spawnFn: () => { throw new Error('spawn EACCES'); } });
    assert.deepEqual(broken, { started: false, reason: 'spawn EACCES' });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('appendToPipeline starts a Jev pass for the data root it wrote to', async () => {
  const dataRoot = dataRootWith([]);
  try {
    const started = [];
    await appendToPipeline(
      [{ url: 'https://jobs.ashbyhq.com/acme/9', company: 'Acme', title: 'Engineering Manager' }],
      { pipelinePath: join(dataRoot, 'data', 'pipeline.md'), startJev: (opts) => { started.push(opts); return { started: true }; } },
    );
    assert.equal(started.length, 1);
    assert.equal(started[0].dataRoot, dataRoot);

    await appendToPipeline([], { pipelinePath: join(dataRoot, 'data', 'pipeline.md'), startJev: (opts) => { started.push(opts); } });
    assert.equal(started.length, 1, 'nothing added, nothing to score');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('an --auto pass that finds another pass running leaves a rerun marker and exits', async () => {
  const dataRoot = dataRootWith([row(1)]);
  const held = tryAcquireDirLockSync(jevLockDir(dataRoot), { staleMs: 60_000 });
  try {
    assert.ok(held, 'test holds the lock');
    const { scorer, calls } = scorerReturning();
    const code = await main(['--auto'], { dataRoot, scorer, fetchJd, ...io() });
    assert.equal(code, 0);
    assert.equal(calls(), 0, 'it never scores while another pass holds the lock');
    assert.ok(existsSync(jevRerunMarker(dataRoot)), 'the running pass is asked to go again');
  } finally {
    held?.release();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('an --auto pass scores rows that arrive while it runs', async () => {
  const dataRoot = dataRootWith([row(1)]);
  const pipeline = join(dataRoot, 'data', 'pipeline.md');
  try {
    const { scorer } = scorerReturning((n) => {
      if (n !== 1) return;
      // A scanner appends a row and its own pass finds the lock held.
      writeFileSync(pipeline, readFileSync(pipeline, 'utf8').replace('## Processed', `${row(2)}\n\n## Processed`));
      writeFileSync(jevRerunMarker(dataRoot), '');
    });
    const code = await main(['--auto'], { dataRoot, scorer, fetchJd, ...io() });
    assert.equal(code, 0);
    const text = readFileSync(pipeline, 'utf8');
    assert.ok(text.includes(`${row(1)} | ${SEGMENT}`), text);
    assert.ok(text.includes(`${row(2)} | ${SEGMENT}`), text);
    assert.equal(existsSync(jevRerunMarker(dataRoot)), false);
    assert.equal(existsSync(jevLockDir(dataRoot)), false, 'the lock is released');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a manual pass waits for a running pass instead of scoring the same rows', async () => {
  const dataRoot = dataRootWith([row(1)]);
  const held = tryAcquireDirLockSync(jevLockDir(dataRoot), { staleMs: 60_000 });
  try {
    const { scorer, calls } = scorerReturning();
    const run = main([], { dataRoot, scorer, fetchJd, ...io() });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(calls(), 0, 'blocked behind the running pass');
    held.release();
    assert.equal(await run, 0);
    assert.equal(calls(), 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
