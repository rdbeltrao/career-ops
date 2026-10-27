#!/usr/bin/env node
/** Explicit same-opening merge; the web delegates mutations to this CLI. */
import { readFileSync } from 'node:fs';
import { canonicalizeTrackerPath, getCareerOpsRoot, resolveTrackerPath, resolveTrackerPathForWrite } from './path-resolver.mjs';
import { loadCanonicalStates, openTrackerTransaction, writeFileAtomic } from './tracker-utils.mjs';
import { mergeListingContent, parseListingSelection } from './lib/tracker-listing-merge.mjs';

const USAGE = 'Usage: node merge-listings.mjs --keep <N> --nums <N,N,...> [--dry-run]';
const args = process.argv.slice(2);

try {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
  } else {
    const options = {};
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--dry-run' && !options.dryRun) options.dryRun = true;
      else if ((arg === '--keep' || arg === '--nums') && options[arg] == null && args[index + 1] && !args[index + 1].startsWith('--')) options[arg] = args[++index];
      else throw new Error(`${USAGE}\nUnknown, repeated or incomplete argument: ${arg}`);
    }
    const selection = parseListingSelection(options['--keep'], options['--nums']);
    const root = getCareerOpsRoot();
    const readPath = resolveTrackerPath(root);
    const writePath = canonicalizeTrackerPath(resolveTrackerPathForWrite(root));
    const states = loadCanonicalStates(new URL('./templates/states.yml', import.meta.url));
    if (options.dryRun) {
      const result = mergeListingContent(readFileSync(readPath, 'utf8'), { ...selection, states });
      console.log(JSON.stringify({ kept: result.kept, merged: result.merged, changed: false, backup: null }));
    } else {
      // EVIDENCE: tracker.mjs delete uses this shared lock, backup-first atomic
      // write protocol. Keep the whole read/validate/replace in one transaction.
      if (readPath !== writePath) throw new Error('Move the legacy root tracker to data/applications.md before merging listings.');
      const transaction = await openTrackerTransaction(writePath);
      try {
        const before = transaction.read();
        const result = mergeListingContent(before, { ...selection, states });
        const backup = `${transaction.path}.bak`;
        writeFileAtomic(backup, before);
        transaction.replace(result.content);
        console.log(JSON.stringify({ kept: result.kept, merged: result.merged, changed: true, backup }));
      } finally { transaction.close(); }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = error.code === 'LOCK_TIMEOUT' ? 4 : 1;
}
