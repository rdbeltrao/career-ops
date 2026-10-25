"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Loader2, Redo2, Save, Sparkles, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { readSavedCliId } from "@/lib/saved-cli";
import { editorLinks, proposalMatches } from "@/lib/document-editing.mjs";
import { readPdfDraft, writePdfDraft, clearPdfDraft } from "@/lib/pdf-drafts.mjs";
import { usePdfEditor, type EditorEvent } from "./use-pdf-editor";

type Metadata = { id: string; filename: string; revision: string; versions: { id: string; createdAt: string }[] };
type Selection = { paragraphId: string; text: string; pageIndex: number };
type Proposal = { paragraphId: string; original: string; text: string; warning?: string | null };
type Recovered = { revision: string; bytes: ArrayBuffer; pdfDirty: boolean; selection: Selection | null; draft: string };

async function jsonResponse(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "The document request failed.");
  return body;
}
const fieldClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-60";

export function VisualPdfEditor({ id }: { id: string }) {
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [classic, setClassic] = useState<string | null>(null);
  const [file, setFile] = useState<{ bytes: ArrayBuffer; filename: string } | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [draft, setDraft] = useState("");
  const [instruction, setInstruction] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [recoveryConflict, setRecoveryConflict] = useState<Recovered | null>(null);
  const [recoveryWarning, setRecoveryWarning] = useState("");
  const selectionRef = useRef(selection);
  const draftRef = useRef(draft);
  const metadataRef = useRef<Metadata | null>(null);
  const pdfBytes = useRef<ArrayBuffer | null>(null);
  const pdfDirty = useRef(false);
  const recovering = useRef<Recovered | null>(null);
  const aiGeneration = useRef(0);
  const loadGeneration = useRef(0);
  const api = `/api/documents/${encodeURIComponent(id)}`;
  const draftDirty = !!selection && draft !== selection.text;

  const persist = useCallback(() => {
    if (!metadataRef.current || !pdfBytes.current) return;
    const unsavedText = selectionRef.current && draftRef.current !== selectionRef.current.text;
    const saving = pdfDirty.current || unsavedText
      ? writePdfDraft(id, { revision: metadataRef.current.revision, bytes: pdfBytes.current, pdfDirty: pdfDirty.current, selection: selectionRef.current, draft: draftRef.current })
      : clearPdfDraft(id);
    void saving.then(({ persistent }: { persistent: boolean }) => {
      if (!persistent) setRecoveryWarning("Browser storage is unavailable. Draft recovery works only while this tab stays open.");
    });
  }, [id]);

  const event = useCallback((message: EditorEvent) => {
    if (message.type === "selection") {
      const next = message.paragraphId ? { paragraphId: message.paragraphId, text: message.text!, pageIndex: message.pageIndex! } : null;
      // Repeated clicks can arrive after typing starts. The same selection must
      // not replace pending text with the paragraph's original content.
      const current = selectionRef.current;
      if (next?.paragraphId === current?.paragraphId && next?.text === current?.text && next?.pageIndex === current?.pageIndex) return;
      selectionRef.current = next;
      draftRef.current = next?.text ?? "";
      setSelection(next); setDraft(next?.text ?? ""); setProposal(null);
      aiGeneration.current += 1;
      if (!recovering.current) persist();
    } else if (message.type === "changed") {
      if (message.bytes) pdfBytes.current = message.bytes;
      pdfDirty.current = true;
      setDirty(true);
      setHistory({ canUndo: !!message.canUndo, canRedo: !!message.canRedo });
      setNotice("");
      persist();
    } else if (message.type === "error") setError(message.message || "The PDF could not be edited.");
  }, [persist]);
  const { frame, session, ready, command } = usePdfEditor(id, event);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setError(null); setLoaded(false); setFile(null); setSelection(null); setProposal(null);
    selectionRef.current = null; draftRef.current = ""; setDraft(""); aiGeneration.current += 1;
    const meta = await fetch(api, { cache: "no-store" }).then(jsonResponse) as Metadata;
    const response = await fetch(`${api}?format=pdf`, { cache: "no-store" });
    if (!response.ok) { await jsonResponse(response); return; }
    const revision = response.headers.get("etag")?.replace(/^"|"$/g, "");
    if (!revision) throw new Error("The PDF revision could not be checked. Reload the document.");
    const bytes = await response.arrayBuffer();
    const recovered = await readPdfDraft(id) as Recovered | null;
    if (generation !== loadGeneration.current) return;
    const matching = recovered?.revision === revision ? recovered : null;
    metadataRef.current = { ...meta, revision };
    pdfBytes.current = matching?.pdfDirty ? matching.bytes : bytes;
    pdfDirty.current = matching?.pdfDirty ?? false;
    recovering.current = matching;
    setRecoveryConflict(recovered && !matching ? recovered : null);
    setMetadata(metadataRef.current);
    setFile({ bytes: pdfBytes.current, filename: meta.filename });
    setDirty(pdfDirty.current); setHistory({ canUndo: false, canRedo: false });
  }, [api, id]);

  useEffect(() => {
    let active = true;
    void load().catch((e: Error) => active && setError(e.message));
    return () => { active = false; loadGeneration.current += 1; };
  }, [load]);
  useEffect(() => {
    let active = true;
    fetch("/api/documents", { cache: "no-store" }).then(jsonResponse).then((documents: { id: string; kind: string; applicationId: string | null }[]) => {
      const document = documents.find((d) => d.id === id);
      if (active) setClassic(document ? editorLinks(document).classic : null);
    }).catch(() => {});
    return () => { active = false; };
  }, [id]);
  useEffect(() => {
    if (!ready || !file) return;
    let active = true;
    command("load", file).then(async (result) => {
      if (!active) return;
      setWarnings(result.warnings ?? []); setLoaded(true);
      const recovered = recovering.current;
      if (recovered) {
        if (recovered.selection) {
          try {
            const selected = await command("select", { paragraphId: recovered.selection.paragraphId });
            if (selected.text === recovered.selection.text) {
              draftRef.current = recovered.draft; setDraft(recovered.draft);
            } else setRecoveryConflict(recovered);
          } catch { setRecoveryConflict(recovered); }
        }
        recovering.current = null;
        setNotice("Recovered your unsaved changes from this device.");
      }
    }).catch((e: Error) => active && setError(e.message));
    return () => { active = false; };
  }, [command, ready, file]);

  useEffect(() => {
    if (!dirty && !draftDirty) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (target && target.getAttribute("target") !== "_blank" && !window.confirm("Leave without saving your PDF changes?")) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", leave);
    document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", leave); document.removeEventListener("click", navigate, true); };
  }, [dirty, draftDirty]);

  const run = async (label: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(label); setError(null); setNotice("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "The operation failed."); }
    finally { setBusy(""); }
  };
  const applyText = async (text: string) => {
    const selected = selectionRef.current;
    if (!selected) throw new Error("Choose a paragraph first.");
    await command("replace", { paragraphId: selected.paragraphId, expectedText: selected.text, text });
    setProposal(null);
  };
  const save = () => run("Saving PDF", async () => {
    if (!metadata) return;
    if (draftDirty) await applyText(draft);
    const exported = await command("export");
    if (!exported.bytes) throw new Error("The editor returned no PDF.");
    const saved = await fetch(api, { method: "PUT", headers: { "Content-Type": "application/pdf", "If-Match": metadata.revision }, body: exported.bytes }).then(jsonResponse) as Metadata;
    metadataRef.current = saved; pdfBytes.current = exported.bytes; pdfDirty.current = false;
    await clearPdfDraft(id);
    setMetadata(saved); setDirty(false); setNotice("PDF saved. The previous version is available below.");
  });
  const rewrite = () => run("Rewriting paragraph", async () => {
    const selected = selectionRef.current;
    if (!selected || !metadata) return;
    const cliId = readSavedCliId();
    if (!cliId) throw new Error("Choose your AI in Config first, or edit the text by hand.");
    const generation = ++aiGeneration.current;
    const result = await fetch(`${api}/rewrite`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: selected.text, instruction, cliId, revision: metadata.revision }) }).then(jsonResponse);
    const next = { paragraphId: selected.paragraphId, original: selected.text, text: result.text, warning: result.warning };
    if (generation === aiGeneration.current && proposalMatches(next, selectionRef.current) && draftRef.current === selected.text) setProposal(next);
  });
  const restore = (versionId: string) => run("Restoring version", async () => {
    if (!metadata || !window.confirm("Restore this saved version? Your current saved PDF will also be kept in history.")) return;
    await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restore-version", versionId, revision: metadata.revision }) }).then(jsonResponse);
    await clearPdfDraft(id);
    await load(); setNotice("Previous version restored.");
  });

  return <div className="mx-auto max-w-[1600px] space-y-4 p-4 sm:p-6">
    <Link href="/documents" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-brand"><ArrowLeft className="size-4" />Documents</Link>
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-semibold">Visual PDF editor</h1><p className="mt-1 break-all text-sm text-muted">{metadata?.filename ?? "Opening document…"}</p></div>
      <div className="flex flex-wrap gap-2">
        {classic && <Link href={classic} className="rounded-lg border border-border px-3 py-2 text-sm hover:text-brand">Classic editor</Link>}
        <Button variant="outline" disabled={!loaded || !!busy || !history.canUndo || draftDirty} onClick={() => run("Undoing", async () => { await command("undo"); })}><Undo2 className="size-4" />Undo</Button>
        <Button variant="outline" disabled={!loaded || !!busy || !history.canRedo || draftDirty} onClick={() => run("Redoing", async () => { await command("redo"); })}><Redo2 className="size-4" />Redo</Button>
        <Button disabled={!loaded || !!busy || !!recoveryConflict || (!dirty && !draftDirty)} onClick={save}><Save className="size-4" />Save PDF</Button>
      </div>
    </header>
    <p className="text-sm text-muted">Click a paragraph on the page to edit it. Visual edits update this PDF; Classic edits the CV source and generates a new PDF. Longer sections and page layout changes belong in Classic.</p>
    {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-400">{error}<button className="ml-3 underline" onClick={() => { if ((!dirty && !draftDirty) || window.confirm("Discard unsaved changes and reload?")) void clearPdfDraft(id).then(load).catch((e: Error) => setError(e.message)); }}>Reload document</button></div>}
    {recoveryWarning && <p role="status" className="text-sm text-amber-700 dark:text-amber-400">{recoveryWarning}</p>}
    {recoveryConflict && <div role="alert" className="space-y-3 rounded-lg border border-amber-500/40 p-4 text-sm"><p>A recovered draft could not be applied to this version of the PDF. Download it before continuing, or discard it.</p>{recoveryConflict.draft && <textarea className={fieldClass} aria-label="Recovered paragraph text" readOnly value={recoveryConflict.draft} rows={3} />}<div className="flex gap-2"><Button variant="outline" onClick={() => { const url = URL.createObjectURL(new Blob([recoveryConflict.bytes], { type: "application/pdf" })); const link = document.createElement("a"); link.href = url; link.download = `recovered-${metadata?.filename ?? "document.pdf"}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Download recovered PDF</Button><Button variant="ghost" onClick={() => { void clearPdfDraft(id).then(load).catch((e: Error) => setError(e.message)); }}>Discard recovered draft</Button></div></div>}
    {notice && <p role="status" className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400"><Check className="size-4" />{notice}</p>}
    {warnings.map((warning) => <p key={warning} className="rounded-lg bg-amber-500/10 p-3 text-sm">{warning}</p>)}
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_350px]">
      <section className="relative min-w-0 overflow-hidden rounded-xl border border-border bg-surface" aria-label="PDF pages">
        {!loaded && <div role="status" className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-surface/90"><Loader2 className="size-5 animate-spin" />{error ? "PDF unavailable" : "Opening PDF…"}</div>}
        {session && <iframe ref={frame} src={`/pdf-editor/index.html?session=${encodeURIComponent(session)}`} title="Editable PDF pages" sandbox="allow-scripts allow-same-origin" inert={!!busy || draftDirty || !!recoveryConflict} className="h-[65vh] w-full xl:h-[78vh]" style={{ pointerEvents: busy || draftDirty || recoveryConflict ? "none" : undefined }} />}
      </section>
      <aside className="space-y-4" aria-label="Paragraph editor" inert={!!recoveryConflict}>
        <div className="space-y-3 rounded-xl border border-border bg-surface p-4">
          <h2 className="font-semibold">{selection ? `Selected paragraph · page ${selection.pageIndex + 1}` : "Choose a paragraph"}</h2>
          <p className="text-xs text-muted">{selection ? "Edit the text, then apply it to see the result on the PDF." : "Select outlined text on a page. Scanned images cannot be edited as text."}</p>
          <label className="block text-sm font-medium" htmlFor="paragraph-text">Paragraph text</label>
          <textarea id="paragraph-text" className={fieldClass} rows={7} maxLength={4000} disabled={!selection || !!busy} value={draft} onChange={(e) => { draftRef.current = e.target.value; setDraft(e.target.value); setProposal(null); aiGeneration.current += 1; persist(); }} />
          <div className="flex gap-2"><Button disabled={!selection || !draft.trim() || !draftDirty || !!busy} onClick={() => run("Applying text", () => applyText(draft))}>Apply text</Button><Button variant="ghost" disabled={!draftDirty || !!busy} onClick={() => { setDraft(selection?.text ?? ""); draftRef.current = selection?.text ?? ""; persist(); }}>Discard text changes</Button></div>
          {draftDirty && <p className="text-xs text-muted">Apply or discard this text before selecting another paragraph.</p>}
        </div>
        <div className="space-y-3 rounded-xl border border-border bg-surface p-4">
          <h2 className="flex items-center gap-2 font-semibold"><Sparkles className="size-4 text-brand" />Rewrite with AI</h2>
          <label className="block text-sm" htmlFor="rewrite-instruction">What should change?</label>
          <textarea id="rewrite-instruction" className={fieldClass} rows={3} maxLength={1000} placeholder="Make this paragraph shorter and emphasize leadership." value={instruction} disabled={!selection || !!busy} onChange={(e) => { setInstruction(e.target.value); setProposal(null); }} />
          <p className="text-xs text-muted">Uses your AI from Config and its token allowance. You review each suggestion before applying it.</p>
          <Button variant="outline" disabled={!selection || !instruction.trim() || draftDirty || !!busy} onClick={rewrite}><Sparkles className="size-4" />Suggest rewrite</Button>
          {proposal && <div className="space-y-3 border-t border-border pt-3"><h3 className="text-sm font-medium">Suggested text</h3><p className="whitespace-pre-wrap text-sm">{proposal.text}</p>{proposal.warning && <p className="text-xs text-amber-700 dark:text-amber-400">{proposal.warning}</p>}<div className="flex gap-2"><Button disabled={!!busy || !proposalMatches(proposal, selection)} onClick={() => run("Applying suggestion", async () => { if (!proposalMatches(proposal, selectionRef.current)) throw new Error("The paragraph changed. Request a new suggestion."); await applyText(proposal.text); })}>Use suggestion</Button><Button variant="ghost" disabled={!!busy} onClick={() => setProposal(null)}>Reject</Button></div></div>}
        </div>
        {!!busy && <p role="status" className="flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" />{busy}…</p>}
        {!!metadata?.versions.length && <details className="rounded-xl border border-border bg-surface p-4"><summary className="cursor-pointer text-sm font-medium">Saved versions ({metadata.versions.length})</summary><ul className="mt-3 space-y-2">{metadata.versions.map((version) => <li key={version.id} className="flex items-center justify-between gap-2 text-xs"><span>{new Date(version.createdAt).toLocaleString()}</span><Button variant="ghost" size="sm" disabled={!!busy || dirty || draftDirty} onClick={() => restore(version.id)}>Restore</Button></li>)}</ul></details>}
        <p className="text-xs text-muted">Powered by <a className="underline" href="/vendor/bentopdf/SOURCE.md" target="_blank" rel="noreferrer">BentoPDF · open-source notices</a>. PDF editing stays on this device.</p>
      </aside>
    </div>
  </div>;
}
