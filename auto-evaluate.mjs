#!/usr/bin/env node
/**
 * auto-evaluate.mjs — evaluate the pending pipeline rows without anyone
 * pressing Score.
 *
 * Runs the batch the daily script always ran: sync-batch-input.mjs (pending
 * rows into batch/batch-input.tsv), then batch/batch-runner.sh with
 * --skip-jev-verdict skip --skip-pdf --parallel 2, then the same runner with
 * --resume-paused for rows a rate limit paused. The batch runner skips rows
 * it already finished, evaluates the rest through the Claude subscription,
 * writes reports and tracker rows, and ends with reconcile-pipeline.mjs, which
 * moves the evaluated rows out of the inbox.
 *
 * Started in the background after every Jev pass (lib/auto-evaluate.mjs), by
 * the scheduled-jobs runner's tick, and in the foreground by
 * fork/scripts/daily.sh. One run at a time per data root:
 *
 *   --background  if another run holds the lock, leave a rerun marker and exit;
 *                 the holder runs the batch again when it finishes, so rows
 *                 added meanwhile are not left waiting for the next day
 *   (default)     wait for the lock, then run
 *
 * batch-runner.sh keeps its own PID lock and refuses a second runner, so this
 * script also waits for any batch runner started some other way.
 *
 * Usage: node auto-evaluate.mjs [--background] [--dry-run]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { acquireDirLock, releaseOrWarn, tryAcquireDirLockSync } from './lib/dir-lock.mjs';
import { evaluateLockDir, evaluateRerunMarker } from './lib/auto-evaluate.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));

export const BATCH_ARGS = ['--skip-jev-verdict', 'skip', '--skip-pdf', '--parallel', '2'];
// A run that keeps being asked to go again stops after this many batches.
const MAX_RUNS = 5;
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;
const FOREGROUND_WAIT_MS = 6 * 60 * 60 * 1000;
const BATCH_POLL_MS = 30 * 1000;
const BATCH_WAIT_MS = 6 * 60 * 60 * 1000;

const KNOWN_FLAGS = ['--background', '--dry-run', '--help', '-h'];
const USAGE = `
  auto-evaluate.mjs — evaluate pending pipeline rows through the batch runner

  node auto-evaluate.mjs [--background] [--dry-run]

    --background  exit at once when another run is in progress (it will pick
                  up the new rows); the default waits for it
    --dry-run     print the commands, run nothing
`;

function defaultRun(command, args, { cwd, env }) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  return result.status ?? 1;
}

/** Whether the batch runner's PID file names a live process. */
function defaultBatchRunning(codeRoot) {
  const pidFile = join(codeRoot, 'batch', 'batch-runner.pid');
  if (!existsSync(pidFile)) return false;
  const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

const defaultSleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * @param {string[]} args
 * @param {{dataRoot?: string, codeRoot?: string, env?: object, run?: Function, batchRunning?: Function, sleep?: Function, out?: Function, now?: Function}} [deps]
 * @returns {Promise<number>} exit code
 */
export async function main(args, deps = {}) {
  const dataRoot = deps.dataRoot ?? getCareerOpsRoot();
  const codeRoot = deps.codeRoot ?? CODE_ROOT;
  const env = { ...(deps.env ?? process.env), CAREER_OPS_ROOT: dataRoot };
  const run = deps.run ?? defaultRun;
  const batchRunning = deps.batchRunning ?? defaultBatchRunning;
  const sleep = deps.sleep ?? defaultSleep;
  const out = deps.out ?? ((line) => console.log(line));
  const now = deps.now ?? Date.now;
  const background = hasFlag(args, '--background');
  const dryRun = hasFlag(args, '--dry-run');

  if (!existsSync(join(dataRoot, 'data', 'pipeline.md'))) {
    out('auto-evaluate: no data/pipeline.md yet. Nothing to evaluate.');
    return 0;
  }

  const runner = join(codeRoot, 'batch', 'batch-runner.sh');
  const steps = [
    [process.execPath, [join(codeRoot, 'sync-batch-input.mjs')]],
    ['bash', [runner, ...BATCH_ARGS]],
    // Rows a rate limit paused are skipped by a plain run and only resume
    // with --resume-paused; without this step they would wait forever.
    ['bash', [runner, '--resume-paused', ...BATCH_ARGS]],
  ];
  if (dryRun) {
    for (const [command, stepArgs] of steps) out(`[dry-run] ${command} ${stepArgs.join(' ')}`);
    return 0;
  }

  const marker = evaluateRerunMarker(dataRoot);
  const lockOptions = { staleMs: LOCK_STALE_MS, owner: { script: 'auto-evaluate' }, createParent: true };
  let lock;
  if (background) {
    lock = tryAcquireDirLockSync(evaluateLockDir(dataRoot), lockOptions);
    if (!lock) {
      writeFileSync(marker, '');
      out('auto-evaluate: another run is in progress; it will evaluate the new rows when it finishes.');
      return 0;
    }
  } else {
    lock = await acquireDirLock(evaluateLockDir(dataRoot), { ...lockOptions, timeoutMs: FOREGROUND_WAIT_MS, retryMs: 1000 });
  }

  let code = 0;
  try {
    for (let pass = 1; pass <= MAX_RUNS; pass += 1) {
      rmSync(marker, { force: true });
      const waitStarted = now();
      while (batchRunning(codeRoot)) {
        if (now() - waitStarted > BATCH_WAIT_MS) {
          out('auto-evaluate: a batch runner has been running for 6 hours; giving up on this run.');
          return 1;
        }
        out('auto-evaluate: a batch runner is already running; waiting for it to finish.');
        await sleep(BATCH_POLL_MS);
      }
      out(`auto-evaluate: batch ${pass} at ${new Date(now()).toISOString()}`);
      for (const [command, stepArgs] of steps) {
        const status = run(command, stepArgs, { cwd: codeRoot, env });
        // A batch with failed rows exits non-zero; the rows it finished are
        // still saved, and the failures are retried by the next batch.
        if (status !== 0) {
          code = status;
          out(`auto-evaluate: ${stepArgs[0].split('/').pop()} exited ${status}.`);
        }
      }
      if (!existsSync(marker)) break;
    }
  } finally {
    releaseOrWarn(lock);
  }
  return code;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: [], requireOperand: true });
  main(args).then((code) => process.exit(code)).catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
