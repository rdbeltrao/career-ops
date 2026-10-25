#!/usr/bin/env node
/**
 * context-evidence.mjs — print modes/_context.md the way the evaluation reads
 * it.
 *
 * The file is the source of truth about the candidate, so by default it is
 * printed as written under a one-line notice that says so (CONTEXT_NOTICE in
 * lib/context-evidence.mjs). The interactive router, the web evaluate prompt
 * and batch-runner.sh hand the context to an agent as text, so they run this
 * command instead of reading the raw file, and every path gets the same view.
 *
 * Masking is an opt-in for a user whose context still carries unresolved
 * figures: `--mask`, or CAREER_OPS_MASK_CONTEXT=1 in the environment, replaces
 * every quantity with `[n]` and prints MASKED_NOTICE instead. `--raw` forces
 * the unmasked file even when the environment asks for masking. Jev keeps
 * reading the raw file itself: it only scores.
 *
 * Usage:
 *   node context-evidence.mjs [--file <path>] [--mask] [--raw] [--no-notice]
 *
 *   --file       print this file instead of {DATA_ROOT}/modes/_context.md
 *   --mask       mask every quantity as [n] (the default when
 *                CAREER_OPS_MASK_CONTEXT is 1 or true)
 *   --raw        print the file unmasked even when CAREER_OPS_MASK_CONTEXT is
 *                set; a no-op otherwise, kept for existing callers
 *   --no-notice  omit the one-line header
 *
 * Exit codes:
 *   0  printed
 *   1  usage error, or the context file does not exist
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isMainModule } from './lib/is-main-module.mjs';
import { CONTEXT_NOTICE, MASKED_NOTICE, defaultMask, maskContextNumbers, readContext } from './lib/context-evidence.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const USAGE = 'Usage: node context-evidence.mjs [--file <path>] [--mask] [--raw] [--no-notice]';

/**
 * Render the context for an agent prompt.
 *
 * @param {{dataRoot?: string, file?: string|null, raw?: boolean, mask?: boolean, notice?: boolean}} [opts]
 *   mask defaults to the environment (CAREER_OPS_MASK_CONTEXT); raw: true wins
 *   over mask and prints the file as written.
 * @returns {{ok: true, text: string} | {ok: false, error: string}}
 */
export function renderContextEvidence({ dataRoot, file = null, raw = false, mask = defaultMask(), notice = true } = {}) {
  const masked = Boolean(mask) && !raw;
  let text;
  if (file) {
    const path = resolve(file);
    if (!existsSync(path)) return { ok: false, error: `context file not found: ${path}` };
    const body = readFileSync(path, 'utf-8').replace(/^﻿/, '').trim();
    text = masked ? maskContextNumbers(body) : body;
  } else {
    const found = readContext(dataRoot, { mask: masked, raw });
    if (!found) return { ok: false, error: `modes/_context.md not found under ${dataRoot}` };
    text = found.text;
  }
  const header = notice ? `<!-- ${masked ? MASKED_NOTICE : CONTEXT_NOTICE} -->\n\n` : '';
  return { ok: true, text: `${header}${text}\n` };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const known = new Set(['--file', '--mask', '--raw', '--no-notice', '--help', '-h']);
  let file = null;
  let raw = false;
  let mask = defaultMask();
  let notice = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    if (!known.has(a)) { console.error(`Error: unknown flag ${a}\n${USAGE}`); process.exit(1); }
    if (a === '--file') {
      file = args[++i];
      if (!file) { console.error(`Error: --file needs a path\n${USAGE}`); process.exit(1); }
    } else if (a === '--mask') mask = true;
    else if (a === '--raw') raw = true;
    else if (a === '--no-notice') notice = false;
  }
  const result = renderContextEvidence({ dataRoot: getCareerOpsRoot(), file, raw, mask, notice });
  if (!result.ok) { console.error(`Error: ${result.error}`); process.exit(1); }
  process.stdout.write(result.text);
}
