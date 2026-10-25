import { loadLinkedInState } from "@/lib/linkedin-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The LinkedIn page's state: the linkedin-browser searches in portals.yml, the
// crawl profile's session, the last crawl result and the schedules that run them.
export async function GET() {
  return Response.json(await loadLinkedInState());
}
