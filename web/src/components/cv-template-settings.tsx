"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { CV_PALETTES, PALETTE_COLOR_KEYS, applyCvPalette, selectedPaletteId } from "@/lib/cv-palettes.mjs";

type Template = { name: string; displayName: string; description: string };
type Style = { accent_color: string; font_family: string; font_size: string } & Partial<Record<"secondary_color" | "tag_color" | "tag_bg" | "tag_border", string>>;
type Preferences = { template: string; useAtsGuidance: boolean; atsTemplates: Record<string, string>; style: Style };
type Settings = { templates: Template[]; preferences: Preferences; vendors: { id: string; label: string }[]; revision: string };
type Preview = { loading: boolean; html: string; error: string };

const FONTS = [
  ["", "Template default"],
  ["Arial, Helvetica, sans-serif", "Arial"],
  ["Georgia, serif", "Georgia"],
  ["Inter, sans-serif", "Inter"],
];
const SIZES = [["", "Template default"], ["9pt", "9 pt"], ["10pt", "10 pt"], ["11pt", "11 pt"]];
const CONTROL = "mt-2 min-h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-60";

async function responseJson<T>(response: Response): Promise<T> {
  let body: T & { error?: string };
  try { body = await response.json(); }
  catch { throw new Error("The server returned an unreadable response. Your choices are still here."); }
  if (!response.ok) throw new Error(body.error || "CV preferences are unavailable. Your choices are still here.");
  return body;
}

