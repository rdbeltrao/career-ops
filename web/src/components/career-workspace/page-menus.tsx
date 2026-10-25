"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PageUsage } from "./types";

export const PAGE_PURPOSE: Record<PageUsage, { label: string; effect: string }> = {
  facts: { label: "Career facts", effect: "Used as evidence for CVs, cover letters and reports." },
  preferences: { label: "Job preferences", effect: "Guides job matching. Never used as evidence of past work." },
  reference: { label: "Reference material", effect: "Background only. Not used as evidence." },
  unconfirmed: { label: "Unconfirmed notes", effect: "Kept out of claims until you confirm them." },
};

const ITEMS = "[role^=menuitem]:not([disabled])";
const panel = "absolute top-full z-30 mt-1 rounded-xl border border-border bg-surface py-1 shadow-xl";

/**
 * Shared menu-button behavior: Escape or a press outside closes the menu and
 * returns focus to its button; arrow keys, Home and End move between items.
 */
function useMenu() {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback((refocus: boolean) => { setOpen(false); if (refocus) button.current?.focus(); }, []);

  useEffect(() => {
    if (!open) return;
    const items = [...(menu.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    const onPointer = (event: MouseEvent) => { if (!container.current?.contains(event.target as Node)) close(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(true); } };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open, close]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Tab") { close(false); return; }
    const items = [...(menu.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = ({ ArrowDown: (index + 1) % items.length, ArrowUp: (index - 1 + items.length) % items.length, Home: 0, End: items.length - 1 } as Record<string, number>)[event.key];
    if (next === undefined) return;
    event.preventDefault();
    items[next].focus();
  }

  const triggerProps = { ref: button, type: "button" as const, "aria-haspopup": "menu" as const, "aria-expanded": open, "aria-controls": open ? id : undefined, onClick: () => setOpen((value) => !value) };
  const menuProps = { ref: menu, id, role: "menu", onKeyDown };
  return { open, close, container, triggerProps, menuProps };
}

type PurposeProps = {
  usage: PageUsage;
  inheritedFrom: string | null;
  inheritingCount: number;
  disabled: boolean;
  onChange: (usage: PageUsage) => void;
};

/** States in plain words whether a page counts as evidence, with the purpose change one click away. */
export function PagePurpose({ usage, inheritedFrom, inheritingCount, disabled, onChange }: PurposeProps) {
  const { open, close, container, triggerProps, menuProps } = useMenu();
  const statusId = useId();
  const purpose = PAGE_PURPOSE[usage];

  return <div ref={container} className="relative mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
    <p id={statusId} className="text-muted"><span aria-hidden="true" className={cn("mr-2 inline-block size-2 rounded-full align-middle", usage === "facts" ? "bg-brand" : "border border-faint")} /><span className="font-medium text-foreground">{purpose.label}</span> · {purpose.effect}{inheritedFrom && <> Set on {inheritedFrom}.</>}</p>
    <button {...triggerProps} aria-label="Change page purpose" aria-describedby={statusId} disabled={disabled} className="rounded px-1 text-sm text-brand underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-40">Change</button>
    {open && <div {...menuProps} aria-label="How evaluations use this page" className={cn(panel, "left-0 w-[min(26rem,calc(100vw-2rem))]")}>
      {inheritingCount > 0 && <p className="px-3 pb-1 pt-2 text-xs text-muted">Also applies to {inheritingCount} {inheritingCount === 1 ? "page inside this one that has" : "pages inside this one that have"} no purpose of {inheritingCount === 1 ? "its" : "their"} own.</p>}
      {(Object.keys(PAGE_PURPOSE) as PageUsage[]).map((value) => <button key={value} type="button" role="menuitemradio" aria-checked={value === usage} onClick={() => { close(true); if (value !== usage) onChange(value); }} className="flex w-full gap-3 px-3 py-2 text-left hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none">
        <Check aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0 text-brand", value !== usage && "invisible")} />
        <span><span className="block text-sm text-foreground">{PAGE_PURPOSE[value].label}</span><span className="block text-xs text-muted">{PAGE_PURPOSE[value].effect}</span></span>
      </button>)}
    </div>}
  </div>;
}

export type PageAction = { label: string; icon: React.ReactNode; disabled?: boolean; onSelect: () => void };

/** Rare page operations (create, rename, reorder) kept behind one button. */
export function PageActionsMenu({ actions, disabled, className }: { actions: PageAction[]; disabled: boolean; className: string }) {
  const { open, close, container, triggerProps, menuProps } = useMenu();
  return <div ref={container} className="relative">
    <button {...triggerProps} disabled={disabled} className={className}><MoreHorizontal aria-hidden="true" className="size-4" />Page actions</button>
    {open && <div {...menuProps} aria-label="Page actions" className={cn(panel, "right-0 min-w-48")}>
      {actions.map((action) => <button key={action.label} type="button" role="menuitem" disabled={action.disabled} onClick={() => { close(true); action.onSelect(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none disabled:text-faint disabled:hover:bg-transparent">{action.icon}{action.label}</button>)}
    </div>}
  </div>;
}
