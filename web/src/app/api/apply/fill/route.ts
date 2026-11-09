import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fillSession, handoffSession, getSession } from "@/lib/apply/session";
import { applyGateStatus } from "@/lib/apply/gate";
import { attachDecision, cvProvenanceNote, verdictGate } from "@/lib/apply/apply-gates.mjs";
import { appendTrackerNote } from "@/lib/apply/tracker-note";
import { persistFormAnswers } from "@/lib/apply/answers-persist";
import type { ApplyField } from "@/lib/apply/extract";
import type { ApplyIssue } from "@/lib/apply/issue";
import { rootScript } from "@/lib/career-ops";
import { markTrackerReady } from "@/lib/pdf-render.mjs";
import { readJsonObject } from "@/lib/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type FillBody = {
  sessionId?: string;
  answers?: Record<string, string>;
  fields?: ApplyField[];
  handoff?: boolean;
  company?: string;
  /** Tracker row number this session was opened for. */
  application?: string;
  /** Reason to apply against a verdict other than Apply (>= MIN_OVERRIDE_REASON chars). */
  overrideReason?: string;
  /** Report number the user confirmed for a pasted-URL session, naming the CV to attach. */
  confirmReport?: string;
  /** Explicit choice to fill without attaching any CV: the role and receipt gates are moot. */
  skipCv?: boolean;
};

