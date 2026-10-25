import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, findApplication, findReportFile } from "@/lib/career-ops";
import { atomicWrite } from "@/lib/core/safe-write";
import { getSession } from "@/lib/apply/session";
import { resolveSessionCv } from "@/lib/apply/cv";
import { parseSaveBody, resolveCompany } from "@/lib/apply/answers-save.mjs";
import { loadAnswerBank, loadApplicationAnswers, type Snapshot } from "@/lib/apply/answer-bank";
import { readJsonObject } from "@/lib/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Save the answers the user reviewed on the Apply page, at the two moments they
// become real: when they are filled into the employer's form (state "filled")
// and when the user marks the application submitted ("submitted").
//
// Two places, both through the core's own writers:
//   - the report's `## Application Answers` section (application-answers.mjs),
//     the same section the CLI apply mode writes and the Apply checklist reads,
//     when the session belongs to a tracker row;
//   - the answer bank, data/application-answers.jsonl (answer-bank.mjs), which
//     the next prefill and the repeat-application check read, for every session
//     including one opened from a pasted URL.
//
// The report section is user data and writing it replaces it whole, so:
//   - nothing is written when there is no answer to save;
//   - the new answers are merged into the existing section, never swapped for
//     it, and a section already marked submitted stays submitted;
//   - a section the strict reader cannot read is left alone and reported, not
//     overwritten with a partial copy.
// Passwords and empty answers are dropped before either write.
export async function POST(req: Request) {
  const parsed = parseSaveBody(await readJsonObject(req));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const { state, application, title, fields, answers, sessionId } = parsed.value;

  const root = careerOpsRoot();
  // The session's own URL and title beat the client's copy while it is alive.
  const session = sessionId ? getSession(sessionId) : undefined;
  const url = session?.url ?? parsed.value.url;
  const formTitle = session?.title ?? title;
  const app = application ? findApplication(application) : null;
  const company = resolveCompany({ trackerCompany: app ? app.company : undefined, clientCompany: parsed.value.company });

  try {
    const bank = await loadAnswerBank();
    const cvAbs = await resolveSessionCv({ company: parsed.value.company, application, title: formTitle }).catch(() => null);
    const cvFile = cvAbs ? path.relative(root, cvAbs) : null;
    const snapshot = bank.snapshotFromForm({ fields, answers, cvFile });
    if (!bank.snapshotHasAnswers(snapshot)) return Response.json({ saved: false, report: null, banked: false, reportSkipped: null });

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
    const banked = bank.appendBankRecord(
      root,
      bank.bankRecordFromSnapshot(snapshot, {
        state,
        report: reportNumber,
        company: app ? company : company || meta.company,
        role: app?.role || meta.role || formTitle,
        url: url || meta.url,
      }),
    );
    return Response.json({ saved: banked || reportWritten, report: reportWritten && reportFile ? path.basename(reportFile) : null, banked, reportSkipped });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "could not save the answers" }, { status: 500 });
  }
}
