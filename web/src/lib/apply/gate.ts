import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, findApplication, findReportFile, readApplications, type Application } from "@/lib/career-ops";
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
};

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

/** The verdict gate's input, read from the report's Machine Summary. */
export function reportVerdict(reportFile: string | null): Verdict {
  let decision = "";
  if (reportFile) {
    try {
      decision = readMachineSummary(fs.readFileSync(/* turbopackIgnore: true */ reportFile, "utf8"))?.decision ?? "";
    } catch {
      decision = "";
    }
  }
  const isApply = isApplyVerdict(decision);
  return { decision, isApply, requiresOverride: !isApply };
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
export async function applyGateStatus(opts: { application?: string; confirmReport?: string; company?: string; title?: string }): Promise<ApplyGateStatus> {
  const application = opts.application?.trim() || "";
  const confirmReport = opts.confirmReport?.trim() || "";
  const identity = application ? identityForApplication(application) : confirmReport ? identityForReport(confirmReport) : null;
  const verdict = application || confirmReport ? reportVerdict(identity?.reportFile ?? null) : null;
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
