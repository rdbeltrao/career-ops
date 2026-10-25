import { startSignIn } from "@/lib/linkedin-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Open LinkedIn's sign-in page in a visible window of the crawl profile, on this
// machine. The user signs in there; career-ops never sees a credential.
export async function POST() {
  const r = await startSignIn();
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json({ started: true });
}
