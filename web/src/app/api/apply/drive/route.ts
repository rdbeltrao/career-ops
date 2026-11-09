import { getSession, finalizeDrivenSession, extractCurrent, isApplicationFormFn, handoffSession, loginWallOnPage } from "@/lib/apply/session";
import { LOGIN_WALL_MESSAGE } from "@/lib/apply/login-wall.mjs";
import { driveSession } from "@/lib/apply/drive";
import { classifyEmpty } from "@/lib/apply/diagnose";
import { resolveCliOrFallback } from "@/lib/clis";
import { readJsonObject } from "@/lib/json-body";
import { applyGateStatus } from "@/lib/apply/gate";
import { verdictGate } from "@/lib/apply/apply-gates.mjs";
import { appendTrackerNote } from "@/lib/apply/tracker-note";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Streamed agentic drive over an OPEN session: the AI drives the headed page to
// REACH a fillable application form (the user watches each step live), then we
// extract + finalize. NEVER submits (enforced in driveSession).
export async function POST(req: Request) {
  const body = await readJsonObject<{ sessionId?: string; cliId?: string; goal?: "reach" | "full"; answers?: { label: string; value: string }[]; application?: string; overrideReason?: string; confirmReport?: string }>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  const { sessionId, goal = "reach", answers, application, overrideReason, confirmReport } = body;
  if (application !== undefined && (typeof application !== "string" || (application && !/^\d{1,6}$/.test(application.trim())))) {
    return Response.json({ error: "application must be a tracker number" }, { status: 400 });
  }
  if (overrideReason !== undefined && typeof overrideReason !== "string") return Response.json({ error: "overrideReason must be a string" }, { status: 400 });
  // Same fallback as the session open that precedes every drive, which is where
  // a substitution is reported (#4607); driveSession() itself needs Claude.
  const cliId = (body.cliId && resolveCliOrFallback(body.cliId)?.spec.id) || body.cliId || "";
  const s = sessionId ? getSession(sessionId) : undefined;
  if (!s) return Response.json({ error: "apply session not found (it may have expired)" }, { status: 404 });

  // The agent fill is a fill: the same verdict gate /api/apply/fill applies
  // runs here, resolved the same way (tracker row, confirmed report, or the
  // session URL matched to the row that evaluated it), and an override is
  // recorded before the agent types anything. A session no report stands
  // behind is refused, as the fill route refuses it. (This path attaches no
  // CV, so the receipt and role gates do not apply.)
  if (goal === "full") {
    const gate = await applyGateStatus({ application: application?.trim(), confirmReport: confirmReport?.trim(), title: s.title, url: s.url });
    if (!gate.verdict) {
      return Response.json({ error: "This form is not linked to an evaluated report. Enter the report number of its evaluation (or open Apply from the report) before filling.", code: "report-required" }, { status: 409 });
    }
    const v = verdictGate({ decision: gate.verdict.decision, overrideReason, permit: gate.verdict.permit });
    if (!v.ok) return Response.json({ error: v.error, code: v.code, verdict: gate.verdict.decision }, { status: 409 });
    if (v.override) {
      if (!gate.identity?.row) return Response.json({ error: "the override cannot be recorded: this session is not linked to a tracker row", code: "override-not-recordable" }, { status: 409 });
      const written = await appendTrackerNote({ row: gate.identity.row, status: gate.identity.status, note: v.note });
      if (!written.ok) return Response.json({ error: `could not record the override in the tracker: ${written.error}`, code: "override-not-recorded" }, { status: 500 });
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (o: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
        } catch {
          /* client gone */
        }
      };
      try {
        const page = s.page;
        const isFormReady = async () => {
          try {
            const { form } = await extractCurrent(page, s.url);
            // A sign-in form is never "the form": the agent must not report it reached.
            if (await loginWallOnPage(page, form.fields)) return false;
            return isApplicationFormFn(form);
          } catch {
            return false;
          }
        };
        const budget = goal === "full" ? 16 : 7;
        const result = await driveSession(page, cliId, goal, isFormReady, (step) => emit({ t: "step", ...step }), budget, answers);

        if (goal === "full") {
          // The agent filled the real form — bring it to the front for the human
          // to review + submit themselves. We never submit.
          if (result.reached) await handoffSession(s.id).catch(() => {});
          emit({ t: "done", filled: result.reached, turns: result.turns, reason: result.reason });
          return;
        }

        if (result.reached) {
          const fin = await finalizeDrivenSession(s.id, cliId);
          if (fin) {
            emit({ t: "done", reached: true, turns: result.turns, title: fin.title, fields: fin.fields, issues: fin.issues });
            return;
          }
        }
        // Didn't reach a real form → classify why for a clear message. A login
        // wall is named first: the agent's own "stuck" detail tends to describe the
        // sign-in page rather than say what the user should do.
        if (await loginWallOnPage(page).catch(() => false)) {
          emit({ t: "error", reason: "login-wall", message: LOGIN_WALL_MESSAGE });
          return;
        }
        const why = await classifyEmpty(page, s.url).catch(() => ({ message: "Couldn't reach a fillable form on this page." }));
        emit({ t: "error", reason: result.reason, message: result.reason === "stuck" ? result.steps.at(-1)?.detail || why.message : why.message });
      } catch (e) {
        emit({ t: "error", message: e instanceof Error ? e.message.slice(0, 160) : "drive failed" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
