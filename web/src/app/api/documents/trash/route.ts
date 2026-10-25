import { careerOpsRoot } from '@/lib/career-ops';
import { listDocumentTrash } from '@/lib/document-store.mjs';
import { documentErrorResponse, documentRequestGuard } from '@/lib/document-route.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const blocked = documentRequestGuard(req);
  if (blocked) return blocked;
  try {
    return Response.json({ documents: listDocumentTrash(careerOpsRoot()) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return documentErrorResponse(error); }
}
