import { pathToFileURL } from "node:url";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { runCoreCli } from "@/lib/core-cli";
import { linkedInPostingId } from "./apply-target.mjs";
import { interpretResolve } from "./linkedin-resolve-result.mjs";

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

// The CLI's worst case is a browser launch, a 20 s page load and an 8 s wait for
// the apply control; the route allows 60 s, so the child gets most of that.
const RESOLVE_TIMEOUT_MS = 55_000;

/**
 * The employer URL for one posting: from the store when a crawl or an earlier
 * lookup already read it, otherwise by running linkedin-apply.mjs (one headless
 * page in the signed-in crawl profile). The store comes first so a second click
 * never opens LinkedIn again, and never contends with a running scan for the
 * profile. The URL reaching the child is only ever a LinkedIn posting URL,
 * checked here first, passed as one argv element, never through a shell.
 */
export async function resolveLinkedInApply(url: string): Promise<ResolveResult> {
  if (!linkedInPostingId(url)) return { ok: false, error: "not a LinkedIn posting URL", status: 400 };
  const stored = await lookupLinkedInApply(url);
  if (stored && (stored.applyUrl || stored.kind === "easy-apply")) return { ok: true, entry: stored };
  const r = await runCoreCli("linkedin-apply", ["--resolve", url, "--json"], { timeoutMs: RESOLVE_TIMEOUT_MS });
  return interpretResolve(r) as ResolveResult;
}
