import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, findApplication, findReportFile } from "@/lib/career-ops";
import { atomicWrite } from "@/lib/core/safe-write";
import { getSession } from "@/lib/apply/session";
import { resolveSessionCv } from "@/lib/apply/cv";
import { parseSaveBody } from "@/lib/apply/answers-save.mjs";
import { loadAnswerBank, loadApplicationAnswers } from "@/lib/apply/answer-bank";
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
// Passwords and empty answers are dropped before either write.
export async function POST(req: Request) {
  const parsed = parseSaveBody(await readJsonObject(req));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const { state, application, company, title, fields, answers, sessionId } = parsed.value;

  const root = careerOpsRoot();
  // The session's own URL and title beat the client's copy while it is alive.
  const session = sessionId ? getSession(sessionId) : undefined;
  const url = session?.url ?? parsed.value.url;
  const formTitle = session?.title ?? title;

  try {
    const bank = await loadAnswerBank();
    const cvAbs = await resolveSessionCv({ company, application, title: formTitle }).catch(() => null);
    const cvFile = cvAbs ? path.relative(root, cvAbs) : null;
    const snapshot = bank.snapshotFromForm({ fields, answers, cvFile });

    let reportFile: string | null = null;
    let reportText = "";
    if (application) {
      reportFile = findReportFile(application);
      if (reportFile) {
        reportText = fs.readFileSync(/* turbopackIgnore: true */ reportFile, "utf8");
        const { upsertApplicationAnswersSection } = await loadApplicationAnswers();
        atomicWrite(reportFile, upsertApplicationAnswersSection(reportText, { ...snapshot, state }));
      }
    }

    const meta = reportText ? bank.reportMeta(reportText) : { company: "", role: "", url: "" };
    const app = application ? findApplication(application) : null;
    const reportNumber = reportFile ? (/^(\d+)-/.exec(path.basename(reportFile))?.[1] ?? null) : null;
    const banked = bank.appendBankRecord(
      root,
      bank.bankRecordFromSnapshot(snapshot, {
        state,
        report: reportNumber,
        company: company || app?.company || meta.company,
        role: app?.role || meta.role || formTitle,
        url: url || meta.url,
      }),
    );
    return Response.json({ saved: banked || !!reportFile, report: reportFile ? path.basename(reportFile) : null, banked });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "could not save the answers" }, { status: 500 });
  }
}
