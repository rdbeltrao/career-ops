import { resolveLinkedInApply } from "@/lib/apply/linkedin-apply";
import { applyTarget } from "@/lib/apply/apply-target.mjs";
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
  const url = body.url.trim();
  const result = await resolveLinkedInApply(url);
  if (!result.ok) return Response.json({ error: result.error, loginRequired: !!result.loginRequired }, { status: result.status });
  // The same decision the report page makes: an employer URL counts only when
  // it is an http(s) page that is not itself a login-gated board.
  const target = applyTarget(url, result.entry);
  if (target.kind === "proxy" && target.url) return Response.json({ applyUrl: target.url, kind: result.entry.kind, id: result.entry.id });
  if (result.entry.kind === "easy-apply") return Response.json({ applyUrl: null, kind: "easy-apply", id: result.entry.id });
  return Response.json({ error: "LinkedIn links this posting to a page career-ops cannot open in the form proxy." }, { status: 404 });
}
