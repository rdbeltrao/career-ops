#!/usr/bin/env node
/**
 * linkedin-apply.mjs — find the employer's application URL behind one LinkedIn
 * posting's "Apply on company website", in the signed-in crawl profile.
 *
 * FORK-LOCAL, like providers.local/linkedin-browser.mjs. The crawl reads this
 * URL for every new offsite posting; this command does the same for one posting
 * the crawl saw before it learned to (a tracker row's LinkedIn URL), and is what
 * the web Apply button runs when it has no employer URL yet.
 *
 * Opens /jobs/view/{id}/ headless in the persistent profile at
 * LINKEDIN_PROFILE_DIR or ~/.job-hunt/browser-profile, reads the apply link
 * (lib/linkedin-apply.mjs), records it in {DATA_ROOT}/data/linkedin-apply.json
 * and prints the result. One page, nothing clicked, nothing retried.
 *
 * Usage:
 *   node linkedin-apply.mjs --resolve <linkedin-url|job-id> [--json]
 *
 * Exit codes: 0 read (an employer URL, or the posting is Easy Apply), 1 the
 * page gave no apply method or the browser failed, 2 usage, 3 LinkedIn asked
 * for a login (run `node linkedin-login.mjs`).
 */

import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { linkedInJobId } from './lib/linkedin-url.mjs';
import { recordApply } from './lib/linkedin-apply.mjs';

const USAGE = `Usage:
  node linkedin-apply.mjs --resolve <linkedin-url|job-id> [--json]
  node linkedin-apply.mjs --help

Reads the employer's application URL behind a LinkedIn posting's
"Apply on company website" in the signed-in crawl profile, records it in
data/linkedin-apply.json and prints it.

Exit codes: 0 read, 1 nothing found or browser failure, 2 usage, 3 login required.`;

/** The LinkedIn job id in a posting URL or a bare id, else null. */
export function jobIdFromTarget(target) {
  const text = String(target ?? '').trim();
  if (/^\d+$/.test(text)) return text;
  try {
    return linkedInJobId(new URL(text));
  } catch {
    return null;
  }
}

async function main(argv) {
  let target = null;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      return 0;
    }
    if (a === '--json') json = true;
    else if (a === '--resolve') target = argv[++i] ?? '';
    else {
      console.error(`Unknown argument: ${a}\n\n${USAGE}`);
      return 2;
    }
  }
  const id = jobIdFromTarget(target);
  if (!id) {
    console.error(`${target ? `Not a LinkedIn posting: ${target}` : 'Missing --resolve <linkedin-url|job-id>'}\n\n${USAGE}`);
    return 2;
  }

  const { openProfile, readPostingApply, LoginRequiredError } = await import('./providers.local/linkedin-browser.mjs');
  let context;
  try {
    context = await openProfile({ headed: process.env.LINKEDIN_HEADED === '1' });
  } catch (err) {
    console.error(`linkedin-apply: could not start the browser (is a scan using the profile?): ${err.message}`);
    return 1;
  }
  try {
    const read = await readPostingApply(context, id);
    if (!read.applyKind && !read.applyUrl) {
      const out = { id, applyUrl: null, kind: '', found: false };
      if (json) console.log(JSON.stringify(out));
      else console.error(`linkedin-apply: no apply method found on posting ${id} (closed, or the layout changed).`);
      return 1;
    }
    const entry = recordApply(getCareerOpsRoot(), { id, applyUrl: read.applyUrl, kind: read.applyKind });
    const out = { ...entry, found: !!entry.applyUrl || entry.kind === 'easy-apply' };
    if (json) console.log(JSON.stringify(out));
    else if (entry.applyUrl) console.log(`${id}: ${entry.applyUrl}`);
    else console.log(`${id}: ${entry.kind === 'easy-apply' ? 'Easy Apply on LinkedIn, no employer URL' : 'offsite, but no employer URL was readable'}`);
    return entry.applyUrl || entry.kind === 'easy-apply' ? 0 : 1;
  } catch (err) {
    if (err instanceof LoginRequiredError) {
      if (json) console.log(JSON.stringify({ id, applyUrl: null, kind: '', found: false, error: 'login-required' }));
      console.error(err.message);
      return 3;
    }
    console.error(`linkedin-apply: ${err.message}`);
    return 1;
  } finally {
    await context.close().catch(() => {});
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
