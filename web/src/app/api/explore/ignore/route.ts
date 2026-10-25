import { ignoreOffers } from "@/lib/core/pipeline";
import type { DiscoveredOffer } from "@/lib/explore";
import { readJsonObject } from "@/lib/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Ignore" on an Explore card: record the chosen offers in data/scan-history.tsv
// as `skipped_ignored`, through the core's canonical writer, so later scans and
// the "new matches this week" feed leave them out. No tokens are spent.
export async function POST(req: Request) {
  const body = await readJsonObject<{ offers?: unknown }>(req);
  if (!body) return Response.json({ ignored: 0, error: "bad request" }, { status: 400 });
  const offers = Array.isArray(body.offers) ? (body.offers as DiscoveredOffer[]) : [];
  if (offers.length === 0) return Response.json({ ignored: 0 });

  const result = await ignoreOffers(offers);
  return Response.json(result, { status: result.error ? 500 : 200 });
}
