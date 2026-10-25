import path from "node:path";
import Link from "next/link";
import { redirect } from "next/navigation";
import { careerOpsRoot, findApplication, readReport, pdfPathStatusForReport } from "@/lib/career-ops";
import { encodeId } from "@/lib/documents";
import { reportNumberFor } from "@/lib/apply-checklist.mjs";

export const dynamic = "force-dynamic";

export default async function VisualCvPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // EVIDENCE: the shared resolver honors the PDF index, including missing-file tombstones.
  const reportNumber = /^\d+$/.test(id) ? reportNumberFor(id, findApplication(id), readReport(id)?.file ?? null) : null;
  const result = reportNumber !== null ? await pdfPathStatusForReport(String(reportNumber)) : null;
  if (result?.status === "found" && path.dirname(result.path) === path.resolve(careerOpsRoot(), "output")) {
    redirect(`/documents/${encodeId(path.basename(result.path))}/edit`);
  }
  return <div className="mx-auto max-w-xl space-y-4 p-6">
    <h1 className="text-2xl font-semibold">No generated PDF available</h1>
    <p className="text-muted">Generate a CV from the report, or restore a removed PDF from Documents.</p>
    <div className="flex gap-4"><Link className="text-brand underline" href={`/pipeline/${encodeURIComponent(id)}/cv-studio`}>Classic editor</Link><Link className="text-brand underline" href="/documents">Documents</Link></div>
  </div>;
}
