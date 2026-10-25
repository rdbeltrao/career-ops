import { careerOpsRoot, portalsConfigPath } from '@/lib/career-ops';
import { getProfilePath } from '@/lib/core/profile-path.mjs';
import { atomicWriteWithBackup } from '@/lib/core/safe-write';
import { readJsonObject } from '@/lib/json-body';
import { WorkspaceError } from '@/lib/career-workspace.mjs';
import { CONFIG_FILES, readConfigFile, saveConfigFile } from '@/lib/config-files.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

function location() {
  const root = careerOpsRoot();
  return { root, portalsPath: portalsConfigPath(root), profilePath: getProfilePath(root) };
}

function failure(error: unknown) {
  if (error instanceof WorkspaceError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
  }
  return Response.json({ error: 'The configuration file could not be accessed. Your changes have not been saved.', code: 'file_error' }, { status: 500, headers });
}

export async function GET(request: Request) {
  try {
    const file = new URL(request.url).searchParams.get('file');
    // Listing files never reads their contents. Open only the selected file.
    return Response.json(file === null ? { files: CONFIG_FILES } : readConfigFile(location(), file), { headers });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  const body = await readJsonObject<Parameters<typeof saveConfigFile>[0]['request']>(request);
  if (!body) return Response.json({ error: 'Expected a JSON object.' }, { status: 400, headers });
  try {
    return Response.json(saveConfigFile({ location: location(), request: body, write: atomicWriteWithBackup }), { headers });
  } catch (error) { return failure(error); }
}
