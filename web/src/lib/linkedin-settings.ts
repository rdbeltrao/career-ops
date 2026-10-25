import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
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
/** The portals.yml filters a LinkedIn schedule keeps unless it sets its own. */
export type PortalsFilters = { positive: string[]; negative: string[]; allow: string[] };
export type LinkedInState = {
  searches: SearchView[];
  portalsFilters: PortalsFilters;
  session: Session | null;
  crawl: CrawlStatus | null;
  schedules: ScheduleView[];
  portalsFound: boolean;
  error?: string;
};

type SessionModule = {
  sessionStatus(opts: { crawl?: CrawlStatus | null }): Session;
  profileBusy(dir?: string): boolean;
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
  let portalsFilters: PortalsFilters = { positive: [], negative: [], allow: [] };
  let error: string | undefined;
  try {
    const doc = yaml.load(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")) as Record<string, Record<string, unknown>> | null;
    portalsFound = true;
    searches = listLinkedInSearches(doc).map((s) => ({ ...s, description: describeSearchUrl(s.searchUrl) }));
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);
    portalsFilters = { positive: strings(doc?.title_filter?.positive), negative: strings(doc?.title_filter?.negative), allow: strings(doc?.location_filter?.allow) };
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
  return { searches, portalsFilters, session, crawl, schedules, portalsFound, ...(error ? { error } : {}) };
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
// The sign-in window this server opened, while it is still open: a second click
// gets a clear refusal instead of a second browser on the same profile.
let signInChild: ChildProcess | null = null;

// How long a just-started sign-in may take to fail before it counts as open.
const SIGN_IN_SETTLE_MS = 3000;

export async function startSignIn(): Promise<{ ok: true; done?: boolean } | { ok: false; status: number; error: string }> {
  const mod = await sessionModule();
  if (!mod) return { ok: false, status: 501, error: "This career-ops checkout has no LinkedIn session support." };
  if (signInChild && signInChild.exitCode === null && signInChild.signalCode === null) {
    return { ok: false, status: 409, error: "A LinkedIn sign-in window is already open on this computer." };
  }
  if (mod.profileBusy()) {
    return { ok: false, status: 409, error: "The crawl browser profile is in use (a scan, or a sign-in window that is already open). Try again when it finishes." };
  }
  const script = rootScript("linkedin-login");
  if (!fs.existsSync(/* turbopackIgnore: true */ script)) return { ok: false, status: 501, error: "This career-ops checkout has no linkedin-login.mjs." };

  // The window's output goes to a log in the data root, so a failure has a reason.
  const root = careerOpsRoot();
  const logFile = path.join(root, "output", "logs", "linkedin-login.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, "a");
  const start = fs.fstatSync(fd).size;
  // NODE_OPTIONS from the dev server (an --inspect port, for one) would break the child.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [script], { cwd: root, detached: true, stdio: ["ignore", fd, fd], env });
  } finally {
    fs.closeSync(fd);
  }
  child.on("error", () => {});
  const exited = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), SIGN_IN_SETTLE_MS);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(1);
    });
  });
  if (exited === null) {
    child.unref();
    signInChild = child;
    return { ok: true };
  }
  if (exited === 0) return { ok: true, done: true }; // the profile was already signed in
  let reason = "";
  try {
    reason = fs.readFileSync(logFile, "utf8").slice(start).trim().split("\n").filter(Boolean).at(-1) ?? "";
  } catch {
    /* no reason available */
  }
  return { ok: false, status: 500, error: `The sign-in window closed straight away${reason ? `: ${reason.slice(0, 300)}` : "."}` };
}
