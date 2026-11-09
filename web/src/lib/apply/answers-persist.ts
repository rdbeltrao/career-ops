import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, findApplication, findReportFile } from "@/lib/career-ops";
import { atomicWrite } from "@/lib/core/safe-write";
import { resolveCompany } from "./answers-save.mjs";
import { loadAnswerBank, loadApplicationAnswers, type Snapshot } from "./answer-bank";

export type PersistAnswersInput = {
  state: "filled" | "submitted";
  /** Tracker row number, "" for a session opened from a pasted URL. */
  application: string;
  /** The client's company label; the tracker row's own company wins (resolveCompany). */
  company: string;
  title: string;
  url: string;
  fields: { id: string; type: string; label: string; password?: boolean }[];
  answers: Record<string, string>;
  /** The CV actually attached, as an absolute path, so the record names the real file. */
  cvPath?: string | null;
};

export type PersistAnswersResult = {
  saved: boolean;
  /** Basename of the report whose `## Application Answers` section was written. */
  report: string | null;
  banked: boolean;
  reportSkipped: "unreadable" | null;
  /** How many answers the record carries; 0 when nothing was worth saving. */
  count: number;
};

/**
 * Save the answers typed into an employer's form, at the two moments they
 * become real: filled into the form (state "filled") and marked submitted.
 *
 * Two places, both through the core's own writers:
 *   - the report's `## Application Answers` section (application-answers.mjs),
 *     the same section the CLI apply mode writes and the Apply checklist reads,
 *     when the session belongs to a tracker row;
 *   - the answer bank, data/application-answers.jsonl (answer-bank.mjs), which
 *     the next prefill and the repeat-application check read, for every session
 *     including one opened from a pasted URL.
 *
 * The report section is user data and writing it replaces it whole, so:
 *   - nothing is written when there is no answer to save;
 *   - the new answers are merged into the existing section, never swapped for
 *     it, and a section already marked submitted stays submitted;
 *   - a section the strict reader cannot read is left alone and reported, not
 *     overwritten with a partial copy.
 * Passwords and empty answers are dropped before either write (snapshotFromForm).
 *
 * Called by POST /api/apply/answers (the page's explicit saves) and by
 * POST /api/apply/fill right after the form is filled, so a fill that the page
 * never followed up on is still on record: the diagnostic that motivated the
 * gates found answers stored for none of 45 sent applications.
 */
export async function persistFormAnswers(input: PersistAnswersInput): Promise<PersistAnswersResult> {
  const { state, application, title, fields, answers, url } = input;
  const root = careerOpsRoot();
  const app = application ? findApplication(application) : null;
  const company = resolveCompany({ trackerCompany: app ? app.company : undefined, clientCompany: input.company });

  const bank = await loadAnswerBank();
  const cvFile = input.cvPath ? path.relative(root, input.cvPath) : null;
  const snapshot = bank.snapshotFromForm({ fields, answers, cvFile });
  if (!bank.snapshotHasAnswers(snapshot)) return { saved: false, report: null, banked: false, reportSkipped: null, count: 0 };

  let reportFile: string | null = null;
  let reportText = "";
  let reportWritten = false;
  let reportSkipped: "unreadable" | null = null;
  if (application) {
    reportFile = findReportFile(application);
    if (reportFile) {
      reportText = fs.readFileSync(/* turbopackIgnore: true */ reportFile, "utf8");
      const answersModule = await loadApplicationAnswers();
      let existing: Snapshot | null = null;
      try {
        existing = answersModule.parseApplicationAnswersSection(reportText, { strict: true });
      } catch {
        reportSkipped = "unreadable";
      }
      if (!reportSkipped) {
        atomicWrite(reportFile, answersModule.upsertApplicationAnswersSection(reportText, bank.mergeSnapshots(existing, snapshot, state)));
        reportWritten = true;
      }
    }
  }

  const meta = reportText ? bank.reportMeta(reportText) : { company: "", role: "", url: "" };
  const reportNumber = reportFile ? (/^(\d+)-/.exec(path.basename(reportFile))?.[1] ?? null) : null;
  const record = bank.bankRecordFromSnapshot(snapshot, {
    state,
    report: reportNumber,
    company: app ? company : company || meta.company,
    role: app?.role || meta.role || title,
    url: url || meta.url,
  });
  const banked = bank.appendBankRecord(root, record);
  return { saved: banked || reportWritten, report: reportWritten && reportFile ? path.basename(reportFile) : null, banked, reportSkipped, count: record.answers.length };
}
