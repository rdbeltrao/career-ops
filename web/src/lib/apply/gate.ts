import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { careerOpsRoot, findApplication, findReportFile, readApplications, rootScript, type Application } from "@/lib/career-ops";
import { getProfilePath } from "@/lib/core/profile-path.mjs";
import { normalizeUrl } from "@/lib/core/url-key.mjs";
import { readMachineSummary } from "@/lib/machine-summary.mjs";
import { isReservedReportFile } from "@/lib/report-files.mjs";
import { isApplyVerdict } from "./apply-gates.mjs";
import { reportNumberFromCell } from "./cv-selection.mjs";
import { resolveSessionCv, type TailoredCvResolution } from "./cv";

/**
 * Who this apply session is for, resolved server-side from either identifier
 * the page can hold: the tracker row (`application`, set when Apply was opened
 * from a report) or a report number the user confirmed for a pasted URL.
 * Both are joined to the same tracker row and report file, so the gates, the
 * notes and the answer bank name one requisition.
 */
export type ApplicationIdentity = {
  /** Tracker `#`, or null when no row links this report. */
  row: string | null;
  /** Report number (the NNN of reports/NNN-*.md), or null when unknown. */
  report: string | null;
  reportFile: string | null;
  company: string;
  role: string;
  status: string;
};

export type Verdict = {
  /** `final_decision` as the Machine Summary spells it; "" when unreadable. */
  decision: string;
  isApply: boolean;
  requiresOverride: boolean;
  /** An open work-permit question (why), or null: `work_auth: permit_question`,
   *  or a posting location outside `authorized_in` for a candidate who needs
   *  sponsorship. A German EU Blue Card covers Germany, never the EU. */
  permit: string | null;
};

type ConsistencyModule = {
  countryOf(text: unknown): string | null;
  isAuthorized(country: string, authorizedIn: unknown[]): boolean;
  readProfileLocation(profilePath: string): { authorizedIn: string[]; needsSponsorship: boolean | null } | null;
};

let consistencyModule: Promise<ConsistencyModule | null> | null = null;
/** The core's country and authorization rules (verify-report-consistency.mjs), loaded once; null when the checkout cannot run them. */
function loadConsistency(): Promise<ConsistencyModule | null> {
  consistencyModule ??= import(/* webpackIgnore: true */ pathToFileURL(rootScript("verify-report-consistency")).href).then((m) => m as ConsistencyModule).catch(() => null);
  return consistencyModule;
}

/**
 * Why a work permit is still a question for this role, or null. The report's
 * own tier wins; when it reads anything but permit_question, the posting
 * location is checked against the profile, because 4 of the Spain reports in
 * the 2026-11-09 diagnostic carried `final_decision: Apply` with
 * `work_auth: not_needed`.
 */
export async function permitQuestion(summary: { workAuth?: string; postingLocation?: string } | null): Promise<string | null> {
  if (!summary) return null;
  if (summary.workAuth === "permit_question") return "the evaluation marked the work authorization as a permit question";
  const location = (summary.postingLocation ?? "").trim();
  if (!location) return null;
  const core = await loadConsistency();
  if (!core) return null;
  const profile = core.readProfileLocation(getProfilePath(careerOpsRoot()));
  if (!profile || profile.needsSponsorship !== true) return null;
  const country = core.countryOf(location);
  if (!country || core.isAuthorized(country, profile.authorizedIn)) return null;
  return `the posting location "${location}" is outside the countries you are authorized to work in (${profile.authorizedIn.join(", ") || "none listed"})`;
}

/** The report under reports/ numbered `n`, read without a tracker row. */
function reportFileByNumber(n: string): string | null {
  if (!/^\d+$/.test(n)) return null;
  const target = Number(n);
  const dir = path.join(careerOpsRoot(), "reports");
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const match = files.find((f) => f.endsWith(".md") && !isReservedReportFile(f) && parseInt(f, 10) === target);
  return match ? path.join(dir, match) : null;
}

function identityFromRow(app: Application, reportFile: string | null): ApplicationIdentity {
  const fromCell = reportNumberFromCell(app.report);
  const fromFile = reportFile ? parseInt(path.basename(reportFile), 10) : NaN;
  const report = fromCell != null ? String(fromCell) : Number.isInteger(fromFile) ? String(fromFile) : null;
  return { row: app.n, report, reportFile, company: app.company, role: app.role, status: app.status };
}

/** Identity for a tracker row number; null when the row does not exist. */
export function identityForApplication(application: string): ApplicationIdentity | null {
  const n = application.trim();
  const app = findApplication(n);
  if (!app) return null;
  return identityFromRow(app, findReportFile(n));
}

