import { loadLinkedInState, saveSearchOp } from "@/lib/linkedin-settings";
import { readJsonObject } from "@/lib/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Add, edit or toggle one LinkedIn search in portals.yml. The edit changes only
// that entry's lines and must parse to exactly the intended document
// (linkedin-searches.mjs); a backup of the previous file is kept.
export async function POST(req: Request) {
  const body = await readJsonObject(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  const r = saveSearchOp(body);
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  // The write already happened: a failure to re-read must not be reported as
  // "not changed" (a retried add would then fail as a duplicate).
  try {
    return Response.json({ saved: true, state: await loadLinkedInState() });
  } catch {
    return Response.json({ saved: true, state: null });
  }
}
