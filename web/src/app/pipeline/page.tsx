import { Suspense } from "react";
import { batchRunnerActive, evaluatedPostingKeys, pipelineSummary, readBatchStateText } from "@/lib/career-ops";
import { parseBatchState, splitInbox } from "@/lib/inbox-batch.mjs";
import { pendingInbox } from "@/lib/inbox-pending.mjs";
import { PipelineView } from "@/components/pipeline-view";
import { pipelineTab } from "@/lib/pipeline-navigation.mjs";

export const dynamic = "force-dynamic"; // always read fresh local files

// Tracker tabs show the inbox only as a count, so they get the count and not
// the postings. The inbox is most of the page payload on a large pipeline.
export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  const onInbox = pipelineTab(tab) === "INBOX";
  const { inbox, applications } = pipelineSummary();
  // Pending rows that already have a report (by posting key) are not inbox
  // work: reconcile-pipeline.mjs moves them, and until it runs they stay out.
  const pending = pendingInbox(inbox, evaluatedPostingKeys(applications));
  // Rows the background batch is evaluating or will evaluate are not inbox
  // work: they are counted, not listed, so nobody scores them a second time.
  const { listed, needsYou, background } = splitInbox(pending, parseBatchState(readBatchStateText()), { batchRunning: batchRunnerActive() });
  return (
    <Suspense>
      <PipelineView applications={applications} inbox={onInbox ? listed : null} inboxCount={needsYou} background={background} />
    </Suspense>
  );
}
