"use client";

import { useEffect, useRef } from "react";

export function UnsavedDialog({ open, busy, reload, onKeep, onDiscard, onSave }: {
  open: boolean;
  busy: boolean;
  reload: boolean;
  onKeep: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  return (
    <dialog ref={dialog} aria-labelledby="unsaved-title" aria-describedby="unsaved-description" onCancel={(event) => { event.preventDefault(); if (!busy) onKeep(); }} className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-border bg-surface p-6 text-foreground shadow-2xl backdrop:bg-black/45">
      <h2 id="unsaved-title" className="font-display text-xl">Unsaved changes</h2>
      <p id="unsaved-description" className="mt-3 text-sm leading-relaxed text-muted">{reload ? "Reloading replaces your unsaved draft with the latest saved page. Discard the draft only when you are ready." : "Save this page before continuing, or discard your changes. Keeping this page open preserves your draft."}</p>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <button autoFocus type="button" disabled={busy} onClick={onKeep} className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-hover disabled:opacity-50">Keep editing</button>
        <button type="button" disabled={busy} onClick={onDiscard} className="rounded-lg border border-border px-3 py-2 text-sm text-red-700 dark:text-red-300 hover:bg-surface-hover disabled:opacity-50">Discard changes</button>
        {!reload && <button type="button" disabled={busy} onClick={onSave} className="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-foreground disabled:opacity-50">{busy ? "Saving…" : "Save and continue"}</button>}
      </div>
    </dialog>
  );
}