// Fill the real form behind the scenes (headed-but-off-screen), screenshotting
// each step for the "behind the scenes" strip, then bring the window to the front
// so the HUMAN reviews and submits. NEVER submits — there is no submit path here.
//
// Three gates run before a field is touched, all from one applyGateStatus call
// (the same one GET /api/apply/gate previews):
//   1. verdict  — a tracker application whose report's final_decision is not
//                 Apply needs an override reason, recorded as a tracker note;
//   2. receipt  — a tailored CV whose final-review receipt is stale is never
//                 attached (regenerate it);
//   3. role     — a CV matched by company name alone is attached only once the
//                 user confirms the report number it was tailored for.
// After the fill, two records are written through the canonical writers: the
// `cv:` provenance note (which file, which hash, which report) plus the PDF
// column via mark-pdf-ready.mjs, and every typed answer into the answer bank.
export async function POST(req: Request) {
  const body = await readJsonObject<FillBody>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  const { sessionId, answers = {}, fields = [], handoff, company, application, overrideReason, confirmReport, skipCv } = body;
  if (!sessionId) return Response.json({ error: "sessionId required" }, { status: 400 });
  for (const [key, value] of Object.entries({ company, application, overrideReason, confirmReport })) {
    if (value !== undefined && typeof value !== "string") return Response.json({ error: `${key} must be a string` }, { status: 400 });
  }
  if (application && !/^\d{1,6}$/.test(application.trim())) return Response.json({ error: "application must be a tracker number" }, { status: 400 });
  if (confirmReport && !/^\d{1,6}$/.test(confirmReport.trim())) return Response.json({ error: "confirmReport must be a report number" }, { status: 400 });

  const session = getSession(sessionId);
  if (!session) return Response.json({ error: "apply session not found (it may have expired)" }, { status: 404 });

  // Resolve identity, verdict and CV server-side (never trust a client path).
  const gate = await applyGateStatus({ application, confirmReport, company, title: session.title });
  const issues: ApplyIssue[] = [];

  // 1. Verdict gate, for any session that names a report (tracker row or
  //    confirmed report number). A pasted URL with neither has no verdict.
  let overrideNote: string | null = null;
  if (gate.verdict) {
    const v = verdictGate({ decision: gate.verdict.decision, overrideReason });
    if (!v.ok) return Response.json({ error: v.error, code: v.code, verdict: gate.verdict.decision }, { status: 409 });
    if (v.override) overrideNote = v.note;
  }

  // 2 + 3. Receipt and role gates on the resolved CV. `skipCv` is the user's
  // explicit choice to attach nothing, so there is nothing to gate.
  const attach = skipCv === true ? attachDecision({ status: "none" }) : attachDecision(gate.cv, { confirmReport });
  if (!attach.attach && attach.code) {
    return Response.json({ error: attach.error, code: attach.code, cv: gate.cv.status }, { status: 409 });
  }
  const cvPath = attach.attach ? attach.path : undefined;

  // The override is recorded BEFORE the form is touched: a fill that happened
  // with no recorded reason is the gap the gate exists to close, so a note that
  // cannot be written stops the fill rather than running without it.
  if (overrideNote) {
    if (!gate.identity?.row) {
      return Response.json({ error: "the override cannot be recorded: this session is not linked to a tracker row", code: "override-not-recordable" }, { status: 409 });
    }
    const written = await appendTrackerNote({ row: gate.identity.row, status: gate.identity.status, note: overrideNote });
    if (!written.ok) return Response.json({ error: `could not record the override in the tracker: ${written.error}`, code: "override-not-recorded" }, { status: 500 });
    issues.push({ level: "info", code: "verdict-override", message: `Applying against a "${gate.verdict?.decision || "missing"}" verdict; recorded in the tracker as “${written.note}”.` });
  }

  try {
    const result = await fillSession(sessionId, answers, fields, cvPath);
    if (handoff) await handoffSession(sessionId).catch(() => {});

    // Provenance: which file was uploaded, for which requisition, through the
    // canonical writers (set-status.mjs for the note, mark-pdf-ready.mjs for the
    // PDF column). Only when a résumé field actually took the file.
    const attached = !!cvPath && result.steps.some((s) => s.ok && s.label.endsWith("(CV attached)"));
    let provenance: { note: boolean; pdfMarked: boolean } | null = null;
    if (attached && cvPath) {
      provenance = { note: false, pdfMarked: false };
      const sha256 = createHash("sha256").update(fs.readFileSync(cvPath)).digest("hex");
      const report = attach.attach ? attach.report : null;
      const note = cvProvenanceNote({ file: cvPath, sha256, report });
      if (gate.identity?.row) {
        const written = await appendTrackerNote({ row: gate.identity.row, status: gate.identity.status, note });
        provenance.note = written.ok;
        if (!written.ok) issues.push({ level: "warn", code: "provenance-not-recorded", message: `The uploaded CV was not recorded in the tracker (${written.error}). Note it by hand: ${note}` });
      } else {
        issues.push({ level: "warn", code: "provenance-not-recorded", message: `No tracker row for this session, so the uploaded CV was not recorded. Note it by hand: ${note}` });
      }
      if (report) {
        const mark = await markTrackerReady({ spawnFn: spawn, execPath: process.execPath, root: path.dirname(rootScript("mark-pdf-ready")), reportNum: report });
        provenance.pdfMarked = mark.ok;
        if (!mark.ok) issues.push({ level: "warn", code: "pdf-not-marked", message: `The tracker's PDF column was not updated${mark.data?.error ? `: ${mark.data.error}` : "."}` });
      }
    }

    // Every typed answer goes to the answer bank (and the report section when
    // there is one) here, on the server, so a page closed right after the fill
    // still leaves the record a later diagnosis needs.
    let answersSaved = false;
    try {
      const saved = await persistFormAnswers({
        state: "filled",
        application: gate.identity?.row ?? "",
        company: company ?? "",
        title: session.title,
        url: session.url,
        fields,
        answers,
        cvPath: attached ? cvPath : null,
      });
      answersSaved = saved.saved;
      if (saved.reportSkipped === "unreadable") {
        issues.push({ level: "warn", code: "answers-saved", message: "Answers saved to your answer bank. This report's Application Answers section could not be read, so it was left as it is — fix it by hand to keep the report current." });
      } else if (saved.saved) {
        issues.push({ level: "info", code: "answers-saved", message: saved.report ? `${saved.count} answers saved to this report and your answer bank.` : `${saved.count} answers saved to your answer bank.` });
      }
    } catch (e) {
      issues.push({ level: "warn", code: "answers-not-saved", message: `Your answers weren't saved: ${e instanceof Error ? e.message.slice(0, 160) : "unknown error"}. The form itself is unaffected.` });
    }

    return Response.json({
      ...result,
      issues: [...result.issues, ...issues],
      handedOff: !!handoff,
      cvAttached: attached,
      cv: skipCv === true ? "skipped" : gate.cv.status,
      verdict: gate.verdict?.decision ?? null,
      override: !!overrideNote,
      provenance,
      answersSaved,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "fill failed" }, { status: 500 });
  }
}
