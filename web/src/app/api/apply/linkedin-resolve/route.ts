import { resolveLinkedInApply } from "@/lib/apply/linkedin-apply";
import { readJsonObject } from "@/lib/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Look up the employer's application form behind a LinkedIn posting's
// "Apply on company website", for a row the crawl read before it learned to.
// Runs linkedin-apply.mjs, which opens the one posting page headless in the
// signed-in crawl profile and records what it finds in data/linkedin-apply.json.
export async function POST(req: Request) {
  const body = await readJsonObject<{ url?: string }>(req);
  if (!body || typeof body.url !== "string") return Response.json({ error: "url required" }, { status: 400 });
  const result = await resolveLinkedInApply(body.url.trim());
  if (!result.ok) return Response.json({ error: result.error, loginRequired: !!result.loginRequired }, { status: result.status });
  return Response.json({ applyUrl: result.entry.applyUrl || null, kind: result.entry.kind, id: result.entry.id });
}
