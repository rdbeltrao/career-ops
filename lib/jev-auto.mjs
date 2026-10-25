// lib/jev-auto.mjs — run the Jev pre-screen as part of ingestion.
//
// Every writer that adds rows to data/pipeline.md goes through appendToPipeline()
// in scan.mjs (scan.mjs, scan-ats-full.mjs, the HN/Interamt/Dayforce scanners,
// plugins, openrouter-runner and the web's Explore "add"). Once it has written,
// it calls startJevPass(), which starts `node jev-rank.mjs --auto` in the
// background. So a row is scored when it lands, whichever path added it, and the
// scan that added it does not wait for the OpenRouter calls.
//
// jev-rank.mjs serializes every pass on one lock per data root (jevLockDir). A
// background pass that finds the lock held leaves a rerun marker and exits; the
// pass holding the lock sees the marker when it finishes and runs again, so rows
// added mid-pass are scored by the same process instead of being dropped.
//
// Tests never start a real pass: node:test sets NODE_TEST_CONTEXT in every test
// process, and tests/helpers.mjs sets CAREER_OPS_NO_AUTO_JEV=1 for the suite.
// CAREER_OPS_NO_AUTO_JEV=1 is also the user-facing switch to turn this off.

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The lock every jev-rank pass on this data root holds while it scores. */
export function jevLockDir(dataRoot) {
  return join(dataRoot, 'data', '.jev-rank.lock');
}

/** Left by a pass that found the lock held: "new rows arrived, run again". */
export function jevRerunMarker(dataRoot) {
  return join(dataRoot, 'data', '.jev-rank.rerun');
}

/** Where background passes write their output. */
export function jevAutoLogPath(dataRoot) {
  return join(dataRoot, 'output', 'logs', 'jev-auto.log');
}

// A data root under the OS temp directory is a test fixture, never a real job
// search. A test that spawns a scanner with a hand-built env (no
// NODE_TEST_CONTEXT, no CAREER_OPS_NO_AUTO_JEV) is still kept off the network.
function isTemporaryRoot(dataRoot) {
  const rel = relative(resolve(tmpdir()), resolve(dataRoot));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function autoJevDisabled(env = process.env) {
  return env.CAREER_OPS_NO_AUTO_JEV === '1' || Boolean(env.NODE_TEST_CONTEXT);
}

/**
 * Start a background `jev-rank.mjs --auto` pass over `dataRoot`. Never throws
 * and never blocks: ingestion must not fail because scoring could not start.
 *
 * @param {{dataRoot: string, codeRoot?: string, env?: object, spawnFn?: Function, execPath?: string, allowTemporaryRoot?: boolean}} options
 * @returns {{started: boolean, reason?: string}}
 */
export function startJevPass({ dataRoot, codeRoot = CODE_ROOT, env = process.env, spawnFn = spawn, execPath = process.execPath, allowTemporaryRoot = false } = {}) {
  if (!dataRoot) return { started: false, reason: 'no data root' };
  if (autoJevDisabled(env)) return { started: false, reason: 'disabled' };
  if (!allowTemporaryRoot && isTemporaryRoot(dataRoot)) return { started: false, reason: 'temporary data root' };
  let logFd = null;
  try {
    const logPath = jevAutoLogPath(dataRoot);
    mkdirSync(dirname(logPath), { recursive: true });
    logFd = openSync(logPath, 'a');
    const child = spawnFn(execPath, [join(codeRoot, 'jev-rank.mjs'), '--auto'], {
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
