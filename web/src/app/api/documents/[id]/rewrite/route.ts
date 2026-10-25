import { careerOpsRoot } from "@/lib/career-ops";
import { readDocument } from "@/lib/document-store.mjs";
import { handlePdfRewrite } from "@/lib/pdf-rewrite.mjs";
import { runRewrite } from "@/lib/cv-studio/rewrite-run";
import { unsupportedRewriteClaims } from "@/lib/cv-studio/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 150;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const root = careerOpsRoot();
  return handlePdfRewrite(req, id, {
    readDocument: (documentId: string) => readDocument(root, documentId),
    runRewrite,
    unsupportedClaims: unsupportedRewriteClaims,
  });
}
