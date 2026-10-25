"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Clock, Loader2, MapPin } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ExploreFilters } from "@/lib/explore";
import type { LinkedInSchedule } from "@/lib/scheduled-jobs";
import type { LinkedInState } from "@/lib/linkedin-settings";
import { KeywordField, Label, STYLE } from "@/components/explore/filter-builder";

const WINDOWS = [
  { days: 1, label: "24h" },
  { days: 3, label: "3d" },
  { days: 7, label: "7d" },
  { days: 14, label: "14d" },
  { days: 30, label: "30d" },
];

function preview(list: string[], max = 4) {
  if (!list.length) return "none set";
  return list.length > max ? `${list.slice(0, max).join(", ")} +${list.length - max} more` : list.join(", ");
}

/**
 * The schedule form for the LinkedIn engine. It replaces the ATS filter builder:
 * a LinkedIn run reads the user's saved searches, so the form says which ones
 * run, and every filter defaults to what portals.yml already holds. A field
 * the user fills replaces only that filter for this schedule.
 */
export function LinkedInScheduleFields({
  filters,
  onFiltersChange,
  linkedin,
  onLinkedInChange,
}: {
  filters: ExploreFilters;
  onFiltersChange: (f: ExploreFilters) => void;
  linkedin: LinkedInSchedule;
  onLinkedInChange: (l: LinkedInSchedule) => void;
}) {
  const [state, setState] = useState<LinkedInState | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let live = true;
    fetch("/api/linkedin", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: LinkedInState) => live && setState(d))
      .catch(() => live && setLoadError("Your LinkedIn searches could not be loaded."));
    return () => {
      live = false;
    };
  }, []);

  const set = (patch: Partial<ExploreFilters>) => onFiltersChange({ ...filters, ...patch });
  const on = state?.searches.filter((s) => s.enabled) ?? [];
  const off = state?.searches.filter((s) => !s.enabled) ?? [];
  const choosing = linkedin.searches.length > 0;
  const missing = state ? linkedin.searches.filter((n) => !on.some((s) => s.name === n)) : [];
  const pf = state?.portalsFilters;

  const toggleSearch = (name: string, checked: boolean) => {
    const next = checked ? [...linkedin.searches, name] : linkedin.searches.filter((n) => n !== name);
    onLinkedInChange({ ...linkedin, searches: next });
  };

  return (
    <div className="space-y-5">
      <style>{STYLE}</style>

      {/* ── Which searches ── */}
      <fieldset>
        <legend className="mb-1.5 text-[13px] font-medium text-foreground">LinkedIn searches this schedule runs</legend>
        {!state && !loadError && (
          <p className="flex items-center gap-2 text-xs text-muted">
            <Loader2 className="size-3.5 animate-spin" /> Loading your searches…
          </p>
        )}
        {loadError && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{loadError}</p>}
        {state && (
          <>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="inline-flex items-center gap-2">
                <input type="radio" name="linkedin-scope" checked={!choosing} onChange={() => onLinkedInChange({ ...linkedin, searches: [] })} />
                Every search that is on ({on.length})
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="radio" name="linkedin-scope" checked={choosing} disabled={on.length === 0} onChange={() => onLinkedInChange({ ...linkedin, searches: on.map((s) => s.name) })} />
                Only the ones I pick
              </label>
            </div>
            <ul className="mt-2.5 space-y-1.5">
              {on.map((s) => (
                <li key={s.name}>
                  <label className={cn("flex items-start gap-2.5 rounded-lg border border-border px-3 py-2 text-sm", !choosing && "opacity-80")}>
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={!choosing || linkedin.searches.includes(s.name)}
                      disabled={!choosing}
                      onChange={(e) => toggleSearch(s.name, e.target.checked)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-foreground">{s.name}</span>
                      <span className="block truncate text-xs text-muted">
                        {s.description ? [s.description.keywords && `"${s.description.keywords}"`, s.description.posted, s.description.workplace.join(" / ")].filter(Boolean).join(" · ") : s.searchUrl}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {off.length > 0 && (
              <p className="mt-2 text-[11px] text-faint">
                Off on the LinkedIn page, so never run: {off.map((s) => s.name).join(", ")}.
              </p>
            )}
            {on.length === 0 && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">No LinkedIn search is on yet, so this schedule would have nothing to run.</p>}
            {choosing && missing.length > 0 && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                No longer on or not in portals.yml, so skipped: {missing.join(", ")}.
              </p>
            )}
            <p className="mt-2 text-[11px] text-faint">
              Add or change searches on the <Link href="/linkedin" className="text-brand hover:underline">LinkedIn page</Link>.
            </p>
          </>
        )}
      </fieldset>

      {/* ── Posted within ── */}
      <div>
        <Label hint="each LinkedIn search has its own date filter">
          <span className="inline-flex items-center gap-1.5">
            <Clock className="size-3.5 text-muted" /> Posted within
          </span>
        </Label>
        <div className="inline-flex flex-wrap rounded-lg border border-border bg-surface/40 p-0.5">
          <button
            type="button"
            onClick={() => onLinkedInChange({ ...linkedin, useSearchWindow: true })}
            aria-pressed={linkedin.useSearchWindow}
            className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px]", linkedin.useSearchWindow ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground")}
          >
            Each search&apos;s own
          </button>
          {WINDOWS.map((w) => {
            const active = !linkedin.useSearchWindow && filters.sinceDays === w.days;
            return (
              <button
                key={w.days}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  onLinkedInChange({ ...linkedin, useSearchWindow: false });
                  set({ sinceDays: w.days });
                }}
                className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px]", active ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground")}
              >
                {w.label}
              </button>
            );
          })}
        </div>
        {!linkedin.useSearchWindow && <p className="mt-1 text-[11px] text-faint">Applies on top of each search&apos;s own window; the narrower one wins.</p>}
      </div>

      {/* ── Filters: portals.yml unless set ── */}
      <div className="space-y-4">
        <p className="text-[12px] text-muted">
          Results use your saved title and location filters. Leave a field empty to inherit its list, or fill it to override that list for this schedule.{" "}
          <Link href="/config#yaml-portals" target="_blank" rel="noreferrer" className="text-brand hover:underline">View or edit portals.yml in Config</Link>.
        </p>
        <div>
          <Label hint={filters.positive.length ? "replaces your title keywords" : `Uses portals.yml: ${pf ? preview(pf.positive) : "…"}`}>Roles to find</Label>
          <KeywordField ariaLabel="Roles to find" values={filters.positive} tone="inc" placeholder="Leave empty to use portals.yml" onChange={(v) => set({ positive: v })} />
        </div>
        <div>
          <Label hint={filters.negative.length ? "replaces your exclusions" : `Uses portals.yml: ${pf ? preview(pf.negative) : "…"}`}>Exclude</Label>
          <KeywordField ariaLabel="Exclude" values={filters.negative} tone="exc" placeholder="Leave empty to use portals.yml" onChange={(v) => set({ negative: v })} />
        </div>
        <div>
          <Label hint={filters.allow.length ? "replaces your allowed locations" : `Uses portals.yml: ${pf ? preview(pf.allow) : "…"}`}>
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="size-3.5 text-muted" /> City or location
            </span>
          </Label>
          <KeywordField ariaLabel="City or location" values={filters.allow} tone="inc" placeholder="Leave empty to use portals.yml" onChange={(v) => set({ allow: v })} />
        </div>
      </div>
    </div>
  );
}
