"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, FileText, Loader2, Trash2, Undo2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EditorChoice } from "./editor-choice";

type DocumentItem = { id: string; filename: string; kind: "cv" | "cover" | "unknown"; date: string | null; reportId: string | null; applicationId: string | null; format: string | null; mtimeMs: number };
type Trashed = { id: string; filename: string; restoreToken: string; deletedAt: string };

async function json(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The document request failed.");
  return data;
}

export function DocumentsLibrary() {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [trash, setTrash] = useState<Trashed[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const [items, removed] = await Promise.all([
      fetch("/api/documents", { cache: "no-store" }).then(json),
      fetch("/api/documents/trash", { cache: "no-store" }).then(json),
    ]);
    setDocuments(items); setTrash(removed.documents);
  }, []);
  useEffect(() => { refresh().catch((e: Error) => setError(e.message)).finally(() => setLoading(false)); }, [refresh]);
  useEffect(() => {
    const changed = () => { void refresh().catch((e: Error) => setError(e.message)); };
    window.addEventListener("co-documents-changed", changed);
    return () => window.removeEventListener("co-documents-changed", changed);
  }, [refresh]);

  const remove = async (document: DocumentItem) => {
    if (busy) return;
    setBusy(document.id); setError(null); setNotice(null);
    try {
      const api = `/api/documents/${encodeURIComponent(document.id)}`;
      const current = await fetch(api, { cache: "no-store" }).then(json);
      if (!window.confirm(`Move ${current.filename} to Trash? You can restore it from Documents.`)) return;
      await fetch(api, { method: "DELETE", headers: { "If-Match": current.revision } }).then(json);
      await refresh(); setNotice(`${document.filename} moved to Trash.`);
    } catch (e) { setError(e instanceof Error ? e.message : "Removal failed."); }
    finally { setBusy(null); }
  };
  const restore = async (document: Trashed) => {
    if (busy) return;
    setBusy(document.restoreToken); setError(null); setNotice(null);
    try {
      await fetch(`/api/documents/${encodeURIComponent(document.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restore", restoreToken: document.restoreToken }) }).then(json);
      await refresh(); setNotice(`${document.filename} restored.`);
    } catch (e) { setError(e instanceof Error ? e.message : "Restoring failed."); }
    finally { setBusy(null); }
  };

  return <div className="mx-auto max-w-6xl space-y-6">
    <header><h1 className="text-2xl font-semibold tracking-tight">Documents</h1><p className="mt-1 text-sm text-muted">Open, update, or remove generated CVs and cover letters. Choose Classic for CV sections or Visual to edit the PDF itself.</p></header>
    {error && <div role="alert" className="rounded-lg border border-red-500/30 p-3 text-sm text-red-700 dark:text-red-400">{error}<button className="ml-3 underline" onClick={() => { setError(null); refresh().catch((e: Error) => setError(e.message)); }}>Try again</button></div>}
    {notice && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}
    {loading ? <div role="status" className="flex h-48 items-center justify-center gap-2 text-muted"><Loader2 className="size-6 animate-spin" />Loading documents…</div> : <>
      {!documents.length && <div className="rounded-xl border border-dashed border-border p-10 text-center"><FileText className="mx-auto mb-3 size-7 text-muted" /><h2 className="font-medium">No documents found</h2><p className="mt-1 text-sm text-muted">Generated CVs and cover letters will appear here.</p></div>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{documents.map((document) => <Card key={document.id} className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-2"><FileText className="mt-0.5 size-5 shrink-0 text-brand" /><h2 className="break-all text-sm font-medium" title={document.filename}>{document.filename}</h2></div>
        <div className="flex flex-wrap gap-2"><Badge tone="info">{document.kind === "cv" ? "CV" : document.kind === "cover" ? "Cover letter" : "Document"}</Badge>{document.date && <Badge tone="muted">{document.date}</Badge>}{document.format && <Badge tone="muted">{document.format.toUpperCase()}</Badge>}</div>
        <div className="mt-auto"><EditorChoice id={document.id} kind={document.kind} applicationId={document.applicationId} /></div>
        <div className="flex items-center justify-between border-t border-border pt-3"><a className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-brand" href={`/api/documents?id=${encodeURIComponent(document.id)}`} target="_blank" rel="noreferrer">Open PDF<ExternalLink className="size-3.5" /></a><Button variant="ghost" size="sm" disabled={!!busy} onClick={() => remove(document)}><Trash2 className="size-3.5" />Move to Trash</Button></div>
      </Card>)}</div>
      {!!trash.length && <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer font-medium">Trash ({trash.length})</summary><p className="mt-2 text-xs text-muted">Removed PDFs stay here until restored. Restore never replaces another file.</p><ul className="mt-3 divide-y divide-border">{trash.map((document) => <li key={document.restoreToken} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="break-all text-sm">{document.filename}</p><p className="text-xs text-muted">{new Date(document.deletedAt).toLocaleString()}</p></div><Button variant="outline" size="sm" disabled={!!busy} onClick={() => restore(document)}><Undo2 className="size-3.5" />Restore PDF</Button></li>)}</ul></details>}
    </>}
  </div>;
}
