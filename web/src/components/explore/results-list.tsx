"use client";

import { useMemo, useState } from "react";
import { Search, Plus, Undo2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { DiscoveredOffer } from "@/lib/explore";
import { CHINA_SOURCES } from "@/lib/employer-preset.mjs";
import { CostBadge } from "@/components/cost/cost-badge";
import { DiscoveryCard } from "./discovery-card";
import { useExplore } from "./explore-provider";

export type EnrichedOffer = DiscoveredOffer & { inPipeline: boolean; evaluatedN?: string };

export function ResultsList({ offers: all }: { offers: EnrichedOffer[] }) {
  const { companiesScanned, partial, error, addToPipeline, added, mode, running, ignoring, ignoreNotice, ignoreError, undoIgnore, dismissIgnoreError } = useExplore();
  // Ignored cards leave the list at once; the write waits for the undo window.
  const offers = useMemo(() => (ignoring.size ? all.filter((o) => !ignoring.has(o.url)) : all), [all, ignoring]);
  const isAi = mode === "ai";
  const employer = all.some(o => CHINA_SOURCES.includes(o.source));
  const [sort, setSort] = useState<"fresh" | "company">("fresh");
  const [q, setQ] = useState("");

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = offers;
    if (needle) list = list.filter((o) => o.title.toLowerCase().includes(needle) || o.company.toLowerCase().includes(needle));
    const sorted = [...list].sort((a, b) =>
      sort === "fresh" ? (b.postedAt || "").localeCompare(a.postedAt || "") : a.company.localeCompare(b.company),
    );
    return sorted;
  }, [offers, q, sort]);

  const addable = offers.filter((o) => !o.inPipeline && !o.evaluatedN && !added.has(o.url));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <p className="text-sm text-foreground">
            <span className="font-semibold">{offers.length}</span> {isAi ? `candidate${offers.length === 1 ? "" : "s"}` : employer ? `match${offers.length === 1 ? "" : "es"}` : `fresh role${offers.length === 1 ? "" : "s"}`}
            <CostBadge kind={isAi ? "spend" : "free-network"} size="xs" className="ml-2 align-middle" />
          </p>
          <p className="text-[12px] text-faint">
            {isAi
              ? "found by AI on the open web · unverified until you evaluate"
              : employer ? "From selected employer sites · check the original JD · 0 tokens spent" : `${companiesScanned > 0 ? `${companiesScanned.toLocaleString()} companies scanned · ` : ""}0 tokens spent${partial ? " · some boards were unreachable (normal for public directories)" : ""}`}
          </p>
          {!isAi && error && <p className="text-[12px] text-amber-700 dark:text-amber-300">{error}</p>}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5">
            <Search className="size-3.5 text-faint" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter results…"
              className="w-32 bg-transparent text-[13px] outline-none placeholder:text-faint"
            />
          </div>
          <div className="inline-flex rounded-lg border border-border bg-surface/40 p-0.5 text-xs">
            {(["fresh", "company"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSort(s)}
                className={cn("rounded-md px-2.5 py-1 font-medium capitalize transition-colors", sort === s ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground")}
              >
                {s}
              </button>
            ))}
          </div>
          {addable.length > 1 && (
            <button
              type="button"
              onClick={() => addToPipeline(addable)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-brand-soft hover:text-brand"
            >
              <Plus className="size-3.5" /> Add all {addable.length}
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {view.map((o) => (
          <DiscoveryCard key={o.url} offer={o} inPipeline={o.inPipeline} evaluatedN={o.evaluatedN} />
        ))}
      </div>

      {view.length === 0 && (q.trim() || !running) && (
        <p className="py-10 text-center text-sm text-faint">{q.trim() ? <>No results match “{q}”.</> : "No roles left to show."}</p>
      )}

      {(ignoreNotice || ignoreError) && (
        <div className="fixed inset-x-0 bottom-20 z-40 flex justify-center px-4 sm:bottom-6">
          <div className="inline-flex max-w-full flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-2 text-sm shadow-lg">
            {ignoreError ? (
              <>
                <p role="alert" className="min-w-0 flex-1 break-words text-red-600 dark:text-red-400">{ignoreError}</p>
                <button type="button" onClick={dismissIgnoreError} aria-label="Dismiss" className="inline-flex shrink-0 items-center text-muted hover:text-foreground max-sm:min-h-[44px]">
                  <X className="size-3.5" />
                </button>
              </>
            ) : ignoreNotice ? (
              <>
                <span role="status" className="min-w-0 flex-1 break-words text-muted">
                  Ignored {ignoreNotice.title} · {ignoreNotice.company}. It won&apos;t come back in future scans.
                </span>
                <button type="button" onClick={() => undoIgnore(ignoreNotice.url)} className="inline-flex shrink-0 items-center gap-1 font-medium text-brand max-sm:min-h-[44px]">
                  <Undo2 className="size-3.5" /> Undo
                </button>
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
