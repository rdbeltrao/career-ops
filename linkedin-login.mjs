#!/usr/bin/env node
/**
 * linkedin-login.mjs — sign in to LinkedIn once, in the browser profile the
 * fork-local provider scans with (providers.local/linkedin-browser.mjs).
 *
 * Opens https://www.linkedin.com/login HEADED in the persistent Chromium
 * profile at LINKEDIN_PROFILE_DIR or ~/.job-hunt/browser-profile and waits
 * for you to sign in there, by hand, in that window. It never reads, stores
 * or types credentials: the session cookie LinkedIn sets is what the profile
 * keeps, and that is what later `node scan.mjs` runs reuse.
 *
 * Usage:
 *   node linkedin-login.mjs            # wait up to 5 minutes for the feed page
 *   LINKEDIN_LOGIN_TIMEOUT_MS=600000 node linkedin-login.mjs
 *
 * Exit 0 once the feed page (or the logged-in navigation) is seen; exit 1
 * when the timeout passes first or the browser could not start.
 *
 * Fork-local, like the provider: upstream career-ops has no LinkedIn login.
 */

import { validateFlags } from './lib/cli-flags.mjs';
import {
  LINKEDIN_LOGIN_URL, isLoggedIn, openProfile, profileDir,
} from './providers.local/linkedin-browser.mjs';

const DEFAULT_TIMEOUT_MS = 300_000;
const POLL_MS = 2_000;

const USAGE = `Usage:
  node linkedin-login.mjs            # open LinkedIn's login page in the scan profile, wait for you to sign in
  node linkedin-login.mjs --help

Opens ${LINKEDIN_LOGIN_URL} in a visible browser window using the persistent
profile at LINKEDIN_PROFILE_DIR or ~/.job-hunt/browser-profile, then polls
until the feed page appears. Sign in by hand in that window (including any
2FA step). Nothing is typed for you and no credential is read or stored.

Environment:
  LINKEDIN_PROFILE_DIR         profile directory (default ~/.job-hunt/browser-profile)
  LINKEDIN_LOGIN_TIMEOUT_MS    how long to wait, in ms (default ${DEFAULT_TIMEOUT_MS})

Exit codes: 0 signed in, 1 timed out or the browser could not start.`;

validateFlags(process.argv.slice(2), ['--help', '-h'], USAGE);

/** The timeout from the environment: a positive safe integer, else the default. */
function resolveTimeoutMs(raw = process.env.LINKEDIN_LOGIN_TIMEOUT_MS) {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) return DEFAULT_TIMEOUT_MS;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

const timeoutMs = resolveTimeoutMs();
let context;
try {
  context = await openProfile({ headed: true });
} catch (err) {
  console.error(`linkedin-login: could not start the browser: ${err.message}`);
  console.error('If Playwright has no Chromium yet: npx playwright install chromium');
  process.exit(1);
}

try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(LINKEDIN_LOGIN_URL, { waitUntil: 'domcontentloaded' });
  console.log(`linkedin-login: sign in in the browser window (profile ${profileDir()}); waiting up to ${Math.round(timeoutMs / 1000)}s.`);
  const deadline = Date.now() + timeoutMs;
  let signedIn = false;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) { signedIn = true; break; }
    await page.waitForTimeout(POLL_MS);
  }
  if (signedIn) {
    console.log('linkedin-login: signed in; the profile keeps the session for node scan.mjs.');
    process.exitCode = 0;
  } else {
    console.error(`linkedin-login: not signed in after ${Math.round(timeoutMs / 1000)}s (last page: ${page.url()}). Run it again when you have time to finish the login.`);
    process.exitCode = 1;
  }
} finally {
  await context.close().catch(() => {});
}
