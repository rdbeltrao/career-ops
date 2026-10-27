import { findBin } from "@/lib/clis";
import { careerOpsCodeRoot } from "@/lib/career-ops";
import { discoverCodexModels } from "@/lib/codex-model-catalog.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const provider = query.get("provider") ?? "";
  if (query.get("cliId") !== "codex" || provider.length > 80 || (provider && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider))) {
    return Response.json({ error: "Choose Codex and a valid configured provider to list models." }, { status: 400, headers });
  }
  // JUDGMENT: custom/local providers have their own catalogs; never offer the
  // OpenAI account's models as suggestions for a different provider.
  if (provider && provider !== "openai") {
    return Response.json({ models: [], warning: "Use a custom model ID from this provider's own model list." }, { headers });
  }
  const binPath = findBin("codex");
  if (!binPath) return Response.json({ models: [], warning: "Codex is not installed. Install and sign in to Codex to list available models." }, { headers });
  const catalog = await discoverCodexModels({ binPath, provider, cwd: careerOpsCodeRoot() });
  return Response.json(catalog, { headers });
}
