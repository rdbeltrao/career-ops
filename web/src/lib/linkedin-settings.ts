import fs from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as yaml from "js-yaml";
import { careerOpsRoot, portalsConfigPath, rootScript } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { listScheduledJobs, type ScanEngine } from "@/lib/scheduled-jobs";
import { applySearchOp, describeSearchUrl, listLinkedInSearches, type LinkedInSearch } from "@/lib/linkedin-searches.mjs";

/**
 * Everything the web LinkedIn page shows and changes. The searches are the
 * linkedin-browser entries of portals.yml; the session and last crawl come from
 * the core's lib/linkedin-session.mjs (fork-local), loaded at runtime because
 * the core checkout is chosen at runtime and is not bundled.
 */

export type SessionState = "signed-in" | "sign-in-needed" | "expired" | "signed-out" | "no-profile" | "unknown";
export type Session = { state: SessionState; busy: boolean; signedInAt: string; expiresAt: string; message: string };
export type CrawlStatus = { result: "ok" | "login-required" | "error"; search: string; jobs?: number; message: string; at: string };
export type SearchView = LinkedInSearch & { description: ReturnType<typeof describeSearchUrl> };
export type ScheduleView = { id: string; name: string; engine: ScanEngine; every: number; unit: string; status: string; nextRunAt?: string; lastRunAt?: string };
export type LinkedInState = {
  searches: SearchView[];
  session: Session | null;
  crawl: CrawlStatus | null;
  schedules: ScheduleView[];
  portalsFound: boolean;
  error?: string;
};

type SessionModule = {
  sessionStatus(opts: { crawl?: CrawlStatus | null }): Session;
  readCrawlStatus(root: string): CrawlStatus | null;
  profileDir(): string;
};

async function sessionModule(): Promise<SessionModule | null> {
  try {
    return (await import(/* webpackIgnore: true */ pathToFileURL(rootScript("lib/linkedin-session")).href)) as SessionModule;
  } catch {
    return null;
  }
}

export async function loadLinkedInState(): Promise<LinkedInState> {
  const root = careerOpsRoot();
  const file = portalsConfigPath(root);
  let searches: SearchView[] = [];
  let portalsFound = false;
  let error: string | undefined;
  try {
    const doc = yaml.load(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8"));
    portalsFound = true;
    searches = listLinkedInSearches(doc).map((s) => ({ ...s, description: describeSearchUrl(s.searchUrl) }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") error = `portals.yml could not be read: ${err instanceof Error ? err.message : String(err)}`;
  }
  const mod = await sessionModule();
  const crawl = mod ? mod.readCrawlStatus(root) : null;
  const session = mod ? mod.sessionStatus({ crawl }) : null;
  // Schedules that run the LinkedIn searches: the portals engine scans every
  // portals.yml target, the linkedin engine only these.
  const schedules = listScheduledJobs()
    .jobs.filter((j) => j.status !== "deleted" && (j.engine === "portals" || j.engine === "linkedin"))
    .map((j) => ({ id: j.id, name: j.name, engine: j.engine, every: j.every, unit: j.unit, status: j.status, nextRunAt: j.nextRunAt, lastRunAt: j.lastRunAt }));
  return { searches, session, crawl, schedules, portalsFound, ...(error ? { error } : {}) };
}

/** Apply one add / update / toggle request to portals.yml (backup kept, atomic write). */
export function saveSearchOp(body: unknown): { ok: true } | { ok: false; status: number; error: string } {
  const file = portalsConfigPath(careerOpsRoot());
  let source = "";
  try {
    source = fs.readFileSync(/* turbopackIgnore: true */ file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, status: 500, error: "portals.yml could not be read." };
  }
  const r = applySearchOp(source, body);
  if (!r.ok) return r;
  atomicWriteWithBackup(file, r.text);
  return { ok: true };
}

/**
 * Open LinkedIn's own sign-in page in a visible window of the crawl profile
 * (linkedin-login.mjs), detached from this request. The user signs in there;
 * no credential passes through career-ops. Refused while a scan or an earlier
 * sign-in window holds the profile.
 */
export async function startSignIn(): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const mod = await sessionModule();
  if (!mod) return { ok: false, status: 501, error: "This career-ops checkout has no LinkedIn session support." };
  if (mod.sessionStatus({}).busy) {
    return { ok: false, status: 409, error: "The crawl browser profile is in use (a scan, or a sign-in window that is already open). Try again when it finishes." };
  }
  const script = rootScript("linkedin-login");
  if (!fs.existsSync(/* turbopackIgnore: true */ script)) return { ok: false, status: 501, error: "This career-ops checkout has no linkedin-login.mjs." };
  const child = spawn(process.execPath, [script], { cwd: careerOpsRoot(), detached: true, stdio: "ignore", env: process.env });
  child.on("error", () => {});
  child.unref();
  return { ok: true };
}
