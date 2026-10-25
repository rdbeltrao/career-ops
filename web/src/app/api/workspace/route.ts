import { careerOpsRoot } from '@/lib/career-ops';
import { atomicWriteWithBackup } from '@/lib/core/safe-write';
import { readJsonObject } from '@/lib/json-body';
import { WorkspaceError } from '@/lib/career-workspace.mjs';
import { listWorkspaceDocuments, readWorkspaceDocument, saveWorkspaceDocument } from '@/lib/career-workspace-store.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store' };

function failure(error: unknown) {
  if (error instanceof WorkspaceError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
  }
  return Response.json({ error: 'The document could not be accessed. Your changes have not been saved.', code: 'file_error' }, { status: 500, headers });
}

// EVIDENCE: Next's bundled route-handler guide uses Web Request/Response APIs.
// The global proxy already applies the same-origin and loopback restrictions.
export async function GET(request: Request) {
  try {
    const document = new URL(request.url).searchParams.get('document');
    const root = careerOpsRoot();
    return Response.json(document === null ? listWorkspaceDocuments(root) : readWorkspaceDocument(root, document), { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  const body = await readJsonObject<Parameters<typeof saveWorkspaceDocument>[0]['request']>(request);
  if (!body) return Response.json({ error: 'Expected a JSON object.', code: 'invalid_request' }, { status: 400, headers });
  try {
    // No await inside the synchronous revision/read/merge/backup/write sequence.
    return Response.json(saveWorkspaceDocument({ root: careerOpsRoot(), request: body, write: atomicWriteWithBackup }), { headers });
  } catch (error) {
    return failure(error);
  }
}
