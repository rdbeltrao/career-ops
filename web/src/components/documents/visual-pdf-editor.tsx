"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Loader2, Redo2, Save, Sparkles, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { readSavedCliId } from "@/lib/saved-cli";
import { editorLinks } from "@/lib/document-editing.mjs";
import { pdfTargetsMatch } from "@/lib/pdf-editor-state.mjs";
import { readPdfDraft, writePdfDraft, clearPdfDraft } from "@/lib/pdf-drafts.mjs";
import { usePdfEditor, type EditorEvent, type InlineState, type PdfTarget } from "./use-pdf-editor";

type Metadata = { id: string; filename: string; revision: string; versions: { id: string; createdAt: string }[] };
type Selection = PdfTarget;
type Scope = { title: string; targets: PdfTarget[] };
type Proposal = { original: PdfTarget[]; replacements: { paragraphId: string; text: string }[]; warning?: string | null };
type Recovered = { revision: string; bytes: ArrayBuffer; pdfDirty: boolean; selection: Selection | null; draft: string; inlineState?: InlineState };

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
  const [pendingDraft, setPendingDraft] = useState(false);
  const [scope, setScope] = useState<Scope | null>(null);
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
  const inlineStateRef = useRef<InlineState | undefined>(undefined);
  const scopeRef = useRef<Scope | null>(null);
  const previewing = useRef(false);
  const saveAction = useRef<() => void>(() => {});
  const metadataRef = useRef<Metadata | null>(null);
  const pdfBytes = useRef<ArrayBuffer | null>(null);
  const pdfDirty = useRef(false);
  const recovering = useRef<Recovered | null>(null);
  const aiGeneration = useRef(0);
  const loadGeneration = useRef(0);
  const api = `/api/documents/${encodeURIComponent(id)}`;
  const draftDirty = pendingDraft;

  const persist = useCallback(() => {
    if (!metadataRef.current || !pdfBytes.current) return;
    const unsavedText = selectionRef.current && (draftRef.current !== selectionRef.current.text || inlineStateRef.current);
    const saving = pdfDirty.current || unsavedText
      ? writePdfDraft(id, { revision: metadataRef.current.revision, bytes: pdfBytes.current, pdfDirty: pdfDirty.current, selection: selectionRef.current, draft: draftRef.current, inlineState: inlineStateRef.current })
      : clearPdfDraft(id);
    void saving.then(({ persistent }: { persistent: boolean }) => {
      if (!persistent) setRecoveryWarning("Browser storage is unavailable. Draft recovery works only while this tab stays open.");
    });
  }, [id]);

  const event = useCallback((message: EditorEvent) => {
    if (previewing.current && ["selection", "draft", "section-selection"].includes(message.type)) return;
    if (message.type === "draft") {
      const next = { paragraphId: message.paragraphId!, text: message.original!, pageIndex: message.pageIndex! };
      selectionRef.current = next; setSelection(next);
      draftRef.current = message.text!; setDraft(message.text!);
      inlineStateRef.current = message.modified === false ? undefined : message.inlineState;
      setPendingDraft(message.modified ?? (message.text !== message.original || !!message.inlineState));
      const nextScope = { title: `Paragraph · page ${next.pageIndex + 1}`, targets: [next] };
      scopeRef.current = nextScope; setScope(nextScope);
      setProposal(null); aiGeneration.current += 1;
      if (!recovering.current) persist();
    } else if (message.type === "section-selection") {
      const nextScope = { title: message.title!, targets: message.targets! };
      scopeRef.current = nextScope; setScope(nextScope);
      setProposal(null); aiGeneration.current += 1;
    } else if (message.type === "selection") {
      const next = message.paragraphId ? { paragraphId: message.paragraphId, text: message.text!, pageIndex: message.pageIndex! } : null;
      // Repeated clicks can arrive after typing starts. The same selection must
      // not replace pending text with the paragraph's original content.
      const current = selectionRef.current;
      if (next?.paragraphId === current?.paragraphId && next?.text === current?.text && next?.pageIndex === current?.pageIndex) return;
      selectionRef.current = next;
      draftRef.current = next?.text ?? "";
      setSelection(next); setDraft(next?.text ?? ""); setProposal(null);
      inlineStateRef.current = undefined; setPendingDraft(false);
      const nextScope = next ? { title: `Paragraph · page ${next.pageIndex + 1}`, targets: [next] } : null;
      scopeRef.current = nextScope; setScope(nextScope);
      aiGeneration.current += 1;
      if (!recovering.current) persist();
    } else if (message.type === "changed") {
      if (message.bytes) pdfBytes.current = message.bytes;
      pdfDirty.current = true;
      setDirty(true);
      inlineStateRef.current = undefined; setPendingDraft(false);
      draftRef.current = selectionRef.current?.text ?? ""; setDraft(draftRef.current);
      setHistory({ canUndo: !!message.canUndo, canRedo: !!message.canRedo });
      setError(null);
      setNotice("");
      persist();
    } else if (message.type === "history-state") {
      setHistory({ canUndo: !!message.canUndo, canRedo: !!message.canRedo });
      setError(null);
    } else if (message.type === "save-request") saveAction.current();
    else if (message.type === "error") setError(message.message || "The PDF could not be edited.");
  }, [persist]);
  const { frame, session, ready, command } = usePdfEditor(id, event);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setError(null); setLoaded(false); setFile(null); setSelection(null); setProposal(null);
    selectionRef.current = null; draftRef.current = ""; setDraft(""); aiGeneration.current += 1;
    inlineStateRef.current = undefined; scopeRef.current = null; setScope(null); setPendingDraft(false); previewing.current = false;
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
            if (recovered.draft !== recovered.selection.text || recovered.inlineState) {
              await command("restore-draft", { paragraphId: recovered.selection.paragraphId, expectedText: recovered.selection.text, text: recovered.draft, inlineState: recovered.inlineState });
            } else {
              const selected = await command("select", { paragraphId: recovered.selection.paragraphId });
              if (selected.text !== recovered.selection.text) setRecoveryConflict(recovered);
            }
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
  const save = () => run("Saving PDF", async () => {
    if (!metadata || proposal) return;
    const exported = await command("export");
    if (!exported.bytes) throw new Error("The editor returned no PDF.");
    const saved = await fetch(api, { method: "PUT", headers: { "Content-Type": "application/pdf", "If-Match": metadata.revision }, body: exported.bytes }).then(jsonResponse) as Metadata;
    metadataRef.current = saved; pdfBytes.current = exported.bytes; pdfDirty.current = false;
    await clearPdfDraft(id);
    setMetadata(saved); setDirty(false); setPendingDraft(false); inlineStateRef.current = undefined;
    setNotice("PDF saved. The previous version is available below.");
  });
  saveAction.current = save;
  const rewrite = () => run("Preparing AI preview", async () => {
    if (!metadata || proposal) return;
    // Commit the live editor buffer first, so the proposal targets the wording
    // currently visible on the page rather than an earlier selection snapshot.
    await command("export");
    const selected = scopeRef.current;
    if (!selected?.targets.length) throw new Error("Select text or a section on the page first.");
    const cliId = readSavedCliId();
    if (!cliId) throw new Error("Choose your AI in Config first, or edit the text by hand.");
    const generation = ++aiGeneration.current;
    const original = selected.targets.map(target => ({ ...target }));
    const result = await fetch(`${api}/rewrite`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targets: original.map(({ paragraphId, text }) => ({ paragraphId, text })), instruction, cliId, revision: metadata.revision }) }).then(jsonResponse);
    if (generation !== aiGeneration.current || !pdfTargetsMatch(original, scopeRef.current?.targets ?? [])) return;
    const next: Proposal = { original, replacements: result.replacements, warning: result.warning };
    previewing.current = true;
    try {
      await command("preview-many", { targets: original.map(target => ({ paragraphId: target.paragraphId, expectedText: target.text, text: next.replacements.find(replacement => replacement.paragraphId === target.paragraphId)?.text })) });
      setProposal(next);
    } catch (error) { previewing.current = false; throw error; }
  });
  const reject = () => run("Discarding AI preview", async () => {
    await command("clear-preview"); previewing.current = false; setProposal(null);
  });
  const accept = () => run("Accepting AI changes", async () => {
    if (!proposal || !pdfTargetsMatch(proposal.original, scopeRef.current?.targets ?? [])) throw new Error("The selection changed. Request a new suggestion.");
    await command("replace-many", { targets: proposal.original.map(target => ({ paragraphId: target.paragraphId, expectedText: target.text, text: proposal.replacements.find(replacement => replacement.paragraphId === target.paragraphId)?.text })) });
    previewing.current = false; setProposal(null); setScope(null); scopeRef.current = null;
    // Paragraph indices can change after a grouped rewrite. Recovery retains
    // the accepted PDF snapshot without pointing at a stale paragraph index.
    selectionRef.current = null; setSelection(null); draftRef.current = ""; setDraft("");
    inlineStateRef.current = undefined; setPendingDraft(false); persist();
  });
  const restore = (versionId: string) => run("Restoring version", async () => {
    if (!metadata || !window.confirm("Restore this saved version? Your current saved PDF will also be kept in history.")) return;
    await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restore-version", versionId, revision: metadata.revision }) }).then(jsonResponse);
    await clearPdfDraft(id);
    await load(); setNotice("Previous version restored.");
  });

  return <div className="mx-auto flex max-w-[1800px] flex-col gap-3 p-3 sm:p-5">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0"><Link href="/documents" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-brand"><ArrowLeft className="size-3.5" />Documents</Link><h1 className="mt-1 text-xl font-semibold">Visual PDF editor</h1><p className="mt-1 break-all text-xs text-muted">{metadata?.filename ?? "Opening document…"}{(dirty || draftDirty) && <span className="ml-2 text-brand">Unsaved changes</span>}</p></div>
      <div className="flex flex-wrap gap-2">
        {classic && <Link href={classic} className="rounded-lg border border-border px-3 py-2 text-sm hover:text-brand">Classic editor</Link>}
        <Button variant="outline" disabled={!loaded || !!busy || !!proposal || (!history.canUndo && !draftDirty)} onClick={() => run("Undoing", async () => { await command("undo"); })}><Undo2 className="size-4" />Undo</Button>
        <Button variant="outline" disabled={!loaded || !!busy || !!proposal || !history.canRedo || draftDirty} onClick={() => run("Redoing", async () => { await command("redo"); })}><Redo2 className="size-4" />Redo</Button>
        <Button disabled={!loaded || !!busy || !!proposal || !!recoveryConflict || (!dirty && !draftDirty)} onClick={save}><Save className="size-4" />Save PDF</Button>
      </div>
    </header>
    <p className="text-xs text-muted">Click text and type on the page. Drag a section handle to change its order. Pages adjust automatically as your CV grows. Visual edits update this PDF; Classic edits the CV source.</p>
    {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-400">{error}<button className="ml-3 underline" onClick={() => { if ((!dirty && !draftDirty) || window.confirm("Discard unsaved changes and reload?")) void clearPdfDraft(id).then(load).catch((e: Error) => setError(e.message)); }}>Reload document</button></div>}
    {recoveryWarning && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">{recoveryWarning}</p>}
    {recoveryConflict && <div role="alert" className="space-y-3 rounded-lg border border-amber-500/40 p-4 text-sm"><p>A recovered draft could not be applied to this version. Download it or copy its text before discarding it.</p>{recoveryConflict.draft && <pre className="whitespace-pre-wrap rounded bg-background p-3 font-sans" aria-label="Recovered paragraph text">{recoveryConflict.draft}</pre>}<div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { const url = URL.createObjectURL(new Blob([recoveryConflict.bytes], { type: "application/pdf" })); const link = document.createElement("a"); link.href = url; link.download = `recovered-${metadata?.filename ?? "document.pdf"}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Download recovered PDF</Button><Button variant="ghost" onClick={() => { void clearPdfDraft(id).then(load).catch((e: Error) => setError(e.message)); }}>Discard recovered draft</Button></div></div>}
    {notice && <p role="status" className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400"><Check className="size-4" />{notice}</p>}
    {warnings.map(warning => <p key={warning} className="rounded-lg bg-amber-500/10 p-3 text-xs">{warning}</p>)}
    <section aria-label="Rewrite selection with AI" className="rounded-xl border border-border bg-surface p-3" inert={!!recoveryConflict}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex shrink-0 items-center gap-2 text-xs"><Sparkles className="size-4 text-brand" /><span>{scope?.title ?? "Select text or a section"}</span></div>
        <label className="sr-only" htmlFor="rewrite-instruction">What should change?</label>
        <input id="rewrite-instruction" className={`${fieldClass} min-w-[160px] flex-1`} maxLength={1000} placeholder="Tell AI what to change in this selection…" value={instruction} disabled={!scope || !!busy || !!proposal} onChange={e => setInstruction(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && instruction.trim() && scope && !busy && !proposal) void rewrite(); }} />
        {proposal ? <><Button disabled={!!busy} onClick={accept}>Accept changes</Button><Button variant="outline" disabled={!!busy} onClick={reject}>Reject</Button></> : <Button variant="outline" disabled={!loaded || !scope || !instruction.trim() || !!busy} onClick={rewrite}><Sparkles className="size-4" />Preview with AI</Button>}
      </div>
      {proposal && <p role="status" className="mt-2 text-xs text-brand">AI changes are previewed on the page. Accept or reject before saving.</p>}
      {proposal?.warning && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{proposal.warning}</p>}
      {!!busy && <p role="status" className="mt-2 flex items-center gap-2 text-xs text-muted"><Loader2 className="size-3 animate-spin" />{busy}…</p>}
    </section>
    <section className="relative min-w-0 overflow-hidden rounded-xl border border-border bg-surface" aria-label="PDF pages">
      {!loaded && <div role="status" className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-surface/90"><Loader2 className="size-5 animate-spin" />{error ? "PDF unavailable" : "Opening PDF…"}</div>}
      {session && <iframe ref={frame} src={`/pdf-editor/index.html?session=${encodeURIComponent(session)}`} title="Editable PDF pages" sandbox="allow-scripts allow-same-origin" inert={!!busy || !!recoveryConflict} className="h-[78vh] min-h-[560px] w-full" style={{ pointerEvents: busy || recoveryConflict ? "none" : undefined }} />}
    </section>
    <footer className="flex flex-wrap items-start justify-between gap-3 text-xs text-muted">
      <p>PDF editing stays on this device. AI uses your provider from Config. <a className="underline" href="/vendor/bentopdf/SOURCE.md" target="_blank" rel="noreferrer">BentoPDF · source and notices</a></p>
      {!!metadata?.versions.length && <details className="min-w-[240px] rounded-lg border border-border p-3"><summary className="cursor-pointer font-medium">Saved versions ({metadata.versions.length})</summary><ul className="mt-3 space-y-2">{metadata.versions.map(version => <li key={version.id} className="flex items-center justify-between gap-3"><span>{new Date(version.createdAt).toLocaleString()}</span><Button variant="ghost" size="sm" disabled={!!busy || !!proposal || dirty || draftDirty} onClick={() => restore(version.id)}>Restore</Button></li>)}</ul></details>}
    </footer>
  </div>;
}
