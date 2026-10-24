/**
 * openrouter-key.mjs — where the OpenRouter API key comes from, in one place.
 *
 * `jev-score.mjs` and `jev-rank.mjs` need a key for the decisions endpoint and
 * the chat-completions fallback. Several places can hold it and the order
 * matters, so the lookup is written once:
 *
 *   1. the process environment: OPENROUTER_API_KEY_JOB_SEARCH, then
 *      OPENROUTER_API_KEY (the job-search name wins so a key on a separate
 *      OpenRouter account can sit next to a general-purpose key);
 *   2. `.env` in the code checkout (the file `openrouter-runner.mjs` reads);
 *   3. `.env` in the data root (CAREER_OPS_DATA_DIR);
 *   4. the macOS Keychain, as a generic password whose service is the variable
 *      name and whose account is the current user — the convention job-hunt's
 *      `jobs/settings.py` used:
 *
 *        security add-generic-password -a "$USER" -s OPENROUTER_API_KEY_JOB_SEARCH -w
 *
 * Each step tries both names before moving on. The result names its `source`
 * (`env`, `code-env`, `data-env`, `keychain`, `none`) so a caller can say where
 * a key came from without ever printing it. Nothing here logs the key.
 *
 * `CAREER_OPS_SKIP_KEYCHAIN=1` in the environment skips step 4. Tests and CI
 * runs use it so a machine with a real key in its Keychain still exercises the
 * "no key" path without spawning `security`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

/** Variable names tried, in order. */
export const OPENROUTER_KEY_NAMES = ['OPENROUTER_API_KEY_JOB_SEARCH', 'OPENROUTER_API_KEY'];

const KEYCHAIN_TIMEOUT_MS = 10_000;

/**
 * Parse `.env` text into a map. Same line shape `openrouter-runner.mjs`'s
 * `loadEnvFile` accepts: `NAME=value`, upper-case names, optional matching
 * quotes around the value, everything else ignored.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotEnv(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^(['"])(.*?)\1$/, '$2');
  }
  return out;
}

/**
 * Read a generic password from the macOS Keychain. `null` off macOS, when the
 * item is absent, when `security` is missing, or when it does not answer in
 * time. Never throws.
 *
 * @param {string} name - Keychain service name (the variable name).
 * @returns {string|null}
 */
export function defaultKeychain(name) {
  if (process.platform !== 'darwin') return null;
  let account;
  try {
    account = userInfo().username;
  } catch {
    return null;
  }
  try {
    const out = execFileSync('security', ['find-generic-password', '-a', account, '-s', name, '-w'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: KEYCHAIN_TIMEOUT_MS,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function keyFromEnv(env) {
  for (const name of OPENROUTER_KEY_NAMES) {
    const value = typeof env?.[name] === 'string' ? env[name].trim() : '';
    if (value) return value;
  }
  return null;
}

function keyFromDotEnv(root) {
  if (!root) return null;
  const path = join(root, '.env');
  if (!existsSync(path)) return null;
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  return keyFromEnv(parseDotEnv(text));
}

function skipKeychain(env) {
  const raw = typeof env?.CAREER_OPS_SKIP_KEYCHAIN === 'string' ? env.CAREER_OPS_SKIP_KEYCHAIN.trim().toLowerCase() : '';
  return raw !== '' && raw !== '0' && raw !== 'false';
}

/**
 * Resolve the OpenRouter key.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv|Record<string,string>} [opts.env] - Environment to read (default `process.env`).
 * @param {string} [opts.codeRoot] - The checkout; its `.env` is read second.
 * @param {string} [opts.dataRoot] - The data root; its `.env` is read third.
 * @param {(name: string) => string|null} [opts.keychain] - Keychain lookup, injectable for tests.
 * @returns {{ key: string|null, source: 'env'|'code-env'|'data-env'|'keychain'|'none' }}
 */
export function resolveOpenRouterKey({ env = process.env, codeRoot, dataRoot, keychain = defaultKeychain } = {}) {
  const fromEnv = keyFromEnv(env);
  if (fromEnv) return { key: fromEnv, source: 'env' };

  const fromCode = keyFromDotEnv(codeRoot);
  if (fromCode) return { key: fromCode, source: 'code-env' };

  const fromData = keyFromDotEnv(dataRoot);
  if (fromData) return { key: fromData, source: 'data-env' };

  if (!skipKeychain(env)) {
    for (const name of OPENROUTER_KEY_NAMES) {
      let value = null;
      try {
        value = keychain(name);
      } catch {
        value = null;
      }
      if (typeof value === 'string' && value.trim()) return { key: value.trim(), source: 'keychain' };
    }
  }

  return { key: null, source: 'none' };
}
