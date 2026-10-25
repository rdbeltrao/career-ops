"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileCode2, Loader2, RefreshCw, Save } from "lucide-react";

type ConfigInfo = { id: string; name: string; description: string };
type ConfigFile = ConfigInfo & { path: string; content: string; exists: boolean; revision: string; warning: string | null };

export function ConfigFiles() {
  const [files, setFiles] = useState<ConfigInfo[]>([]);
  const [selected, setSelected] = useState("portals");
  const [current, setCurrent] = useState<ConfigFile | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const requestId = useRef(0);
  const dirty = current !== null && draft !== current.content;

  const load = useCallback(async (id: string) => {
    const request = ++requestId.current;
    setLoading(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch(`/api/config-files?file=${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load this file.");
      if (request !== requestId.current) return;
      setCurrent(data);
      setDraft(data.content);
    } catch (cause) {
      if (request !== requestId.current) return;
      setCurrent(null);
      setError(cause instanceof Error ? cause.message : "Could not load this file.");
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/config-files", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not list configuration files.");
        if (!active) return;
        const catalog: ConfigInfo[] = data.files;
        setFiles(catalog);
        const linked = window.location.hash.replace(/^#yaml-/, "");
        const id = catalog.some((file) => file.id === linked) ? linked : "portals";
        setSelected(id);
        void load(id);
      })
      .catch(() => { if (active) { setError("Could not list configuration files. Reload this page to retry."); setLoading(false); } });
    return () => { active = false; requestId.current++; };
  }, [load]);

  useEffect(() => {
    function followFileLink() {
      const id = window.location.hash.replace(/^#yaml-/, "");
      if (id === selected || !files.some((file) => file.id === id)) return;
      if (saving || (dirty && !window.confirm("Discard unsaved YAML changes and open another file?"))) {
        window.history.replaceState(window.history.state, "", `#yaml-${selected}`);
        return;
      }
      setSelected(id);
      void load(id);
    }
    window.addEventListener("hashchange", followFileLink);
    return () => window.removeEventListener("hashchange", followFileLink);
  }, [files, selected, saving, dirty, load]);

  useEffect(() => {
    if (!loading && current && window.location.hash.startsWith("#yaml-")) {
      document.getElementById("yaml-files")?.scrollIntoView();
    }
  }, [loading, current]);

  useEffect(() => {
    if (!dirty && !saving) return;
    function beforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ""; }
    function clickedLink(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target instanceof Element ? event.target : null)?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download") || anchor.href.startsWith(`${window.location.href.split("#")[0]}#`)) return;
      if (saving || !window.confirm("Discard unsaved YAML changes and leave Config?")) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", clickedLink, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", clickedLink, true); };
  }, [dirty, saving]);

  function select(id: string) {
    if (dirty && !window.confirm("Discard unsaved YAML changes and open another file?")) return;
    setSelected(id);
    window.history.replaceState(window.history.state, "", `#yaml-${id}`);
    void load(id);
  }

  async function save() {
    if (!current || loading || saving) return;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch("/api/config-files", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: current.id, revision: current.revision, content: draft }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save this file.");
      setCurrent(data);
      setDraft(data.content);
      setStatus(data.backedUp ? "Saved. A backup of the previous file was kept." : "Saved.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save this file."); }
    finally { setSaving(false); }
  }

  return (
    <section id="yaml-files" aria-labelledby="yaml-files-heading" className="mt-10 min-w-0 scroll-mt-24 border-t border-border pt-8 lg:scroll-mt-6">
      <h2 id="yaml-files-heading" className="flex items-center gap-2 text-lg font-semibold text-foreground"><FileCode2 className="size-5 text-brand" /> YAML configuration files</h2>
      <p className="mt-1 text-sm text-muted">View and edit the files used by career-ops. Changes apply when a workflow next reads the file.</p>
      <label htmlFor="yaml-file-select" className="mt-5 mb-2 block text-sm font-medium">Configuration file</label>
      <select id="yaml-file-select" value={selected} disabled={loading || saving || !files.length} onChange={(event) => select(event.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground">
        {files.map((file) => <option key={file.id} value={file.id}>{file.name}</option>)}
      </select>
      <p className="mt-2 text-xs text-muted">{files.find((file) => file.id === selected)?.description}</p>
      {loading ? <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> Loading YAML…</p> : current && (
        <>
          <p className="mt-3 break-all font-mono text-[11px] text-faint">{current.path}</p>
          {!current.exists && <p className="mt-3 text-sm text-muted">This file does not exist yet. Saving will create it.</p>}
          {current.warning && <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">{current.warning} You can repair it below.</p>}
          <label htmlFor="yaml-content" className="mt-4 mb-2 block text-sm font-medium">YAML content</label>
          <textarea id="yaml-content" value={draft} disabled={saving} onChange={(event) => { setDraft(event.target.value); setStatus(""); setError(""); }} spellCheck={false} autoCapitalize="off" autoCorrect="off" rows={18} className="w-full resize-y rounded-xl border border-border bg-surface/50 p-3 font-mono text-xs leading-6 text-foreground focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand" />
          <p className="mt-2 text-xs text-faint">YAML syntax is checked before saving. Comments and formatting are preserved.</p>
        </>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-rose-600 dark:text-rose-400">{error}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={loading || saving || !current || (!dirty && current.exists)} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground disabled:opacity-50">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}{saving ? "Saving…" : "Save YAML"}
        </button>
        <button type="button" disabled={loading || saving || !files.length} onClick={() => { if (!dirty || window.confirm("Discard unsaved YAML changes and reload from disk?")) void load(selected); }} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-muted disabled:opacity-50"><RefreshCw className="size-4" /> Reload file</button>
        <span role="status" aria-label="YAML save status" className="text-xs text-muted">{status || (dirty ? "Unsaved changes" : "")}</span>
      </div>
    </section>
  );
}
