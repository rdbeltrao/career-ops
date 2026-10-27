import path from "node:path";
import { pathToFileURL } from "node:url";
import { careerOpsRoot } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { getProfilePath } from "@/lib/core/profile-path.mjs";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { readJsonObject } from "@/lib/json-body";
import { renderCvTemplatePreview } from "@/lib/cv-template-preview.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function core() {
  const codeRoot = resolveCodeRoot(process.cwd(), process.env);
  const preferences = await import(/* webpackIgnore: true */ pathToFileURL(path.join(codeRoot, "lib/cv-template-preferences.mjs")).href);
  return { preferences, codeRoot, profilePath: getProfilePath(careerOpsRoot()), dir: path.join(codeRoot, "templates") };
}

function failure(error: unknown) {
  const problem = error as Error & { code?: string };
  return Response.json({ error: problem.message || "CV templates are unavailable.", code: problem.code }, { status: problem.code === "stale-revision" ? 409 : 400 });
}

export async function GET() {
  try {
    const { preferences, profilePath, dir } = await core();
    return Response.json(preferences.getCvTemplateState({ profilePath, dir }));
  } catch (error) { return failure(error); }
}

export async function PUT(req: Request) {
  const body = await readJsonObject<{ preferences?: unknown; revision?: unknown }>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  try {
    const { preferences, profilePath, dir } = await core();
    return Response.json(preferences.saveCvTemplatePreferences({ profilePath, dir, preferences: body.preferences, revision: body.revision, write: atomicWriteWithBackup }));
  } catch (error) { return failure(error); }
}

export async function POST(req: Request) {
  const body = await readJsonObject<{ preview?: boolean; template?: unknown; style?: unknown }>(req);
  if (!body || body.preview !== true || typeof body.template !== "string") return Response.json({ error: "A preview template is required." }, { status: 400 });
  try {
    const { codeRoot } = await core();
    return Response.json({ html: await renderCvTemplatePreview({ codeRoot, template: body.template, style: body.style ?? {} }) });
  } catch (error) { return failure(error); }
}
