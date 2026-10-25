import { VisualPdfEditor } from "@/components/documents/visual-pdf-editor";

export const dynamic = "force-dynamic";

export default async function EditDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VisualPdfEditor key={id} id={id} />;
}