/** Identity for a confirmed report number: the row linking it when there is one. */
export function identityForReport(reportNumber: string): ApplicationIdentity | null {
  const n = reportNumber.trim();
  if (!/^\d+$/.test(n)) return null;
  const target = Number(n);
  const row = readApplications().find((a) => reportNumberFromCell(a.report) === target) ?? null;
  const reportFile = row ? findReportFile(row.n) : reportFileByNumber(n);
  if (row) return identityFromRow(row, reportFile);
  if (!reportFile) return null;
  return { row: null, report: String(target), reportFile, company: "", role: "", status: "" };
}

/**
 * Identity for a pasted form URL: the tracker row whose URL cell names the
 * same posting (url-key.mjs normalization, so tracking params, scheme and a
 * trailing slash do not matter). An ATS "apply" page is keyed back to its
 * posting: Lever serves the form at `/{id}/apply`, Greenhouse at
 * `/{board}/jobs/{id}#app` (a fragment normalizeUrl already drops). Null when
 * no row matches, so the caller can still ask for the report number.
 */
export function identityForUrl(url: string | undefined): ApplicationIdentity | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;
  const candidates = new Set<string>();
  const spellings = [raw, raw.replace(/\/apply\/?(?=[?#]|$)/i, "")];
  for (const spelling of spellings) {
    const key = normalizeUrl(spelling);
    if (!key) continue;
    candidates.add(key);
    // An ATS form link often carries a source param the tracker's posting URL
    // never had (Lever `lever-source`, Ashby `utm_*` variants not in the
    // tracking list). The bare path is the same posting when the tracker's own
    // key is the bare path, and only then does it match.
    const bare = normalizeUrl(spelling.replace(/[?#].*$/, ""));
    if (bare) candidates.add(bare);
  }
  if (candidates.size === 0) return null;
  const rows = readApplications().filter((a) => {
    const k = normalizeUrl(a.url);
    return !!k && candidates.has(k);
  });
  // Two rows on one URL (a re-evaluation that kept both) are ambiguous: the
  // user confirms the report number instead of the gate guessing.
  if (rows.length !== 1) return null;
  return identityFromRow(rows[0], findReportFile(rows[0].n));
}

/** The verdict gate's input, read from the report's Machine Summary. */
export async function reportVerdict(reportFile: string | null): Promise<Verdict> {
  let summary: ReturnType<typeof readMachineSummary> = null;
  if (reportFile) {
    try {
      summary = readMachineSummary(fs.readFileSync(/* turbopackIgnore: true */ reportFile, "utf8"));
    } catch {
      summary = null;
    }
  }
  const decision = summary?.decision ?? "";
  const isApply = isApplyVerdict(decision);
  const permit = await permitQuestion(summary);
  return { decision, isApply, requiresOverride: !isApply || permit !== null, permit };
}

/** What the Apply page shows before the fill, and what the fill route checks. */
export type ApplyGateStatus = {
  identity: ApplicationIdentity | null;
  /** null for a session with no report to read (pasted URL, nothing confirmed). */
  verdict: Verdict | null;
  cv: TailoredCvResolution;
};

/**
 * One resolution shared by GET /api/apply/gate (the page's preview) and
 * POST /api/apply/fill (the decision), so the page never previews a different
 * answer than the one the server enforces.
 */
export async function applyGateStatus(opts: { application?: string; confirmReport?: string; company?: string; title?: string; url?: string }): Promise<ApplyGateStatus> {
  let application = opts.application?.trim() || "";
  const confirmReport = opts.confirmReport?.trim() || "";
  let identity = application ? identityForApplication(application) : confirmReport ? identityForReport(confirmReport) : null;
  if (!identity && !application && !confirmReport) {
    // A pasted URL: the tracker row that evaluated this posting, when one did.
    identity = identityForUrl(opts.url);
    if (identity?.row) application = identity.row;
  }
  // A session with no report behind it has no verdict to read: `verdict` stays
  // null and the fill route refuses until a report number is confirmed, because
  // "apply only on an Apply verdict" cannot be checked against nothing.
  const verdict = identity || application || confirmReport ? await reportVerdict(identity?.reportFile ?? null) : null;
  const cv = await resolveSessionCv({ company: opts.company, application: application || undefined, title: opts.title, confirmReport: confirmReport || undefined });
  return { identity, verdict, cv };
}

/** The client-safe view of a resolution: no absolute paths leave the server. */
export function publicCv(cv: TailoredCvResolution): { status: TailoredCvResolution["status"]; file: string | null; report: string | null; reason: string | null; unverifiedRole: boolean } {
  return {
    status: cv.status,
    file: cv.status === "none" ? null : path.basename(cv.path),
    report: cv.status === "ready" || cv.status === "stale" ? cv.report : null,
    reason: cv.status === "stale" || cv.status === "none" ? (cv.reason ?? null) : null,
    unverifiedRole: cv.status === "unverified-role",
  };
}