export function CvTemplateSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<Preview>({ loading: false, html: "", error: "" });

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const body = await responseJson<Settings>(await fetch("/api/cv-templates", { signal }));
      if (signal?.aborted) return;
      setSettings(body);
      setPreferences(body.preferences);
      setNotice("");
    } catch (problem) {
      if (!signal?.aborted) setError(problem instanceof Error ? problem.message : "CV preferences could not be loaded.");
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const previewInput = useMemo(() => preferences ? JSON.stringify({ preview: true, template: preferences.template, style: preferences.style }) : "", [preferences?.template, preferences?.style]);
  useEffect(() => {
    if (!previewInput) return;
    const controller = new AbortController();
    setPreview({ loading: true, html: "", error: "" });
    const timer = setTimeout(() => {
      fetch("/api/cv-templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: previewInput, signal: controller.signal })
        .then((response) => responseJson<{ html: string }>(response))
        .then((body) => {
          if (!controller.signal.aborted) setPreview({ loading: false, html: body.html, error: "" });
        })
        .catch((problem) => {
          if (!controller.signal.aborted) setPreview({ loading: false, html: "", error: problem instanceof Error ? problem.message : "The preview could not be loaded." });
        });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [previewInput]);

  const dirty = Boolean(settings && preferences && JSON.stringify(settings.preferences) !== JSON.stringify(preferences));
  function update(next: Preferences) {
    setPreferences(next);
    setNotice("");
  }
  function style(key: keyof Style, value: string) {
    if (preferences) update({ ...preferences, style: { ...preferences.style, [key]: value } });
  }
  async function save() {
    if (!settings || !preferences || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const body = await responseJson<Settings>(await fetch("/api/cv-templates", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preferences, revision: settings.revision }),
      }));
      setSettings(body);
      setPreferences(body.preferences);
      setNotice("Preferences saved. New CVs will use these settings.");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Preferences could not be saved. Your choices are still here.");
    } finally { setSaving(false); }
  }

  const selected = settings?.templates.find((template) => template.name === preferences?.template);
  const palette = preferences ? selectedPaletteId(preferences.style) : "template";

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
      <Link href="/cv" className="inline-flex min-h-10 items-center gap-1.5 text-sm text-muted hover:text-brand focus-visible:outline-2 focus-visible:outline-brand"><ArrowLeft aria-hidden="true" className="size-4" /> CV draft</Link>
      <header className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight text-landing sm:text-4xl">Templates &amp; style</h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">Choose the look of your next CV. Your saved preferences apply when you generate a new PDF. Existing PDFs keep their current layout.</p>
        </div>
        <button type="button" disabled={!dirty || loading || saving} onClick={() => void save()} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-brand px-5 py-2 text-sm font-medium text-brand-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50">
          {saving ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Check aria-hidden="true" className="size-4" />}{saving ? "Saving…" : "Save preferences"}
        </button>
      </header>
      {error && <div role="alert" className="mt-5 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-foreground"><p>{error}</p><button type="button" disabled={saving || loading} onClick={() => void load()} className="mt-2 min-h-10 rounded-lg border border-border px-3 text-sm hover:text-brand focus-visible:outline-2 focus-visible:outline-brand">{settings ? "Reload saved preferences" : "Retry loading preferences"}</button>{settings && <p className="mt-2 text-xs text-muted">Reloading replaces your unsaved choices with the saved settings.</p>}</div>}
      <p role="status" aria-live="polite" className="mt-4 min-h-5 text-sm text-muted">{loading ? "Loading CV preferences…" : saving ? "Saving preferences…" : notice || (dirty ? "Unsaved preferences" : "")}</p>

      {settings && preferences && <div className="mt-5 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div className="min-w-0 space-y-5">
          <fieldset disabled={saving || loading} className="min-w-0 rounded-2xl border border-border bg-surface p-5">
            <legend className="px-1 text-base font-medium text-foreground">Preferred template</legend>
            <div className="grid gap-3 sm:grid-cols-2" aria-label="CV templates">
              {settings.templates.map((template) => <button type="button" key={template.name} aria-pressed={preferences.template === template.name} onClick={() => update({ ...preferences, template: template.name })} className={cn("min-h-24 rounded-xl border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-brand", preferences.template === template.name ? "border-brand bg-brand-soft" : "border-border hover:border-brand/50")}>
                <span className="block font-medium text-foreground">{template.displayName}</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted">{template.description}</span>
              </button>)}
            </div>
          </fieldset>

          <fieldset disabled={saving || loading} className="min-w-0 rounded-2xl border border-border bg-surface p-5">
            <legend className="px-1 text-base font-medium text-foreground">Color palette</legend>
            <p className="mb-4 text-xs leading-relaxed text-muted">Coordinated colors for headings, supporting text and skill tags.</p>
            {palette === "custom" && <div role="status" className="mb-4 rounded-xl border border-border bg-surface-hover p-3">
              <p className="text-sm font-medium text-foreground">Custom colors</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">Your existing colors stay until you choose a palette.</p>
              <PaletteSwatches colors={preferences.style} />
            </div>}
            <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-2">
              <button type="button" aria-label="Template default palette" aria-pressed={palette === "template"} onClick={() => update({ ...preferences, style: applyCvPalette(preferences.style, "template") })} className={cn("col-span-2 rounded-xl border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-brand sm:col-span-3 lg:col-span-2", palette === "template" ? "border-brand bg-brand-soft" : "border-border hover:border-brand/50")}>
                <span className="flex items-center justify-between gap-2 text-sm font-medium text-foreground">Template default{palette === "template" && <Check aria-hidden="true" className="size-4 shrink-0 text-brand" />}</span>
                <span className="mt-1 block text-xs text-muted">Use the template’s original colors.</span>
              </button>
              {CV_PALETTES.map((choice) => <button type="button" key={choice.id} aria-label={`${choice.name} palette`} aria-pressed={palette === choice.id} onClick={() => update({ ...preferences, style: applyCvPalette(preferences.style, choice.id) })} className={cn("min-w-0 rounded-xl border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-brand", palette === choice.id ? "border-brand bg-brand-soft" : "border-border hover:border-brand/50")}>
                <span className="flex items-center justify-between gap-2 text-sm font-medium text-foreground">{choice.name}{palette === choice.id && <Check aria-hidden="true" className="size-4 shrink-0 text-brand" />}</span>
                <PaletteSwatches colors={choice.colors} />
                <span className="mt-2 block text-xs leading-relaxed text-muted">{choice.description}</span>
              </button>)}
            </div>
          </fieldset>

          <fieldset disabled={saving || loading} className="min-w-0 rounded-2xl border border-border bg-surface p-5">
            <legend className="px-1 text-base font-medium text-foreground">Typography</legend>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <div className="min-w-0 text-sm text-foreground"><label htmlFor="cv-font">Font</label><select id="cv-font" value={preferences.style.font_family} onChange={(event) => style("font_family", event.target.value)} className={CONTROL}>
                {!FONTS.some(([value]) => value === preferences.style.font_family) && <option value={preferences.style.font_family}>{preferences.style.font_family} (current)</option>}
                {FONTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select></div>
              <div className="min-w-0 text-sm text-foreground"><label htmlFor="cv-font-size">Text size</label><select id="cv-font-size" value={preferences.style.font_size} onChange={(event) => style("font_size", event.target.value)} className={CONTROL}>
                {!SIZES.some(([value]) => value === preferences.style.font_size) && <option value={preferences.style.font_size}>{preferences.style.font_size} (current)</option>}
                {SIZES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select></div>
            </div>
          </fieldset>

          <fieldset disabled={saving || loading} className="min-w-0 rounded-2xl border border-border bg-surface p-5">
            <legend className="px-1 text-base font-medium text-foreground">Applicant tracking systems</legend>
            <label className="flex items-start gap-3 text-sm text-foreground"><input type="checkbox" checked={preferences.useAtsGuidance} onChange={(event) => update({ ...preferences, useAtsGuidance: event.target.checked })} className="mt-0.5 size-4 shrink-0 accent-brand focus-visible:outline-2 focus-visible:outline-brand" /><span>Use ATS guidance when available</span></label>
            <p className="mt-3 text-xs leading-relaxed text-muted">Greenhouse guidance favors a simple ATS layout. Other systems use your preferred template unless you choose an override. Parsing results depend on the employer’s system.</p>
            <a href="https://support.greenhouse.io/hc/en-us/articles/200989175-Unsuccessful-resume-parse" target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-muted underline hover:text-brand">Greenhouse parsing guidance</a>
            <details className="mt-5 border-t border-border pt-4">
              <summary className="min-h-8 cursor-pointer text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-brand">ATS-specific templates</summary>
              <p className="mt-2 text-xs leading-relaxed text-muted">Your choices here take priority over automatic guidance. An explicit template choice for a single generation takes priority over both.</p>
              <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
                {settings.vendors.map((vendor) => <div key={vendor.id} className="min-w-0 text-sm text-foreground"><label htmlFor={`cv-ats-${vendor.id}`}>{vendor.label} template</label><select id={`cv-ats-${vendor.id}`} value={preferences.atsTemplates[vendor.id] || ""} onChange={(event) => {
                  const next = { ...preferences.atsTemplates };
                  if (event.target.value) next[vendor.id] = event.target.value;
                  else delete next[vendor.id];
                  update({ ...preferences, atsTemplates: next });
                }} className={CONTROL}>
                  <option value="">Use preferred template{preferences.useAtsGuidance && vendor.id === "greenhouse" ? " / ATS guidance" : ""}</option>
                  {settings.templates.map((template) => <option key={template.name} value={template.name}>{template.displayName}</option>)}
                </select></div>)}
              </div>
            </details>
          </fieldset>
        </div>

        <section aria-label="Template preview" className="min-w-0 lg:sticky lg:top-4 lg:self-start">
          <div className="rounded-2xl border border-border bg-surface p-4">
            <h2 className="text-base font-medium text-foreground">{selected?.displayName || "CV"} preview</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted">Fictional sample content shows the layout. Your CV content stays unchanged.</p>
            {preview.loading && <div role="status" className="mt-4 flex min-h-80 items-center justify-center gap-2 rounded-xl bg-surface-hover text-sm text-muted"><Loader2 aria-hidden="true" className="size-4 animate-spin" /> Updating preview…</div>}
            {preview.error && <p role="alert" className="mt-4 rounded-xl border border-red-500/30 px-4 py-3 text-sm text-foreground">{preview.error}</p>}
            {!preview.loading && preview.html && <SamplePreview html={preview.html} />}
          </div>
        </section>
      </div>}
    </div>
  );
}

function PaletteSwatches({ colors }: { colors: Partial<Record<string, string>> }) {
  return <span aria-hidden="true" className="mt-2 grid h-5 grid-cols-5 overflow-hidden rounded-md border border-black/10">
    {PALETTE_COLOR_KEYS.map((key) => <span key={key} style={{ backgroundColor: colors[key] || "#f5f5f4" }} />)}
  </span>;
}

function SamplePreview({ html }: { html: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    if (!box.current) return;
    // EVIDENCE: CV Studio uses ResizeObserver to scale a paper-width iframe.
    // Keep A4 geometry so narrow preview panels do not clip or reflow the sample.
    const observer = new ResizeObserver(([entry]) => setScale(Math.min(1, entry.contentRect.width / 794)));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  return <div ref={box} className="mt-4 overflow-hidden rounded-lg border border-border bg-white">
    <div style={{ height: 1123 * scale }}>
      <iframe title="Sample CV preview" sandbox="" srcDoc={html} tabIndex={-1}
        style={{ width: 794, height: 1123, transform: `scale(${scale})`, transformOrigin: "top left", border: 0, display: "block" }} />
    </div>
  </div>;
}
