#!/usr/bin/env node
/** Apply source-backed identity corrections by immutable tracker ID, without merging history. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getCareerOpsRoot, resolveTrackerPath, resolveTrackerPathForWrite } from './path-resolver.mjs';
import { detectColumns, parseTrackerRow } from './tracker-parse.mjs';
import { openTrackerTransaction, writeFileAtomic } from './tracker-utils.mjs';

const MUTABLE = new Set(['company', 'role', 'url']);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const textCell = (value) => {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\t]/.test(value) || value.length > 512) throw new Error('Invalid identity text');
  return value.replace(/\|/g, '/').trim();
};
function urlCell(value) {
  if (typeof value !== 'string' || /[|\s]/.test(value)) throw new Error('Invalid posting URL');
  const parsed = new URL(value);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || /\s/.test(value)) throw new Error('Invalid posting URL');
  return `[posting](${value.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
}

export function prepareIdentityRepairs(content, repairs) {
  if (!Array.isArray(repairs) || !repairs.length) throw new Error('A nonempty repairs array is required');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(eol);
  const columns = detectColumns(lines);
  const seen = new Set();
  const changes = [];
  for (const repair of repairs) {
    if (!Number.isSafeInteger(repair.num) || repair.num < 1 || seen.has(repair.num)) throw new Error('Invalid or repeated tracker ID');
    seen.add(repair.num);
    const indices = lines.flatMap((line, index) => parseTrackerRow(line, columns)?.num === repair.num ? [index] : []);
    if (indices.length !== 1) throw new Error(`Tracker #${repair.num} is missing or ambiguous`);
    const index = indices[0], before = parseTrackerRow(lines[index], columns);
    if (!repair.expected || !repair.evidence?.length || !repair.note || /[\r\n\t|]/.test(repair.note)) throw new Error(`Tracker #${repair.num} needs expected values, evidence and a single-cell note`);
    const fields = Object.keys(repair.changes ?? {});
    if (fields.some((field) => !MUTABLE.has(field))) throw new Error('Identity repair cannot change history fields');
    const desired = Object.fromEntries(fields.map((field) => [field, field === 'url' ? repair.changes[field] : textCell(repair.changes[field])]));
    if (Object.hasOwn(desired, 'url')) urlCell(desired.url);
    const alreadyApplied = fields.every((field) => before[field] === desired[field]) && before.notes.includes(repair.note);
    for (const [field, value] of Object.entries(repair.expected)) {
      if (before[field] !== value && !(alreadyApplied && (MUTABLE.has(field) || field === 'notes' && before.notes.startsWith(value)))) {
        throw new Error(`Tracker #${repair.num} changed since the proposal (${field}); nothing was written`);
      }
    }
    if (alreadyApplied) continue;
    const parts = lines[index].split('|');
    for (const field of fields) {
      if (columns[field] == null) throw new Error(`Tracker has no ${field} column`);
      parts[columns[field]] = ` ${field === 'url' ? urlCell(desired[field]) : desired[field]} `;
    }
    if (columns.notes == null) throw new Error('Tracker has no Notes column');
    parts[columns.notes] = `${parts[columns.notes].trimEnd()}${before.notes ? '; ' : ' '}${repair.note} `;
    lines[index] = parts.join('|');
    const after = parseTrackerRow(lines[index], columns);
    for (const field of ['num', 'date', 'score', 'status', 'pdf', 'report']) {
      if (after[field] !== before[field]) throw new Error(`History preservation failed for tracker #${repair.num}`);
    }
    if (!after.notes.startsWith(before.notes)) throw new Error('Existing notes were not preserved');
    changes.push({ num: repair.num, before, after, evidence: repair.evidence });
  }
  return { content: lines.join(eol), changes };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const rest = args.filter((arg) => arg !== '--apply');
  if (rest.length !== 2 || rest[0] !== '--proposal') throw new Error('Usage: node repair-tracker-identities.mjs --proposal <file.json> [--apply]');
  const proposal = JSON.parse(fs.readFileSync(rest[1], 'utf8'));
  const root = getCareerOpsRoot();
  const readPath = resolveTrackerPath(root), writePath = resolveTrackerPathForWrite(root);
  if (readPath !== writePath) throw new Error('Migrate the legacy tracker before repairing identities');
  const transaction = apply ? await openTrackerTransaction(writePath) : null;
  try {
    const before = transaction ? transaction.read() : fs.readFileSync(readPath, 'utf8');
    const result = prepareIdentityRepairs(before, proposal.repairs);
    if (apply && result.changes.length) {
      const output = path.resolve(root, proposal.receipt_dir);
      const relative = path.relative(path.join(root, 'output'), output);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !relative) throw new Error('Receipt directory must be inside the data root output directory');
      fs.mkdirSync(output, { recursive: true });
      const backup = path.join(output, 'applications.before.md');
      if (fs.existsSync(backup) && sha(fs.readFileSync(backup)) !== sha(before)) throw new Error('A different repair backup already exists');
      if (!fs.existsSync(backup)) writeFileAtomic(backup, before);
      const receiptPath = path.join(output, 'receipt.json');
      const receipt = { status: 'prepared', tracker: writePath, before_sha256: sha(before), after_sha256: sha(result.content), changes: result.changes };
      writeFileAtomic(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
      transaction.replace(result.content);
      writeFileAtomic(receiptPath, JSON.stringify({ ...receipt, status: 'applied' }, null, 2) + '\n');
    }
    console.log(JSON.stringify({ applied: apply, changed: result.changes.length, ids: result.changes.map((change) => change.num) }));
  } finally { transaction?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
