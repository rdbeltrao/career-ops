// lib/auto-evaluate.mjs — start the full evaluation of new pipeline rows on
// its own, after the Jev pre-screen has run on them.
//
// Ingestion already scores every new row with Jev (lib/jev-auto.mjs). When that
// pass finishes, jev-rank.mjs --auto calls startEvaluatePass(), which runs
// `node auto-evaluate.mjs --background`: the same batch the daily script runs
// (sync-batch-input.mjs, then batch/batch-runner.sh --skip-jev-verdict skip
// --skip-pdf --parallel 2, through the Claude subscription). Rows Jev marked
// skip are never evaluated. So a row moves from the inbox to the tracker without
// anyone pressing Score.
//
// The same switches as auto Jev keep it out of tests: NODE_TEST_CONTEXT, a data
// root under the OS temp directory, and CAREER_OPS_NO_AUTO_EVALUATE=1 (also the
// user-facing switch to turn automatic evaluation off; CAREER_OPS_NO_AUTO_JEV=1
// turns off both, since nothing is evaluated before it is pre-screened).

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function evaluateLockDir(dataRoot) {
  return join(dataRoot, 'data', '.auto-evaluate.lock');
}

export function evaluateRerunMarker(dataRoot) {
  return join(dataRoot, 'data', '.auto-evaluate.rerun');
}

export function evaluateLogPath(dataRoot) {
  return join(dataRoot, 'output', 'logs', 'auto-evaluate.log');
}

function isTemporaryRoot(dataRoot) {
  const rel = relative(resolve(tmpdir()), resolve(dataRoot));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function autoEvaluateDisabled(env = process.env) {
  return env.CAREER_OPS_NO_AUTO_EVALUATE === '1'
    || env.CAREER_OPS_NO_AUTO_JEV === '1'
    || Boolean(env.NODE_TEST_CONTEXT);
}

/**
 * Start a background `auto-evaluate.mjs --background` run over `dataRoot`.
 * Never throws and never blocks.
 *
 * @param {{dataRoot: string, codeRoot?: string, env?: object, spawnFn?: Function, execPath?: string, allowTemporaryRoot?: boolean}} options
 * @returns {{started: boolean, reason?: string}}
 */
export function startEvaluatePass({ dataRoot, codeRoot = CODE_ROOT, env = process.env, spawnFn = spawn, execPath = process.execPath, allowTemporaryRoot = false } = {}) {
  if (!dataRoot) return { started: false, reason: 'no data root' };
  if (autoEvaluateDisabled(env)) return { started: false, reason: 'disabled' };
  if (!allowTemporaryRoot && isTemporaryRoot(dataRoot)) return { started: false, reason: 'temporary data root' };
  let logFd = null;
  try {
    const logPath = evaluateLogPath(dataRoot);
    mkdirSync(dirname(logPath), { recursive: true });
    logFd = openSync(logPath, 'a');
    const child = spawnFn(execPath, [join(codeRoot, 'auto-evaluate.mjs'), '--background'], {
      cwd: codeRoot,
      env: { ...env, CAREER_OPS_ROOT: dataRoot },
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    child.on?.('error', () => {});
    child.unref?.();
    return { started: true };
  } catch (err) {
    return { started: false, reason: err?.message ?? String(err) };
  } finally {
    if (logFd !== null) {
      try { closeSync(logFd); } catch { /* the child holds its own copy */ }
    }
  }
}
