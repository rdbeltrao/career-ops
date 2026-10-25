import { pathToFileURL } from "node:url";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { runCoreCli } from "@/lib/core-cli";
import { linkedInPostingId } from "./apply-target.mjs";

/**
 * The employer application URL behind a LinkedIn posting, from the core's
 * data/linkedin-apply.json (lib/linkedin-apply.mjs). The LinkedIn crawl fills
 * it for every offsite posting it reads; linkedin-apply.mjs fills it for one
 * posting on demand, in the same signed-in browser profile.
 */
export type LinkedInApply = { id: string; linkedinUrl: string; applyUrl: string; kind: string; checkedAt: string };

/** The stored entry for a LinkedIn posting URL, or null (not LinkedIn, never read, or an older core). */
export async function lookupLinkedInApply(url: string | undefined | null): Promise<LinkedInApply | null> {
  if (!url || !linkedInPostingId(url)) return null;
  try {
    const mod = await import(/* webpackIgnore: true */ pathToFileURL(rootScript("lib/linkedin-apply")).href);
    return (mod.lookupApply(careerOpsRoot(), url) as LinkedInApply | null) ?? null;
  } catch {
    return null;
  }
}

export type ResolveResult =
  | { ok: true; entry: LinkedInApply }
  | { ok: false; error: string; loginRequired?: boolean; status: number };

/**
 * Read the employer URL for one posting now, by running linkedin-apply.mjs
 * (one headless page in the signed-in crawl profile). The URL reaching the
 * child is only ever a LinkedIn posting URL, checked here first, and it goes in
 * as one argv element, never through a shell.
 */
export async function resolveLinkedInApply(url: string): Promise<ResolveResult> {
  if (!linkedInPostingId(url)) return { ok: false, error: "not a LinkedIn posting URL", status: 400 };
  const r = await runCoreCli("linkedin-apply", ["--resolve", url, "--json"]);
  if (r.timedOut) return { ok: false, error: "LinkedIn took too long to answer. Try again in a moment.", status: 504 };
  if (r.spawnFailed) return { ok: false, error: "This career-ops checkout has no linkedin-apply.mjs.", status: 501 };
  if (r.code === 3) {
    return { ok: false, loginRequired: true, error: 'LinkedIn asked for a login in the crawl profile. Run "node linkedin-login.mjs", then try again.', status: 409 };
  }
  let parsed: (LinkedInApply & { found?: boolean }) | null = null;
  try {
    const line = r.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
    parsed = JSON.parse(line);
  } catch {
    parsed = null;
  }
  if (parsed && (parsed.applyUrl || parsed.kind)) return { ok: true, entry: parsed };
  const why = r.stderr.trim().split("\n").filter(Boolean).at(-1) || "No apply method was found on that posting.";
  return { ok: false, error: why.slice(0, 300), status: 404 };
}
