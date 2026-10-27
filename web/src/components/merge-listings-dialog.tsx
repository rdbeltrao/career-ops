"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Loader2, Merge, X } from "lucide-react";
import type { Application } from "@/lib/career-ops";
import { mergeListings } from "@/lib/pipeline-merge.mjs";
import { postingHref, postingLabel } from "@/lib/posting-url.mjs";

export function MergeListingsDialog({ rows, onClose, onMerged }: {
  rows: Application[];
  onClose: () => void;
  onMerged: (kept: string, merged: string[]) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [keep, setKeep] = useState(rows[0].n);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await mergeListings(rows, keep);
      onMerged(String(result.kept), result.merged.map(String));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not merge listings.");
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      className="fixed inset-0 m-auto max-h-[85vh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface p-5 text-foreground shadow-xl backdrop:bg-black/50"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="font-display text-lg">Merge {rows.length} similar listings</h2>
          <p className="mt-1 text-sm text-muted">{rows[0].company} · {rows[0].role}</p>
        </div>
        <button type="button" disabled={busy} onClick={onClose} aria-label="Close merge dialog" className="rounded p-1 text-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50">
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <p id={descriptionId} className="mt-4 text-sm text-muted">
        Choose the listing to keep. Its score, report, date and status stay primary. Source links, reports and notes from the other listings are saved in its notes. A tracker backup is created.
      </p>
      <form onSubmit={submit} className="mt-4 space-y-4" aria-busy={busy}>
        <fieldset disabled={busy} className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Listing to keep</legend>
          {rows.map((row) => {
            const url = postingHref(row.url);
            return (
              <label key={row.n} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-sm focus-within:ring-2 focus-within:ring-brand/40">
                <input type="radio" name="keep-listing" value={row.n} checked={keep === row.n} onChange={() => setKeep(row.n)} className="mt-1" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">#{row.n} · {row.score || "No score"} · {row.date || "No date"}</span>
                  <span className="mt-0.5 block text-xs text-muted">{row.status}</span>
                  {url && <a href={url} target="_blank" rel="noreferrer" className="mt-1 block break-all text-xs text-brand hover:underline">{postingLabel(url)} · {url}</a>}
                </span>
              </label>
            );
          })}
        </fieldset>
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="rounded-md px-3 py-2 text-sm text-muted hover:text-foreground disabled:opacity-50">Cancel</button>
          <button type="submit" disabled={busy} className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-foreground disabled:opacity-50">
            {busy ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Merge aria-hidden="true" className="size-4" />}
            {busy ? "Merging…" : "Merge listings"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
