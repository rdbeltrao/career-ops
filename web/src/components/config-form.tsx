"use client";

import { useEffect, useState } from "react";
import {
  Check,
  KeyRound,
  TerminalSquare,
  Terminal,
  Loader2,
  CircleDashed,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { CadenceSettings } from "@/components/followups/cadence-settings";
import { persistCliId, readSavedCliId } from "@/lib/saved-cli";
import { keepIfInstalled, pickDefaultInstalled } from "@/lib/cli-pick.mjs";
import { ConfigFiles } from "@/components/config-files";
import { AiModelFields, type AiModelSelection } from "@/components/ai-model-fields";
import { normalizeAiSettings } from "@/lib/ai-settings.mjs";

type Cli = {
  id: string;
  name: string;
  run: string;
  url: string;
  installed: boolean;
  path: string | null;
};

type Mode = "cli" | "key" | "manual";

const STORAGE_KEY = "career-ops:config";

export function ConfigForm() {
  const [mode, setMode] = useState<Mode>("cli");
  const [clis, setClis] = useState<Cli[] | null>(null);
  const [cliId, setCliId] = useState<string>("");
  const [models, setModels] = useState<Record<string, AiModelSelection>>({});
  const [settingsReady, setSettingsReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [logos, setLogos] = useState(true);
  const [saved, setSaved] = useState(false);

  // Load saved prefs
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const v = JSON.parse(raw);
        // key/manual are not wired yet (nothing reads them) → never restore into
        // those dead panels; only the Installed-CLI path is functional.
        if (v.mode === "cli") setMode("cli");
        if (v.cliId) setCliId(v.cliId);
        if (typeof v.logos === "boolean") setLogos(v.logos);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // EVIDENCE: server files are the shared source of truth; browser storage only
  // supplies the legacy initial tool choice until AI settings have been saved.
  useEffect(() => {
    let active = true;
    Promise.all([
      fetch("/api/clis").then(async (response) => {
        if (!response.ok) throw new Error("Could not detect installed AI tools. Reload Config to retry.");
        return response.json();
      }),
      fetch("/api/ai-settings", { cache: "no-store" }).then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load AI settings. Reload Config to retry.");
        if (!data.settings || typeof data.settings !== "object") throw new Error("The AI settings response was invalid. Reload Config to retry.");
        return normalizeAiSettings(data.settings);
      }),
    ])
      .then(([d, settings]) => {
        if (!active) return;
        const list: Cli[] = d.clis ?? [];
        setClis(list);
        setModels(settings.models);
        // Highlight + persist the default installed CLI when Config was never
        // saved. Highlight-only looks configured while jobs still read empty
        // localStorage -- so whatever is rendered as selected must be written.
        // This applies at ANY installed count: restricting it to a SOLE install
        // left every multi-CLI machine (claude + codex, say) in exactly the
        // broken state the highlight was meant to avoid.
        setCliId((prev) => {
          if (keepIfInstalled(settings.cliId, list)) return settings.cliId;
          // A restored id whose CLI is no longer installed must not stick: it
          // would stay selected and save() would write it straight back, so
          // "open Config and click Save config" could never clear it (#4012).
          if (keepIfInstalled(prev, list)) return prev;
          const auto = pickDefaultInstalled(list, typeof d.remembered === "string" ? d.remembered : null);
          if (!auto) return "";
          if (!readSavedCliId()) persistCliId(auto);
          return auto;
        });
        setSettingsReady(true);
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Could not load AI settings. Reload Config to retry.");
          setClis([]);
        }
      });
    return () => { active = false; };
  }, []);

  function changed() {
    setSaved(false);
    if (settingsReady) setError("");
  }

  async function save() {
    if (!settingsReady || saving) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const settings = normalizeAiSettings({ version: 1, cliId, models });
      const response = await fetch("/api/ai-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "AI settings could not be saved. Try again.");
      if (!data.settings || typeof data.settings !== "object") throw new Error("The saved AI settings response was invalid. Reload Config to check the saved values.");
      setModels(normalizeAiSettings(data.settings).models);
      if (cliId) persistCliId(cliId);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, cliId, logos }));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "AI settings could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const installed = clis?.filter((c) => c.installed) ?? [];

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="font-display text-2xl tracking-tight text-landing">Config</h1>
      <p className="mt-1 text-sm text-muted">
        Your files stay on your computer. AI prompts are sent through your chosen tool to its selected provider.
      </p>
      <a href="#yaml-files" className="mt-3 inline-block text-sm text-brand hover:underline">View and edit YAML configuration files</a>

      {/* Engine mode */}
      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        AI Engine
      </label>
      <div className="grid gap-2 sm:grid-cols-3">
        <ModeCard
          active={mode === "cli"}
          onClick={() => setMode("cli")}
          icon={Terminal}
          title="Use an AI tool you have"
          hint="Recommended"
        />
        <ModeCard
          active={mode === "key"}
          onClick={() => setMode("key")}
          icon={KeyRound}
          title="Paste an AI key"
          hint="Coming soon"
          disabled
        />
        <ModeCard
          active={mode === "manual"}
          onClick={() => setMode("manual")}
          icon={TerminalSquare}
          title="No setup needed"
          hint="Coming soon"
          disabled
        />
      </div>

      <div className="mt-6">
        {mode === "cli" && (
          <div>
            <p className="mb-1 text-sm text-muted">
              career-ops uses an AI tool you already have — signed in, your own usage, nothing to paste.
            </p>
            <p className="mb-3 text-xs text-faint">Works with Claude Code, Codex, OpenCode and more — free ones work great.</p>
            {clis === null ? (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Loader2 className="size-4 animate-spin" /> Checking what&apos;s on your computer…
              </div>
            ) : !settingsReady && error ? null : installed.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
                No AI tool yet? Free options like <span className="text-foreground">OpenCode</span> with Qwen or GLM work great.{" "}
                <a href="https://career-ops.org/docs/free-ai-engine" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand hover:underline">
                  Get one free <ExternalLink className="size-3" />
                </a>
              </div>
            ) : (
              <div className="space-y-2">
                {clis.map((c) => {
                  const selected = c.id === cliId;
                  const rowClassName = cn(
                    "flex items-center gap-3 rounded-xl border px-4 py-3 text-sm transition-colors",
                    selected
                      ? "border-brand/50 bg-brand-soft"
                      : c.installed
                        ? "border-border bg-surface/50"
                        : "border-border/60 bg-surface/20",
                  );

                  if (c.installed) {
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => { changed(); setCliId(c.id); }}
                        disabled={!settingsReady || saving}
                        aria-pressed={selected}
                        className={cn(rowClassName, "w-full cursor-pointer text-left")}
                      >
                        <Check className="size-4 shrink-0 text-emerald-400" />
                        <span className="flex min-w-0 flex-1 items-center gap-2">
                          <span className={cn("font-medium", selected ? "text-foreground" : "")}>
                            {c.name}
                          </span>
                          <span className="font-mono text-xs text-faint">{c.run}</span>
                        </span>
                        <span className="hidden max-w-[40%] shrink-0 truncate text-xs text-faint sm:block">
                          {c.path}
                        </span>
                      </button>
                    );
                  }

                  return (
                    <div
                      key={c.id}
                      className={rowClassName}
                    >
                      <CircleDashed className="size-4 shrink-0 text-faint" />
                      <button
                        type="button"
                        disabled
                        className="flex flex-1 items-center gap-2 text-left max-sm:min-h-[44px] cursor-default"
                      >
                        <span className="font-medium text-muted">
                          {c.name}
                        </span>
                        <span className="font-mono text-xs text-faint">{c.run}</span>
                      </button>
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex shrink-0 items-center justify-center gap-1 text-xs text-brand hover:underline max-sm:min-h-[44px]"
                      >
                        Install <ExternalLink className="size-3" />
                      </a>
                    </div>
                  );
                })}
                {installed.length === 0 && (
                  <p className="rounded-xl border border-dashed border-border bg-surface/30 p-4 text-xs text-muted">
                    No supported CLI found on your PATH. Install one (e.g. Claude Code, Gemini CLI, OpenCode) to get started.
                  </p>
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-faint">
                  Best on <span className="text-muted">Claude Code</span> (live progress, the agentic apply + AI search,
                  reliable evaluation persistence). Other CLIs work for the core flows with reduced features.
                </p>
              </div>
            )}
          </div>
        )}

        {cliId && settingsReady && (
          <AiModelFields
            key={cliId}
            cliId={cliId}
            selection={models[cliId] ?? { provider: "", model: "" }}
            disabled={saving}
            onChange={(selection) => {
              changed();
              setModels((previous) => ({ ...previous, [cliId]: selection }));
            }}
          />
        )}
        <p className="mt-4 text-xs text-faint">Saved selections apply to new AI runs. Credentials remain in your selected AI tool.</p>
        {error && (
          <div role="alert" className="mt-4 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-300">
            {error}
            {!settingsReady && <button type="button" onClick={() => window.location.reload()} className="ml-2 underline">Reload Config</button>}
          </div>
        )}
      </div>

      {/* Appearance / privacy */}
      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        Appearance
      </label>
      <button
        type="button"
        onClick={() => { changed(); setLogos((v) => !v); }}
        disabled={saving}
        className="flex w-full items-center justify-between gap-4 rounded-xl border border-border bg-surface/50 px-4 py-3 text-left transition-colors hover:bg-surface-hover"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">Company logos</span>
          <span className="mt-0.5 block text-xs text-faint">
            Show each company&apos;s real logo. Fetched once through your local server and cached on
            disk — only the employer domain is sent to a third party. Off = colored monograms only.
          </span>
        </span>
        <span
          className={cn(
            "relative h-6 w-11 shrink-0 rounded-full transition-colors",
            logos ? "bg-brand" : "bg-surface-hover",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform",
              logos ? "translate-x-[1.375rem]" : "translate-x-0.5",
            )}
          />
        </span>
      </button>

      <CadenceSettings />

      <div className="mt-8 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!settingsReady || saving}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-5 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-[44px]"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {saved ? <Check className="size-4" /> : null}
          {saving ? "Saving…" : saved ? "Saved" : "Save config"}
        </button>
        <span aria-live="polite" className="text-xs text-faint">{saved ? "AI settings saved for this career-ops workspace." : "Save to use these settings for new runs."}</span>
      </div>
      <ConfigFiles />
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  icon: Icon,
  title,
  hint,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={cn(
        "flex flex-col gap-1.5 rounded-xl border px-4 py-3 text-left transition-colors",
        disabled
          ? "cursor-not-allowed border-border bg-surface/30 opacity-55"
          : active
            ? "border-brand/50 bg-brand-soft"
            : "border-border bg-surface/50 hover:bg-surface-hover",
      )}
    >
      <Icon className={cn("size-4", active && !disabled ? "text-brand" : "text-muted")} />
      <span className="text-sm font-medium text-foreground">{title}</span>
      <span className="text-xs text-faint">{hint}</span>
    </button>
  );
}
