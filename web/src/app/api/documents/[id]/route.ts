import { careerOpsRoot } from '@/lib/career-ops';
import { createDocumentStore } from '@/lib/document-store.mjs';
import { handleDocumentRequest } from '@/lib/document-route.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

async function handle(req: Request, context: Context) {
  const { id } = await context.params;
  return handleDocumentRequest(req, id, { store: createDocumentStore(careerOpsRoot()) });
}

export { handle as GET, handle as PUT, handle as DELETE, handle as POST };
