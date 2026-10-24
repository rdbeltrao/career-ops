#!/usr/bin/env node
/**
 * context-evidence.mjs — print modes/_context.md the way the evaluation reads
 * it: with every quantity masked as `[n]`.
 *
 * The evaluator scripts mask the file in process (lib/context-evidence.mjs).
 * The interactive router, the web evaluate prompt and batch-runner.sh hand the
 * context to an agent as text, so they run this command instead of reading
 * the raw file, and the same masking holds on every path. Jev keeps the raw
 * file: it only scores.
 *
 * Usage:
 *   node context-evidence.mjs [--file <path>] [--raw] [--no-notice]
 *
 *   --file       mask this file instead of {DATA_ROOT}/modes/_context.md
 *   --raw        print the file unmasked (what Jev sees); for comparison only
 *   --no-notice  omit the one-line header that says the numbers are masked
 *
 * Exit codes:
 *   0  printed
 *   1  usage error, or the context file does not exist
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isMainModule } from './lib/is-main-module.mjs';
import { MASKED_NOTICE, maskContextNumbers, readMaskedContext } from './lib/context-evidence.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const USAGE = 'Usage: node context-evidence.mjs [--file <path>] [--raw] [--no-notice]';

export function renderContextEvidence({ dataRoot, file = null, raw = false, notice = true } = {}) {
  let text;
  if (file) {
    const path = resolve(file);
    if (!existsSync(path)) return { ok: false, error: `context file not found: ${path}` };
    const body = readFileSync(path, 'utf-8').replace(/^﻿/, '').trim();
    text = raw ? body : maskContextNumbers(body);
  } else {
    const found = readMaskedContext(dataRoot, { raw });
    if (!found) return { ok: false, error: `modes/_context.md not found under ${dataRoot}` };
    text = found.text;
  }
  const header = notice && !raw ? `<!-- ${MASKED_NOTICE} -->\n\n` : '';
  return { ok: true, text: `${header}${text}\n` };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const known = new Set(['--file', '--raw', '--no-notice', '--help', '-h']);
  let file = null;
  let raw = false;
  let notice = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    if (!known.has(a)) { console.error(`Error: unknown flag ${a}\n${USAGE}`); process.exit(1); }
    if (a === '--file') {
      file = args[++i];
      if (!file) { console.error(`Error: --file needs a path\n${USAGE}`); process.exit(1); }
    } else if (a === '--raw') raw = true;
    else if (a === '--no-notice') notice = false;
  }
  const result = renderContextEvidence({ dataRoot: getCareerOpsRoot(), file, raw, notice });
  if (!result.ok) { console.error(`Error: ${result.error}`); process.exit(1); }
  process.stdout.write(result.text);
}
