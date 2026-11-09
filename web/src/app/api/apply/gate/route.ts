import { NextRequest } from "next/server";
import { applyGateStatus, publicCv } from "@/lib/apply/gate";
import { getSession } from "@/lib/apply/session";
import { MIN_OVERRIDE_REASON } from "@/lib/apply/apply-gates.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// What the Apply page shows above the Fill button before the fill: the
// evaluation verdict this application was sent against (and whether applying
// needs a recorded reason), and which tailored CV would be attached, in which
// state. Read-only. The same applyGateStatus call decides in /api/apply/fill,
// so the preview and the refusal cannot disagree.
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const application = (q.get("application") ?? "").trim();
  const confirmReport = (q.get("confirmReport") ?? "").trim();
  const company = (q.get("company") ?? "").trim();
  const sessionId = (q.get("sessionId") ?? "").trim();
  if (application && !/^\d{1,6}$/.test(application)) return Response.json({ error: "application must be a tracker number" }, { status: 400 });
  if (confirmReport && !/^\d{1,6}$/.test(confirmReport)) return Response.json({ error: "confirmReport must be a report number" }, { status: 400 });
  // The session's own title is the company fallback's only key for a pasted URL.
  const title = sessionId ? getSession(sessionId)?.title : undefined;
  try {
    const status = await applyGateStatus({ application, confirmReport, company, title });
    return Response.json({
      identity: status.identity ? { row: status.identity.row, report: status.identity.report, company: status.identity.company, role: status.identity.role, status: status.identity.status } : null,
      verdict: status.verdict ? { ...status.verdict, minReason: MIN_OVERRIDE_REASON } : null,
      cv: publicCv(status.cv),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "could not read the gate" }, { status: 500 });
  }
}
