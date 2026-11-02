#!/usr/bin/env node
/** Batch-owned JEV receipts and deterministic report finalization. */
import { readFileSync, writeFileSync, renameSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { postingKey } from './url-key.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { stampReportJev, validateJevReceipt } from './lib/report-jev-write.mjs';

function atomicWrite(file, text) {
  const temp = join(dirname(file), `.${randomUUID()}.tmp`);
  try { writeFileSync(temp, text, { mode: 0o600, flag: 'wx' }); renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
}

export function recordJevReceipt(file, url, resultFile, reason) {
  const receipt = { url, result: resultFile === '-' ? null : JSON.parse(readFileSync(resultFile, 'utf8')), reason, recorded_at: new Date().toISOString() };
  validateJevReceipt(receipt);
  atomicWrite(file, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function finalizeReportJev(reportsDir, reportNum, url, receiptFile) {
  if (!/^\d{3,}$/.test(reportNum)) throw new Error('Invalid report number.');
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  validateJevReceipt(receipt);
  if (postingKey(url) !== postingKey(receipt.url)) throw new Error('JEV receipt belongs to another posting.');
  const files = readdirSync(reportsDir).filter(f => f.startsWith(`${reportNum}-`) && f.endsWith('.md') && !f.endsWith('-RESERVED.md'));
  if (files.length !== 1) throw new Error('Expected exactly one report for this report number.');
  const file = join(reportsDir, files[0]);
  if (!lstatSync(file).isFile()) throw new Error('Report must be a regular file.');
  const before = readFileSync(file, 'utf8');
  const after = stampReportJev(before, receipt);
  if (after !== before) atomicWrite(file, after);
  return file;
}

if (isMainModule(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'record' && args.length === 4) recordJevReceipt(args[0], args[1], args[2], args[3]);
    else if (command === 'finalize' && args.length === 4) finalizeReportJev(...args);
    else throw new Error('Usage: finalize-report-jev.mjs record <receipt> <url> <result-json|-> <reason> | finalize <reports-dir> <number> <url> <receipt>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
