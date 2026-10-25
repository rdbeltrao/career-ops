"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, BookOpen, Check, ChevronRight, ExternalLink, Files, ListChecks, Loader2, PanelLeft, Pencil, Plus, RotateCcw, X } from "lucide-react";
import { SkillGaps } from "@/components/skill-gaps";
import { cn } from "@/lib/cn";
import { collapsedPageKeys, collapsedSourcePageIds, initialWorkspaceDocument, navigationSections, pageBreadcrumbs, selectedPageContent, siblingAvailability, sourcePageBreadcrumbs, sourcePageMovement } from "@/lib/workspace-view.mjs";
import { workspaceDrafts } from "@/lib/workspace-drafts.mjs";
import { PageTree } from "./page-tree";
import { SourcePageTree } from "./source-page-tree";
import { UnsavedDialog } from "./unsaved-dialog";
import type { PageSelection, WorkspaceDocument, WorkspaceDocumentSummary, WorkspaceSection } from "./types";

// EVIDENCE: Next's bundled lazy-loading guide requires ssr:false in a client
// component. Lexical owns browser selection and is loaded only for this surface.
const MarkdownEditor = dynamic(() => import("@/components/editor/markdown-editor").then((module) => module.MarkdownEditor), {
  ssr: false,
  loading: () => <p role="status" className="p-6 text-sm text-muted">Loading editor…</p>,
});

const TRUST: Record<string, { label: string; text: string }> = {
  context: { label: "App summary", text: "The local profile this app uses for applications. It summarizes career facts and preferences; it is not a complete copy of your Notion records." },
  cv: { label: "Résumé output", text: "Your working CV draft. Keep its facts consistent with your application profile and original career records." },
  achievements: { label: "App summary", text: "Local professional examples and proof points used for applications. Preserve source links and confirmation notes." },
  profile: { label: "App settings", text: "Role preferences and positioning for your search. Preferences are not evidence of past work." },
  stories: { label: "Working stories", text: "Interview narratives. Figures and scope still need support from your career record." },
  guide: { label: "Writing and workflow rules", text: "Instructions for how your search runs. These rules do not establish career facts." },
};

type Mutation = { action: "replace" | "add" | "rename" | "move"; content?: string; title?: string; direction?: "up" | "down" };
type ActionForm = { kind: "add" | "rename"; title: string } | null;
type ApiProblem = { error?: string; code?: string };
type RecoveredDraft = { section: string | null; revision: string; content: string; original: string; form: ActionForm };

function draftStorage(): Storage | null {
  try { return window.sessionStorage; }
  catch { return null; }
}

async function responseBody(response: Response): Promise<WorkspaceDocument & ApiProblem> {
  try { return await response.json(); }
  catch { throw new Error("The workspace returned an unreadable response. Your draft is still here."); }
}

