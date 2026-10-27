import { careerOpsRoot } from "@/lib/career-ops";
import { detectClis } from "@/lib/clis";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { readJsonObject } from "@/lib/json-body";
import { normalizeAiSettings } from "@/lib/ai-settings.mjs";
import { AiSettingsError, readAiSettings, saveAiSettings } from "@/lib/ai-settings-store.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

function failure(error: unknown) {
  if (error instanceof AiSettingsError) return Response.json({ error: error.message }, { status: error.status, headers });
  return Response.json({ error: "AI settings could not be accessed. Your changes have not been saved." }, { status: 500, headers });
}

export async function GET() {
  try {
    return Response.json({ settings: readAiSettings(careerOpsRoot()) }, { headers });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  const body = await readJsonObject(request);
  if (!body) return Response.json({ error: "Expected AI settings as a JSON object." }, { status: 400, headers });
  let settings;
  try { settings = normalizeAiSettings(body); }
  catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid AI settings." }, { status: 400, headers });
  }
  if (settings.cliId && !detectClis().some((cli) => cli.id === settings.cliId && cli.installed)) {
    return Response.json({ error: "The selected AI tool is not installed. Choose an installed tool in Config." }, { status: 400, headers });
  }
  try {
    saveAiSettings(careerOpsRoot(), settings, atomicWriteWithBackup);
    return Response.json({ settings }, { headers });
  } catch (error) { return failure(error); }
}
