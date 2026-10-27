"use client";

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { FileText, Loader2, Mail, RotateCcw, TriangleAlert } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { CostBadge } from "@/components/cost/cost-badge";
import { pdfButtonState } from "@/lib/pdf-button-state.mjs";

// Fires the real career-ops `cover` mode (worker kind "cover") for THIS
// application. Context and the JD supply the facts; this form collects only
// optional direction. The draft lands in the run log for review.

const fieldClass =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-brand/50 focus:outline-none";

export function CoverDraftButton({ n, company }: { n: string; company: string }) {
  const { jobs, startJob } = useJobs();
  const [open, setOpen] = useState(false);
  const [savedBrief, setSavedBrief] = useState<Record<string, string> | null>(null);
  const job = useMemo(
    () => jobs.filter((j) => j.kind === "cover" && j.input === n).sort((a, b) => b.startedAt - a.startedAt)[0],
    [jobs, n],
  );
  // A cover run can finish with VERDICT 1/5 and no letter. Only treat a real
  // draft as ready; weak verdicts surface as a retry failure beside the form.
  const base = pdfButtonState(job, false);
  const weakDraft = job?.status === "done" && job.result?.score != null && job.result.score < 2;
  const state = weakDraft
    ? {
        kind: "idle" as const,
        failure: {
          jobId: job.id,
          reason: job.result?.summary || "The cover run finished without a usable draft.",
        },
      }
    : base;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const brief = { instructions: String(data.get("instructions") ?? "").trim() };
    setSavedBrief(brief);
    startJob({ title: `Cover letter · ${company}`, subtitle: "draft for this role", kind: "cover", input: n, page: `/pipeline/${n}`, brief });
    setOpen(false);
  };

  if (state.kind === "running")
    return (
      <Link href={`/jobs/${state.jobId}`} className="inline-flex items-center justify-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-3 py-1 text-xs font-medium text-brand max-sm:min-h-[44px]">
        <Loader2 className="size-3.5 motion-safe:animate-spin" /> Drafting cover letter…
      </Link>
    );

  return (
    <>
      {state.kind === "ready" && job ? (
        <span className="inline-flex items-center gap-1">
          <Link
            href={`/jobs/${job.id}`}
            className="inline-flex items-center justify-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-400 max-sm:min-h-[44px]"
          >
            <FileText className="size-3.5" /> View cover letter draft
          </Link>
          <button
            onClick={() => setOpen((o) => !o)}
            title="Draft the cover letter again"
            aria-expanded={open}
            className="inline-flex items-center justify-center rounded-full p-1 text-faint transition-colors hover:text-brand max-sm:min-h-[44px] max-sm:min-w-[44px]"
          >
            <RotateCcw className="size-3" />
          </button>
        </span>
      ) : (
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
          title="Draft a cover letter for this role with your AI CLI"
        >
          <Mail className="size-3.5" /> Draft cover letter
        </button>
      )}
      {state.failure && (
        <Link
          href={`/jobs/${state.failure.jobId}`}
          role="alert"
          title="Open the run log"
          className="inline-flex max-w-md items-start gap-1 text-xs text-red-700 hover:underline dark:text-red-400"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>Cover letter not drafted. {state.failure.reason}</span>
        </Link>
      )}
      {open && (
        <form onSubmit={submit} aria-label="Cover letter draft" className="basis-full rounded-2xl border border-border bg-surface/50 p-4">
          <p className="mb-3 text-sm text-muted">Draft a concise letter from your Context and the job description.</p>
          <label className="mb-4 block text-sm font-medium text-foreground">
            Additional instructions (optional)
            <textarea name="instructions" maxLength={3000} rows={3} defaultValue={savedBrief?.instructions ?? ""} placeholder="Anything to emphasize, a personal connection, or a tone preference…" className={fieldClass} />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground shadow-sm transition-colors hover:bg-brand-200 max-sm:min-h-[44px]">
              <Mail className="size-3.5" /> Draft letter
            </button>
            <CostBadge kind="spend" size="xs" />
            <button type="button" onClick={() => setOpen(false)} className="text-xs text-muted hover:text-brand max-sm:min-h-[44px]">
              Cancel
            </button>
          </div>
        </form>
      )}
    </>
  );
}
