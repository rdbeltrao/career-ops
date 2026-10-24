/**
 * jev-prescreen.mjs — run the Jev pre-screen for one job and format it for an
 * evaluation request (modes/_shared.md → Calibrated pre-screen (Jev)).
 *
 * Every automated evaluator (openrouter-runner.mjs, openai-eval.mjs,
 * gemini-eval.mjs, ollama-eval.mjs, batch-evaluate-gemini.mjs) calls this
 * before its model request, so the deterministic segment of the score anchors
 * every report the same way. It lives in lib/ rather than in the runner so an
 * evaluator does not have to import the runner, and with it the scan and
 * tracker modules, just to get the block.
 *
 * jev-score.mjs is an optional sibling script and the OpenRouter key is
 * optional too. Everything here degrades to a "not run" block (or to no block
 * at all when the script is not installed), so an evaluation never fails
 * because the pre-screen could not run. The key is resolved BEFORE jev-score.mjs
 * is imported: without a key nothing else is loaded or read, which keeps an
 * evaluator's file reads exactly what they were before the pre-screen existed.
 * `CAREER_OPS_JEV=off` in the environment skips the pre-screen altogether and
 * the report says `not run: disabled (CAREER_OPS_JEV=off)`; offline runs and
 * tests use it so no request leaves the machine.
 */

import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getCareerOpsRoot } from '../path-resolver.mjs';

const CODE_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const JEV_HEADING = '## Calibrated pre-screen (Jev)';
export const notRunBlock = (reason) => `${JEV_HEADING}\n\nnot run: ${reason}`;

/**
 * Import a sibling module of the checkout by path, or null when it does not
 * exist or does not load. Resolved from the checkout root, never from the
 * data root.
 * @param {string} rel path relative to the checkout root
 * @returns {Promise<object|null>}
 */
export async function loadOptionalModule(rel) {
  const target = fileURLToPath(new URL(rel, pathToFileURL(CODE_ROOT)));
  if (!fs.existsSync(target)) return null;
  try { return await import(pathToFileURL(target).href); } catch { return null; }
}

/**
 * The jev-score.mjs module, or null when it is not installed.
 * @param {{jevPath?: string}} [opts] - `jevPath` overrides the sibling path (tests).
 * @returns {Promise<object|null>}
 */
export async function loadJevModule({ jevPath } = {}) {
  if (jevPath === undefined) return loadOptionalModule('./jev-score.mjs');
  if (!fs.existsSync(jevPath)) return null;
  try { return await import(pathToFileURL(jevPath).href); } catch { return null; }
}

/**
 * Resolve the OpenRouter key the way the runner does, without importing it.
 * @returns {Promise<string|null>}
 */
async function resolveKey(env, dataRoot) {
  const keyModule = await loadOptionalModule('./lib/openrouter-key.mjs');
  if (typeof keyModule?.resolveOpenRouterKey === 'function') {
    return keyModule.resolveOpenRouterKey({ env, codeRoot: CODE_ROOT, dataRoot }).key ?? null;
  }
  return env.OPENROUTER_API_KEY_JOB_SEARCH || env.OPENROUTER_API_KEY || null;
}

/**
 * Run the Jev pre-screen for one job and format it for the evaluation request.
 *
 * @param {object} job - The job object jev-score takes (url, title, company, location, workplace, seniority, description).
 * @param {object} [opts]
 * @param {object|null} [opts.jev] - The jev-score.mjs module; null means not installed.
 *   When the key is absent from `opts`, the module is loaded lazily, and only
 *   after an OpenRouter key was found.
 * @param {NodeJS.ProcessEnv} [opts.env] - Where the OpenRouter key is looked up.
 * @param {string} [opts.dataRoot] - The data root (modes/_context.md, config/jev-criteria.yml).
 * @param {(args: {dataRoot: string, codeRoot: string}) => any} [opts.loadCriteria] - Criteria loader; lib/jev-criteria.mjs by default.
 * @returns {Promise<{block: string|null, result: object|null, notice: string}>}
 *   `block` is the markdown block to append to the request (null when the
 *   script is not installed), `result` the parsed score when it ran.
 */
export async function jevPrescreen(job, opts = {}) {
  const { env = process.env, dataRoot = getCareerOpsRoot(), loadCriteria } = opts;
  const lazy = !Object.hasOwn(opts, 'jev');
  let jev = opts.jev;
  if (!lazy && !jev) {
    return { block: null, result: null, notice: 'ℹ️  Jev pre-screen not run: jev-score.mjs is not installed' };
  }
  if (String(env.CAREER_OPS_JEV ?? '').trim().toLowerCase() === 'off') {
    const reason = 'disabled (CAREER_OPS_JEV=off)';
    return { block: notRunBlock(reason), result: null, notice: `ℹ️  Jev pre-screen not run: ${reason}` };
  }
  try {
    const apiKey = await resolveKey(env, dataRoot);
    if (!apiKey) {
      if (lazy && !fs.existsSync(new URL('./jev-score.mjs', pathToFileURL(CODE_ROOT)))) {
        return { block: null, result: null, notice: 'ℹ️  Jev pre-screen not run: jev-score.mjs is not installed' };
      }
      const reason = 'no OpenRouter key (OPENROUTER_API_KEY)';
      return { block: notRunBlock(reason), result: null, notice: `ℹ️  Jev pre-screen not run: ${reason}` };
    }
    if (lazy) {
      jev = await loadJevModule();
      if (!jev) return { block: null, result: null, notice: 'ℹ️  Jev pre-screen not run: jev-score.mjs is not installed' };
    }
    let criteria;
    if (typeof loadCriteria === 'function') {
      criteria = loadCriteria({ dataRoot, codeRoot: CODE_ROOT });
    } else {
      const criteriaModule = await loadOptionalModule('./lib/jev-criteria.mjs');
      if (typeof criteriaModule?.loadCriteria !== 'function') throw new Error('lib/jev-criteria.mjs is not installed');
      criteria = criteriaModule.loadCriteria({ dataRoot, codeRoot: CODE_ROOT });
    }
    const context = jev.loadContextText({ dataRoot });
    const result = await jev.scoreJob({ profileText: context.text, job, criteria, apiKey });
    if (result?.error) {
      return { block: notRunBlock(result.error), result: null, notice: `ℹ️  Jev pre-screen not run: ${result.error}` };
    }
    const fit = result.fit === null || result.fit === undefined ? 'n/a' : result.fit;
    return {
      block: jev.formatPrescreenMarkdown(result),
      result,
      notice: `ℹ️  Jev pre-screen: fit ${fit}, ${result.verdict ?? 'n/a'} (context: ${context.source})`,
    };
  } catch (e) {
    return { block: notRunBlock(e.message), result: null, notice: `ℹ️  Jev pre-screen not run: ${e.message}` };
  }
}
