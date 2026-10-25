"use client";

import { ChevronDown, ChevronRight, FileText, Search } from "lucide-react";
import { visiblePageIds } from "@/lib/workspace-view.mjs";
import { cn } from "@/lib/cn";
import type { PageSelection, WorkspaceDocumentSummary, WorkspaceSection } from "./types";

type Props = {
  documents: WorkspaceDocumentSummary[];
  selected: PageSelection;
  collapsed: Set<string>;
  query: string;
  busy: boolean;
  onQuery: (value: string) => void;
  onToggle: (key: string) => void;
  onSelect: (selection: PageSelection) => void;
};

export function PageTree({ documents, selected, collapsed, query, busy, onQuery, onToggle, onSelect }: Props) {
  const groups = [...new Set(documents.map((document) => document.group))];
  const needle = query.trim().toLocaleLowerCase();
  let matches = 0;

  function pages(document: WorkspaceDocumentSummary, parentId: string | null, visible: Set<string>, depth = 0) {
    if (depth > 6) return null;
    const children = document.sections.filter((section) => section.parentId === parentId && visible.has(section.id));
    if (!children.length) return null;
    return (
      <ul className="ml-3 space-y-0.5 border-l border-border/70 pl-2">
        {children.map((section: WorkspaceSection) => {
          const key = `${document.id}:${section.id}`;
          const hasChildren = document.sections.some((page) => page.parentId === section.id && visible.has(page.id));
          const expanded = Boolean(needle) || !collapsed.has(key);
          return (
            <li key={section.id}>
              <div className="flex min-w-0 items-center gap-0.5">
                {hasChildren ? (
                  <button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${section.title}`} aria-expanded={expanded} onClick={() => onToggle(key)} className="flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-brand">
                    {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  </button>
                ) : <span className="flex size-7 shrink-0 items-center justify-center text-faint"><FileText className="size-3" /></span>}
                <button
                  type="button"
                  disabled={busy}
                  aria-current={selected.document === document.id && selected.section === section.id ? "page" : undefined}
                  onClick={() => onSelect({ document: document.id, section: section.id })}
                  className={cn("min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-sm break-words transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50", selected.document === document.id && selected.section === section.id ? "bg-brand/10 font-medium text-foreground" : "text-muted")}
                >{section.title}</button>
              </div>
              {hasChildren && expanded && pages(document, section.id, visible, depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  }

  const lists = groups.map((group) => {
    const grouped = documents.filter((document) => document.group === group).flatMap((document) => {
      const visible = visiblePageIds(document.sections, document.title.toLocaleLowerCase().includes(needle) ? "" : query) as Set<string>;
      if (needle && !document.title.toLocaleLowerCase().includes(needle) && visible.size === 0) return [];
      matches++;
      const expanded = Boolean(needle) || !collapsed.has(document.id);
      return [
        <li key={document.id}>
          <div className="flex min-w-0 items-center gap-0.5">
            <button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${document.title}`} aria-expanded={expanded} onClick={() => onToggle(document.id)} disabled={!document.sections.length} className="flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-30">
              {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
            <button type="button" disabled={busy} aria-current={selected.document === document.id && !selected.section ? "page" : undefined} onClick={() => onSelect({ document: document.id, section: null })} className={cn("min-w-0 flex-1 rounded-md px-2 py-2 text-left text-sm font-medium break-words transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50", selected.document === document.id && !selected.section ? "bg-brand/10 text-foreground" : "text-muted")}>
              {document.title}
              {document.error && <span className="ml-1 text-xs text-red-700 dark:text-red-300">Unavailable</span>}
              {!document.exists && !document.error && <span className="ml-1 text-xs font-normal text-faint">Empty</span>}
            </button>
          </div>
          {expanded && pages(document, null, visible)}
        </li>,
      ];
    });
    if (!grouped.length) return null;
    return <div key={group} className="mt-5 first:mt-0"><h2 className="mb-2 px-2 text-xs font-medium uppercase tracking-wider text-faint">{group === "Reference" ? "Reference library" : group}</h2><ul className="space-y-1">{grouped}</ul></div>;
  });

  return (
    <nav aria-label="Workspace pages" className="min-w-0">
      <label className="mb-5 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-muted focus-within:border-brand/60">
        <Search aria-hidden="true" className="size-4 shrink-0" />
        <input aria-label="Search pages" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search pages" className="min-w-0 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-faint" />
      </label>
      {lists}
      {!matches && <p className="px-2 text-sm text-muted">No pages match your search.</p>}
    </nav>
  );
}