export function CareerWorkspace({ initialDocument = "context" }: { initialDocument?: "context" | "cv" }) {
  const requestedDocument = useSearchParams().get("document");
  const [documents, setDocuments] = useState<WorkspaceDocumentSummary[]>([]);
  const [current, setCurrent] = useState<WorkspaceDocument | null>(null);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [original, setOriginal] = useState("");
  const [editorVersion, setEditorVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [indexError, setIndexError] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [navigationView, setNavigationView] = useState<"source" | "local">(initialDocument === "cv" ? "local" : "source");
  const [sourceRootId, setSourceRootId] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [collapsedSources, setCollapsedSources] = useState<Set<string>>(new Set());
  const [mobilePages, setMobilePages] = useState(false);
  const [form, setForm] = useState<ActionForm>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [recovered, setRecovered] = useState<RecoveredDraft | null>(null);
  const [recoveryWarning, setRecoveryWarning] = useState(false);
  const pagesDialog = useRef<HTMLDialogElement>(null);
  const documentsRef = useRef<WorkspaceDocumentSummary[]>([]);
  const pending = useRef<(() => void) | null>(null);
  const requestNumber = useRef(0);
  const indexRequestNumber = useRef(0);
  const currentRef = useRef<WorkspaceDocument | null>(null);
  const sectionRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const loadingRef = useRef(true);
  const dirtyRef = useRef(false);
  const dirty = draft !== original;
  const busy = loading || saving;
  const selected = current?.sections.find((section) => section.id === sectionId) ?? null;
  const isSource = current?.kind === "source";
  const formDirty = Boolean(form && (form.kind === "add" ? form.title.trim() : form.title !== (isSource ? current?.title : selected?.title)));
  const hasEdits = dirty || formDirty;
  dirtyRef.current = hasEdits;
  const displaySections = current ? navigationSections(current.sections) as WorkspaceSection[] : [];
  const trail = pageBreadcrumbs(displaySections, sectionId) as WorkspaceSection[];
  const sourceTrail = current ? sourcePageBreadcrumbs(documents, current.id) : [];
  const movement = current ? isSource ? sourcePageMovement(documents, current.id) : siblingAvailability(current.sections, sectionId) : { up: false, down: false };
  const trust = current ? TRUST[current.id] : undefined;

  const acceptDocument = useCallback((document: WorkspaceDocument, nextSection: string | null) => {
    const validSection = document.sections.some((section) => section.id === nextSection) ? nextSection : null;
    const content = selectedPageContent(document, validSection);
    currentRef.current = document;
    sectionRef.current = validSection;
    dirtyRef.current = false;
    setCurrent(document);
    setNavigationView(document.kind === "source" ? "source" : "local");
    setSectionId(validSection);
    setDraft(content);
    setOriginal(content);
    setEditorVersion((version) => version + 1);
    setForm(null);
    setRecovered(null);
    setConflict(false);
    const nextDocuments = documentsRef.current.map((item) => item.id === document.id ? document : item);
    if (!nextDocuments.some((item) => item.id === document.id)) nextDocuments.push(document);
    documentsRef.current = nextDocuments;
    setDocuments(nextDocuments);
    setCollapsed(collapsedPageKeys(nextDocuments, { document: document.id, section: validSection }));
    setCollapsedSources(collapsedSourcePageIds(nextDocuments, document.kind === "source" ? document.id : null));
  }, []);

  const loadDocument = useCallback(async (selection: PageSelection) => {
    const request = ++requestNumber.current;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/workspace?document=${encodeURIComponent(selection.document)}`, { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(body.error || "This page could not be opened.");
      if (request !== requestNumber.current) return;
      acceptDocument(body, selection.section);
      setRecovered(workspaceDrafts.read(draftStorage(), body.workspaceId, body.id));
      setMobilePages(false);
    } catch (problem) {
      if (request === requestNumber.current) setError(problem instanceof Error ? problem.message : "This page could not be opened.");
    } finally { if (request === requestNumber.current) { loadingRef.current = false; setLoading(false); } }
  }, [acceptDocument]);

  const loadIndex = useCallback(async (openInitial = false) => {
    const request = ++indexRequestNumber.current;
    if (openInitial) { loadingRef.current = true; setLoading(true); }
    setIndexError("");
    try {
      const response = await fetch("/api/workspace", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.documents)) throw new Error(body.error || "The page list could not be loaded.");
      if (request !== indexRequestNumber.current) return;
      const latest = currentRef.current;
      const nextDocuments = body.documents.map((item: WorkspaceDocumentSummary) => latest?.id === item.id ? latest : item);
      documentsRef.current = nextDocuments;
      setDocuments(nextDocuments);
      setSourceError(body.sourceError?.error || "");
      setSourceRootId(body.sourceRootDocumentId || null);
      setCollapsed(collapsedPageKeys(nextDocuments, { document: latest?.id || initialDocument, section: sectionRef.current }));
      setCollapsedSources(collapsedSourcePageIds(nextDocuments, latest?.kind === "source" ? latest.id : body.sourceRootDocumentId || null));
      if (openInitial) {
        const document = requestedDocument || initialWorkspaceDocument(nextDocuments, initialDocument, body.sourceRootDocumentId || null);
        if (document) await loadDocument({ document, section: null });
        else { loadingRef.current = false; setLoading(false); }
      }
    } catch (problem) {
      if (request !== indexRequestNumber.current) return;
      setIndexError(problem instanceof Error ? problem.message : "The page list could not be loaded.");
      if (openInitial) { loadingRef.current = false; setLoading(false); }
    }
  }, [initialDocument, loadDocument, requestedDocument]);

  useEffect(() => {
    void loadIndex(true);
    return () => { requestNumber.current++; indexRequestNumber.current++; };
  }, [loadIndex]);

  // EVIDENCE: Native modal dialogs provide focus containment, Escape handling
  // and inert background content: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog
  useEffect(() => {
    const dialog = pagesDialog.current;
    if (mobilePages && dialog && !dialog.open) dialog.showModal();
    else if (!mobilePages && dialog?.open) dialog.close();
  }, [mobilePages]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1280px)");
    const closeDrawer = () => { if (desktop.matches) setMobilePages(false); };
    desktop.addEventListener("change", closeDrawer);
    return () => desktop.removeEventListener("change", closeDrawer);
  }, []);

  // EVIDENCE: sessionStorage survives reloads within a tab (MDN, cited in
  // workspace-drafts.mjs). Explicit recovery covers browser Back/Forward without
  // patching Next's router or changing the authoritative files.
  useEffect(() => {
    if (!current || loading || recovered) return;
    if (!hasEdits) {
      workspaceDrafts.clear(draftStorage(), current.workspaceId, current.id);
      setRecoveryWarning(false);
      return;
    }
    const persisted = workspaceDrafts.write(draftStorage(), current.workspaceId, current.id, { section: sectionId, revision: current.revision, content: draft, original, form });
    setRecoveryWarning(!persisted);
  }, [current, hasEdits, loading, recovered, sectionId, draft, original, form]);

  const beforeAction = useCallback((action: () => void, reload = false) => {
    if (busy) return;
    if (!hasEdits) { action(); return; }
    pending.current = action;
    setConfirmReload(reload);
    setConfirmOpen(true);
  }, [busy, hasEdits]);

  // JUDGMENT: A capture-phase guard covers the surrounding app navigation
  // without coupling the shell to this editor. New-tab links keep this draft open.
  useEffect(() => {
    if (!hasEdits && !saving) return;
    function beforeUnload(event: BeforeUnloadEvent) { if (dirtyRef.current || savingRef.current) { event.preventDefault(); event.returnValue = ""; } }
    function clickedLink(event: MouseEvent) {
      if (!dirtyRef.current && !savingRef.current) return;
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target instanceof Element ? event.target : null)?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download") || anchor.href.startsWith(`${window.location.href.split("#")[0]}#`)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!saving) beforeAction(() => window.location.assign(anchor.href));
    }
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", clickedLink, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", clickedLink, true);
    };
  }, [hasEdits, saving, beforeAction]);

  async function mutate(mutation: Mutation): Promise<boolean> {
    const document = currentRef.current;
    if (!document || loadingRef.current || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document: document.id, revision: document.revision, section: sectionRef.current, ...mutation }),
      });
      const body = await responseBody(response);
      if (!response.ok) {
        if (response.status === 409) setConflict(true);
        throw new Error(body.error || "The page could not be saved. Your draft is still here.");
      }
      workspaceDrafts.clear(draftStorage(), document.workspaceId, document.id);
      setRecoveryWarning(false);
      acceptDocument(body, body.selectedSection === undefined ? sectionRef.current : body.selectedSection);
      if (document.kind === "source") await loadIndex();
      setNotice(mutation.action === "add" ? "Page created." : mutation.action === "rename" ? "Page renamed." : mutation.action === "move" ? "Page moved." : "Saved.");
      if (document.id === "cv") window.dispatchEvent(new CustomEvent("co-cv-saved"));
      return true;
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "The page could not be saved. Your draft is still here.");
      return false;
    } finally { savingRef.current = false; setSaving(false); }
  }

  async function saveAndContinue() {
    const mutation: Mutation = formDirty && form ? { action: form.kind, title: form.title.trim() } : { action: "replace", content: draft };
    if (!await mutate(mutation)) {
      pending.current = null;
      setConfirmOpen(false);
      return;
    }
    const action = pending.current;
    pending.current = null;
    dirtyRef.current = false;
    setConfirmOpen(false);
    action?.();
  }

  function discardAndContinue() {
    const action = pending.current;
    pending.current = null;
    dirtyRef.current = false;
    setConfirmOpen(false);
    if (current) workspaceDrafts.clear(draftStorage(), current.workspaceId, current.id);
    setDraft(original);
    setForm(null);
    setEditorVersion((version) => version + 1);
    action?.();
  }

  function selectPage(selection: PageSelection) {
    if (current?.id === selection.document && sectionId === selection.section) { setMobilePages(false); return; }
    beforeAction(() => void loadDocument(selection));
  }

  function startForm(kind: "add" | "rename") {
    beforeAction(() => setForm({ kind, title: kind === "rename" ? (isSource ? current?.title : selected?.title) || "" : "" }));
  }

  function selectNavigationView(view: "source" | "local") {
    if (view === navigationView) return;
    beforeAction(() => {
      setQuery("");
      const document = view === "source" ? initialWorkspaceDocument(documentsRef.current, "context", sourceRootId) : initialDocument === "cv" ? "cv" : "context";
      if (document) void loadDocument({ document, section: null });
      else {
        currentRef.current = null;
        sectionRef.current = null;
        setCurrent(null);
        setSectionId(null);
        setDraft("");
        setOriginal("");
        setForm(null);
        setRecovered(null);
        setError("");
        setNotice("");
        setConflict(false);
        setNavigationView(view);
      }
    });
  }

  function restoreDraft() {
    if (!current || !recovered || (recovered.section && !current.sections.some((page) => page.id === recovered.section))) return;
    const revisionChanged = current.revision !== recovered.revision;
    const restored = { ...current, revision: recovered.revision };
    currentRef.current = restored;
    sectionRef.current = recovered.section;
    setCurrent(restored);
    setSectionId(recovered.section);
    setCollapsed(collapsedPageKeys(documentsRef.current, { document: current.id, section: recovered.section }));
    setCollapsedSources(collapsedSourcePageIds(documentsRef.current, current.kind === "source" ? current.id : null));
    setDraft(recovered.content);
    setOriginal(recovered.original);
    setForm(recovered.form);
    setEditorVersion((version) => version + 1);
    setRecovered(null);
    setConflict(revisionChanged);
    setError(revisionChanged ? "The saved document changed while this draft was away. Your recovered draft is preserved; copy what you need before reloading." : "");
    setNotice("Draft restored. Save when ready.");
  }

  function discardRecoveredDraft() {
    if (!current) return;
    workspaceDrafts.clear(draftStorage(), current.workspaceId, current.id);
    setRecovered(null);
  }

  const displayedSelection = displaySections.find((section) => section.id === sectionId);
  const pageTitle = displayedSelection?.title || current?.title || (navigationView === "source" ? "Source pages" : initialDocument === "cv" ? "CV draft" : "Application profile");
  const childPages: { id: string; title: string }[] = isSource ? documents.filter((document) => document.kind === "source" && document.parentDocumentId === current?.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : displaySections.filter((section) => section.parentId === (displayedSelection?.id || null));
  const sourceLink = current?.sourceUrl && /^https?:\/\//i.test(current.sourceUrl) ? current.sourceUrl : null;
  const selection = { document: current?.id || initialDocument, section: sectionId };
  const button = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-40";
  const toggleCollapsed = (setter: typeof setCollapsed, key: string) => setter((previous) => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const pageTree = <>
    <div role="group" aria-label="Workspace views" className="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-surface-hover p-1">
      <button type="button" aria-pressed={navigationView === "source"} disabled={busy} onClick={() => selectNavigationView("source")} className={cn("min-h-9 rounded-md px-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50", navigationView === "source" ? "bg-surface font-medium text-foreground shadow-sm" : "text-muted")}>Source pages</button>
      <button type="button" aria-pressed={navigationView === "local"} disabled={busy} onClick={() => selectNavigationView("local")} className={cn("min-h-9 rounded-md px-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50", navigationView === "local" ? "bg-surface font-medium text-foreground shadow-sm" : "text-muted")}>App files</button>
    </div>
    {navigationView === "source" && <p className="mb-4 px-2 text-xs leading-relaxed text-muted">Local edits stay here. Job matching uses Application profile in App files.</p>}
    {indexError ? <div role="alert" className="p-2 text-sm text-muted"><p>{indexError}</p><button type="button" onClick={() => void loadIndex(!current)} className={cn(button, "mt-3")}>Retry page list</button></div> : !documents.length && loading ? <p role="status" className="p-2 text-sm text-muted">Loading pages…</p> : navigationView === "source" ? <>
      {sourceError && <div role="alert" className="mb-4 p-2 text-sm text-muted"><p>{sourceError}</p><button type="button" onClick={() => void loadIndex(!current)} className={cn(button, "mt-3")}>Retry source pages</button></div>}
      {documents.some((document) => document.kind === "source") ? <SourcePageTree documents={documents} selectedDocument={isSource ? current?.id || null : null} collapsed={collapsedSources} query={query} busy={busy} onQuery={setQuery} onToggle={(id) => toggleCollapsed(setCollapsedSources, id)} onSelect={(document) => selectPage({ document, section: null })} /> : !sourceError && <p className="px-2 text-sm leading-relaxed text-muted">No source pages have been imported yet. App files contain your separate local summaries and drafts.</p>}
    </> : <PageTree documents={documents.filter((document) => document.kind !== "source")} selected={selection} collapsed={collapsed} query={query} busy={busy} onQuery={setQuery} onToggle={(key) => toggleCollapsed(setCollapsed, key)} onSelect={selectPage} />}
  </>;

  return (
    <div className="mx-auto w-full max-w-[1680px] px-4 py-6 sm:px-6 xl:px-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div><p className="text-xs font-medium uppercase tracking-[0.16em] text-faint">Your career workspace</p><p className="mt-1 text-sm text-muted">Source pages and application files, kept separate.</p></div>
        <div className="flex items-center gap-2">
          <Link href="/documents" className={button}><Files aria-hidden="true" className="size-4" />Documents</Link>
          <Link href="/pipeline" className={button}><ListChecks aria-hidden="true" className="size-4" />Applications</Link>
        </div>
      </div>

      <button type="button" onClick={() => setMobilePages(true)} aria-expanded={mobilePages} aria-controls="workspace-pages-drawer" className={cn(button, "mb-4 xl:hidden")}><PanelLeft aria-hidden="true" className="size-4" />Show pages</button>

      <dialog ref={pagesDialog} id="workspace-pages-drawer" aria-label="Workspace page navigation" onClose={() => setMobilePages(false)} onCancel={() => setMobilePages(false)} onClick={(event) => { if (event.target === event.currentTarget) setMobilePages(false); }} className="fixed inset-y-0 left-0 right-auto m-0 h-dvh max-h-none w-[min(360px,calc(100vw-2rem))] max-w-none border-r border-border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/40 open:flex open:flex-col">
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3"><h2 className="text-sm font-medium">Workspace pages</h2><button type="button" aria-label="Hide pages" onClick={() => setMobilePages(false)} className={button}><X aria-hidden="true" className="size-4" /></button></div>
        <div className="overflow-y-auto p-4">{pageTree}</div>
      </dialog>

      <div className="grid min-w-0 gap-8 xl:grid-cols-[304px_minmax(0,1fr)] 2xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside id="workspace-sidebar" aria-label="Workspace sidebar" className="sticky top-6 hidden max-h-[calc(100dvh-3rem)] min-w-0 self-start overflow-y-auto rounded-2xl border border-border bg-surface/50 p-4 xl:block">
          {pageTree}
        </aside>

        <section aria-label="Page editor" aria-busy={busy} className="min-w-0">
          <nav aria-label="Page breadcrumbs" className="mb-4 flex flex-wrap items-center gap-1 text-xs text-muted">
            <BookOpen aria-hidden="true" className="mr-1 size-3.5" />
            <span>{isSource || (!current && navigationView === "source") ? "Source pages" : "App files"}</span>
            {isSource ? sourceTrail.map((page) => <span key={page.id} className="inline-flex min-w-0 items-center gap-1"><ChevronRight aria-hidden="true" className="size-3 shrink-0" /><button type="button" title={page.title} aria-current={page.id === current?.id ? "page" : undefined} disabled={busy} onClick={() => selectPage({ document: page.id, section: null })} className="rounded px-1 py-1 text-left break-words hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand">{page.title}</button></span>) : current && <><ChevronRight aria-hidden="true" className="size-3 shrink-0" /><button type="button" disabled={busy} onClick={() => selectPage({ document: current.id, section: null })} className="rounded px-1 py-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand">{current.title}</button>{trail.map((page) => <span key={page.id} className="inline-flex min-w-0 items-center gap-1"><ChevronRight aria-hidden="true" className="size-3 shrink-0" /><button type="button" title={page.title} aria-current={page.id === sectionId ? "page" : undefined} disabled={busy} onClick={() => selectPage({ document: current.id, section: page.id })} className="rounded px-1 py-1 text-left break-words hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand">{page.title}</button></span>)}</>}
          </nav>

          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-3xl tracking-tight text-landing break-words sm:text-4xl">{pageTitle}</h1>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">{isSource ? "Local copy. Changes stay here." : trust?.text || current?.description || "Open a source page, or switch to App files for local summaries and drafts."}</p>
              {isSource && sourceLink && <a href={sourceLink} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1.5 rounded text-sm text-muted underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand">Open in Notion<ExternalLink aria-hidden="true" className="size-3.5" /></a>}
              {isSource && Boolean(current?.importNotes?.length) && <details className="mt-3 max-w-2xl text-sm text-muted"><summary className="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-brand">About this local copy</summary><ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-relaxed">{current!.importNotes!.map((note, index) => <li key={index}>{note}</li>)}</ul></details>}
            </div>
            <button type="button" onClick={() => void mutate({ action: "replace", content: draft })} disabled={busy || !dirty || !current} className={cn("inline-flex min-h-10 items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50", dirty ? "bg-brand text-brand-foreground hover:bg-brand-200" : "border border-border bg-surface text-muted")}>
              {saving ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : !dirty && notice === "Saved." ? <Check aria-hidden="true" className="size-4" /> : null}{saving ? "Saving…" : "Save"}
            </button>
          </div>

          <div className="my-5 flex flex-wrap items-center gap-2">
            {trust && <span className="mr-1 rounded-full bg-surface-hover px-2.5 py-1 text-xs text-muted">{trust.label}</span>}
            {current && current.id !== "cv" && <button type="button" disabled={busy || Boolean(recovered) || Boolean(current.outlineWarning) || Boolean(selected && selected.level >= 6)} onClick={() => startForm("add")} className={button}><Plus aria-hidden="true" className="size-3.5" />{selected || isSource ? "New child page" : "New page"}</button>}
            {(selected || isSource) && <><button type="button" disabled={busy || Boolean(recovered) || Boolean(current?.outlineWarning)} onClick={() => startForm("rename")} className={button}><Pencil aria-hidden="true" className="size-3.5" />Rename page</button><button type="button" aria-label="Move page up" disabled={busy || Boolean(recovered) || !movement.up || Boolean(current?.outlineWarning)} onClick={() => beforeAction(() => void mutate({ action: "move", direction: "up" }))} className={button}><ArrowUp aria-hidden="true" className="size-3.5" /></button><button type="button" aria-label="Move page down" disabled={busy || Boolean(recovered) || !movement.down || Boolean(current?.outlineWarning)} onClick={() => beforeAction(() => void mutate({ action: "move", direction: "down" }))} className={button}><ArrowDown aria-hidden="true" className="size-3.5" /></button></>}
            <button type="button" disabled={busy || !current} onClick={() => beforeAction(() => void loadDocument(selection), true)} className={cn(button, "ml-auto")}><RotateCcw aria-hidden="true" className="size-3.5" />Reload from disk</button>
          </div>

          {form && <form onSubmit={(event) => { event.preventDefault(); if (form.title.trim()) void mutate({ action: form.kind, title: form.title.trim() }); }} className="mb-5 rounded-xl border border-border bg-surface p-4">
            <label className="block text-sm font-medium text-foreground">Page title<input autoFocus value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} maxLength={200} required disabled={busy} className="mt-2 min-h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-brand" /></label>
            <p className="mt-2 text-xs text-muted">{form.kind === "add" ? `Add a page inside ${pageTitle}.` : "The content and child pages stay together."}</p>
            <div className="mt-3 flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => setForm(null)} className={button}>Cancel</button><button type="submit" disabled={busy || !form.title.trim()} className={cn(button, "border-brand bg-brand text-brand-foreground")}>{form.kind === "add" ? "Create page" : "Rename"}</button></div>
          </form>}

          {error && <div role="alert" className="mb-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-foreground"><p>{error}</p>{conflict && <p className="mt-2 text-muted">Your draft is unchanged. Copy anything you need, then reload the latest page before trying again.</p>}{!current && <button type="button" onClick={() => void loadIndex(true)} className={cn(button, "mt-3")}>Retry opening page</button>}</div>}
          {recovered && <section aria-label="Recovered draft" className="mb-4 rounded-xl border border-brand/40 bg-brand/5 p-4">
            <h2 className="text-sm font-medium text-foreground">Unsaved draft found</h2>
            <p className="mt-2 text-sm text-muted">A draft from this browser tab is available. Restore it to keep editing, or discard it to use the saved page.</p>
            {recovered.section && !current?.sections.some((page) => page.id === recovered.section) && <p className="mt-2 text-sm text-muted">Its original page has moved or been renamed. Copy the recovered text before choosing a current page.</p>}
            <details className="mt-3"><summary className="cursor-pointer text-sm text-muted">Preview recovered draft</summary><textarea aria-label="Recovered draft text" readOnly value={recovered.content} className="mt-2 min-h-40 w-full rounded-lg border border-border bg-surface p-3 font-mono text-xs text-foreground" />{recovered.form && <p className="mt-2 text-sm text-muted">Pending page title: {recovered.form.title}</p>}</details>
            <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={busy || Boolean(recovered.section && !current?.sections.some((page) => page.id === recovered.section))} onClick={restoreDraft} className={button}>Restore draft</button><button type="button" disabled={busy} onClick={discardRecoveredDraft} className={button}>Discard recovered draft</button></div>
          </section>}
          {current?.outlineWarning && <p role="note" className="mb-4 rounded-xl border border-border bg-surface-hover px-4 py-3 text-sm text-muted">{current.outlineWarning} Page organization is paused; edit the complete document to preserve its structure.</p>}
          {recoveryWarning && hasEdits && <p role="note" className="mb-4 text-xs text-muted">Browser storage is unavailable. Your draft can recover during app navigation, but save before closing or reloading this tab.</p>}
          <p role="status" aria-live="polite" aria-atomic="true" aria-label="Page save status" className="mb-3 min-h-5 text-xs text-muted">{saving ? "Saving your page…" : loading ? "Opening page…" : hasEdits ? "Unsaved changes" : notice || (current ? "All changes saved" : "No page open")}</p>

          {current && <div className={cn("min-w-0 rounded-2xl border border-border bg-surface", loading && "opacity-60")}>
            {!current.exists && <p className="border-b border-border px-5 py-3 text-sm text-muted">This document is empty. Start writing or add your first page.</p>}
            <MarkdownEditor value={draft} onChange={(value) => { if (!busy && !form && !recovered) { setDraft(value); setNotice(""); } }} documentKey={`${current.id}:${sectionId || "root"}:${editorVersion}`} disabled={busy || Boolean(form) || Boolean(recovered)} />
          </div>}

          {childPages.length > 0 && <div className="mt-6"><h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-faint">{isSource ? "Child pages" : "Pages in this section"}</h2><div className="grid gap-2 sm:grid-cols-2">{childPages.map((page) => <button key={page.id} type="button" title={page.title} disabled={busy} onClick={() => selectPage(isSource ? { document: page.id, section: null } : { document: current!.id, section: page.id })} className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface/50 p-3 text-left text-sm text-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50"><BookOpen aria-hidden="true" className="size-4 shrink-0" /><span className="min-w-0 flex-1 break-words">{page.title}</span><ChevronRight aria-hidden="true" className="size-3.5 shrink-0" /></button>)}</div></div>}
          {current?.id === "cv" && <SkillGaps />}
        </section>
      </div>

      <UnsavedDialog open={confirmOpen} busy={saving} reload={confirmReload} onKeep={() => { pending.current = null; setConfirmOpen(false); }} onDiscard={discardAndContinue} onSave={() => void saveAndContinue()} />
    </div>
  );
}
