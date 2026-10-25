import { careerOpsRoot, isRegularContainedFile, readApplications } from "@/lib/career-ops";
import { resolvePdfIndexPath } from "@/lib/core/pdf-index";
import { handleDocumentsRequest } from "@/lib/documents";
import { applicationIdForDocument } from "@/lib/document-editing.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const root = careerOpsRoot();
  const manifestPath = await resolvePdfIndexPath();
  const response = await handleDocumentsRequest(req, root, manifestPath, isRegularContainedFile);
  if (!response.ok || new URL(req.url).searchParams.has("id")) return response;
  const documents = await response.json();
  const applications = readApplications();
  return Response.json(documents.map((document: { reportId: string | null }) => ({
    ...document, applicationId: applicationIdForDocument(document, applications),
  })), { headers: { "Cache-Control": "no-store" } });
}
