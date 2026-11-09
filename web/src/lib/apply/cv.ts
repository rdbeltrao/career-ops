import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, findApplication, pdfPathStatusForReport } from "@/lib/career-ops";
import { companySlug } from "@/lib/company-slug.mjs";
import { matchesTailoredCv, sortNewestFirst } from "./cv-match.mjs";
import { reportNumberFromCell } from "./cv-selection.mjs";

/**
 * What the apply flow knows about the tailored CV for one application.
 *
 *   ready            - indexed for this report and its final review is current:
 *                      the one state the fill route may attach.
 *   stale            - indexed, but the review receipt is missing or no longer
 *                      matches (pdfPathStatusForReport's "stale"): regenerate.
 *   unverified-role  - found by company name only, with no application number
 *                      to say which requisition it was tailored for. Never
 *                      attached until the user confirms the report number.
 *   none             - nothing to attach; `reason` says why when known.
 *
 * Before this type the resolver returned a bare path and every caller treated
 * it as ready, so a stale PDF or a sibling role's CV was uploaded silently.
 */
export type TailoredCvResolution =
  | { status: "ready"; path: string; report: string }
  | { status: "stale"; path: string; report: string; reason: string }
  | { status: "unverified-role"; path: string; unverifiedRole: true }
  | { status: "none"; reason?: string };

export const NO_CV: TailoredCvResolution = { status: "none" };

/** The path of a resolution that found a file, ready or not; null otherwise. */
export function resolvedCvPath(cv: TailoredCvResolution | null | undefined): string | null {
  return cv && cv.status !== "none" ? cv.path : null;
}

/**
 * Locate the tailored CV PDF for an application. When the tracker application
 * number is known, the report -> PDF manifest (via pdfPathStatusForReport, the
 * same resolver /api/cv-pdf uses for its own "n" lookups) is authoritative, so
 * an older role cannot accidentally receive the company's newest CV. Company
 * matching remains as a fallback for manually pasted URLs, and what it finds is
 * returned as `unverified-role`: a filename names a company, not a requisition.
 */
export async function resolveTailoredCv(company?: string, applicationNumber?: string): Promise<TailoredCvResolution> {
  const root = careerOpsRoot();
  if (applicationNumber?.trim()) {
    const app = findApplication(applicationNumber.trim());
    if (!app) return { status: "none", reason: `tracker row ${applicationNumber.trim()} not found` };
    const reportNumber = reportNumberFromCell(app.report);
    if (!reportNumber) return { status: "none", reason: `tracker row ${app.n} links no report` };
    return resolveConfirmedCv(String(reportNumber));
  }

  const c = (company ?? "").trim();
  if (!c) return NO_CV;
  const dir = path.join(root, "output");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"));
  } catch {
    return NO_CV;
  }
  // No usable key means this company cannot be identified from a filename, so
  // find nothing. The old empty-string slug was a substring of every name in
  // output/, which resolved the newest unrelated CV instead (#2352).
  const key = companySlug(c);
  if (!key) return NO_CV;
  const { slug } = key;
  // `key.first` is deliberately NOT used as a fallback: matching a company by
  // its first token alone made "Acme" resolve an unrelated "Acme Bank" file,
  // and matchesTailoredCv already requires the cv- prefix AND a token boundary.
  const matches = files.filter((f) => matchesTailoredCv(f.toLowerCase(), slug));
  if (!matches.length) return NO_CV;
  const sorted = sortNewestFirst(dir, matches);
  if (!sorted.length) return NO_CV;
  return { status: "unverified-role", path: path.join(dir, sorted[0]), unverifiedRole: true };
}

/**
 * The CV indexed for one REPORT number, through the manifest and its review
 * receipt. This is the path a confirmed report number takes when the session
 * was opened from a pasted URL: the user names the requisition, the index
 * names the file, and the receipt says whether it is still current.
 */
export async function resolveConfirmedCv(reportNumber: string): Promise<TailoredCvResolution> {
  const n = String(reportNumber ?? "").trim();
  if (!/^\d+$/.test(n)) return { status: "none", reason: "report number must be digits" };
  const result = await pdfPathStatusForReport(n);
  const report = String(Number(n));
  if (result.status === "found") return { status: "ready", path: result.path, report };
  if (result.status === "stale") return { status: "stale", path: result.path, report, reason: result.reason };
  return { status: "none", reason: `no indexed tailored CV for report ${report} (${result.status})` };
}

/**
 * The tailored CV for one apply session, resolved once for both halves of it.
 *
 * /api/apply/fill uploads this PDF and /api/apply/prefill drafts the answers
 * typed into the same form, so the two must agree on which document this
 * application is. They disagreed while prefill resolved nothing at all and sent
 * the planner to master cv.md: bullets are reselected per offer, role framing is
 * rewritten toward the employer's domain, and engagements are regrouped, so the
 * reviewer read a resume and a set of answers describing different careers.
 *
 * Both routes call this. Two copies of the same three-way expression, one per
 * route, is how they drift apart again.
 *
 * `confirmReport` is the report number the user confirmed on the Apply page for
 * a session opened from a pasted URL. It takes precedence over the company
 * fallback, which can only ever answer `unverified-role`.
 */
export async function resolveSessionCv(opts: { company?: string; application?: string; title?: string; confirmReport?: string }): Promise<TailoredCvResolution> {
  if (opts.confirmReport?.trim()) return resolveConfirmedCv(opts.confirmReport);
  const direct = await resolveTailoredCv(opts.company, opts.application);
  if (direct.status !== "none") return direct;
  // An application number that resolved nothing means THIS role has no tailored
  // CV. Guessing a company off the page title would attach a sibling role's.
  if (opts.application) return direct;
  return resolveTailoredCv(companyFromTitle(opts.title));
}

/**
 * Best-effort company name from an application form/page title. ATS titles look
 * like "Role - Region @ Company" (Ashby) or "Company — Role" / "Role at Company".
 * Used as a fallback when the apply flow was started by pasting a URL (no offer
 * context) rather than from a report's Apply button.
 */
export function companyFromTitle(title?: string): string {
  const t = (title ?? "").trim();
  if (!t) return "";
  const at = t.match(/@\s*([^|@]+?)\s*$/);
  if (at) return at[1].trim();
  const atWord = t.match(/\bat\s+([A-Z][\w&.\- ]+?)\s*$/);
  if (atWord) return atWord[1].trim();
  return "";
}
