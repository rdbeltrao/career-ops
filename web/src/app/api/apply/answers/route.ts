import { getSession } from "@/lib/apply/session";
import { resolveSessionCv, resolvedCvPath } from "@/lib/apply/cv";
import { parseSaveBody } from "@/lib/apply/answers-save.mjs";
import { persistFormAnswers } from "@/lib/apply/answers-persist";
import { readJsonObject } from "@/lib/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Save the answers the user reviewed on the Apply page, at the two moments they
// become real: when they are filled into the employer's form (state "filled")
// and when the user marks the application submitted ("submitted").
//
// The writing itself lives in persistFormAnswers (answers-persist.ts), which
// /api/apply/fill also calls right after a fill, so every answer typed into a
// form is on record even when the page never reaches this route. What stays
// here is the HTTP contract: validate the body (answers-save.mjs) and prefer the
// live session's own URL and title over the client's copy.
export async function POST(req: Request) {
  const parsed = parseSaveBody(await readJsonObject(req));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const { state, application, title, fields, answers, sessionId } = parsed.value;

  // The session's own URL and title beat the client's copy while it is alive.
  const session = sessionId ? getSession(sessionId) : undefined;
  const url = session?.url ?? parsed.value.url;
  const formTitle = session?.title ?? title;

  try {
    // Only a READY CV is recorded as the attached file: a stale or
    // company-matched one was never uploaded by the fill route, so naming it
    // here would record an attachment that did not happen.
    const cv = await resolveSessionCv({ company: parsed.value.company, application, title: formTitle }).catch(() => null);
    const cvPath = cv?.status === "ready" ? resolvedCvPath(cv) : null;
    const result = await persistFormAnswers({ state, application, company: parsed.value.company, title: formTitle, url, fields, answers, cvPath });
    return Response.json({ saved: result.saved, report: result.report, banked: result.banked, reportSkipped: result.reportSkipped });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "could not save the answers" }, { status: 500 });
  }
}
