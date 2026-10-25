"use client";

import { Hash, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import type { WorkspaceSection } from "./types";

export type OutlineSection = WorkspaceSection & { headingIndex: number; depth: number };

type Props = {
  sections: OutlineSection[];
  selected: string | null;
  query: string;
  busy: boolean;
  onQuery: (value: string) => void;
  onSelect: (section: OutlineSection) => void;
};

export function DocumentOutline({ sections, selected, query, busy, onQuery, onSelect }: Props) {
  const needle = query.trim().toLocaleLowerCase();
  const visible = sections.filter((section) => section.title.toLocaleLowerCase().includes(needle));
  return <nav aria-label="Document sections" className="min-w-0">
    <label className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-muted focus-within:border-brand/60">
      <Search aria-hidden="true" className="size-4 shrink-0" />
      <input aria-label="Search sections" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search sections" className="min-w-0 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-faint" />
    </label>
    <ul className="space-y-0.5">{visible.map((section) => <li key={section.id} style={{ paddingLeft: Math.min(section.depth, 4) * 12 }}>
      <button type="button" title={section.title} disabled={busy} aria-current={selected === section.id ? "location" : undefined} onClick={() => onSelect(section)} className={cn("flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-2 text-left text-sm leading-5 break-words transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50", selected === section.id ? "bg-brand/10 font-medium text-foreground" : "text-muted")}>
        <Hash aria-hidden="true" className="mt-1 size-3 shrink-0 text-faint" /><span className="min-w-0">{section.title}</span>
      </button>
    </li>)}</ul>
    {!visible.length && <p className="px-2 text-sm text-muted">{needle ? "No sections match your search." : "Add headings to your document to see its sections here."}</p>}
  </nav>;
}
