import Link from "next/link";
import { FilePenLine, SlidersHorizontal } from "lucide-react";
import { editorLinks } from "@/lib/document-editing.mjs";

export function EditorChoice({ id, applicationId, kind }: { id: string; applicationId?: string | null; kind: string }) {
  const links = editorLinks({ id, applicationId, kind });
  return (
    <div className="grid gap-2" aria-label="Choose an editor">
      {links.classic && <Link href={links.classic} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:border-brand/50 hover:text-brand">
        <SlidersHorizontal className="size-4 shrink-0" /><span><span className="block font-medium">Classic editor</span><span className="block text-xs text-muted">Review sections and regenerate the CV</span></span>
      </Link>}
      {!links.classic && kind === "cv" && <p className="text-xs text-muted">Classic needs a CV linked to an application.</p>}
      <Link href={links.visual} className="flex items-center gap-2 rounded-lg border border-brand/30 bg-brand-soft px-3 py-2 text-sm hover:border-brand/60">
        <FilePenLine className="size-4 shrink-0 text-brand" /><span><span className="block font-medium">Visual PDF editor</span><span className="block text-xs text-muted">Edit this PDF by hand or with AI</span></span>
      </Link>
    </div>
  );
}
