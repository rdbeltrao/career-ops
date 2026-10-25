import { Network } from "lucide-react";
import { LinkedInView } from "@/components/linkedin-view";
import { loadLinkedInState } from "@/lib/linkedin-settings";

export const dynamic = "force-dynamic";

export default async function LinkedInPage() {
  const state = await loadLinkedInState();
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="flex items-center gap-3">
        <Network className="size-6 text-brand" />
        <h1 className="font-display text-2xl tracking-tight text-landing">LinkedIn</h1>
      </div>
      <p className="mt-1.5 max-w-xl text-sm text-muted">
        The LinkedIn job searches career-ops reads in your own signed-in browser profile, a few pages at a person&apos;s
        pace. New postings land in the pipeline like any other board, with the employer&apos;s apply link when LinkedIn
        has one.
      </p>
      <p className="mt-1.5 text-xs text-faint">
        Backed by the <code className="text-muted">linkedin-browser</code> entries of <code className="text-muted">portals.yml</code>.
      </p>
      <div className="mt-6">
        <LinkedInView initial={state} />
      </div>
    </div>
  );
}
