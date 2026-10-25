"use client";

import { ChevronDown, ChevronRight, FileText, Search } from "lucide-react";
import { visibleSourcePageIds } from "@/lib/workspace-view.mjs";
import { cn } from "@/lib/cn";
import type { WorkspaceDocumentSummary } from "./types";

type Props = {
  documents: WorkspaceDocumentSummary[];
  selectedDocument: string | null;
  collapsed: Set<string>;
  query: string;
  busy: boolean;
  onQuery: (value: string) => void;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
};

export function SourcePageTree({ documents, selectedDocument, collapsed, query, busy, onQuery, onToggle, onSelect }: Props) {
  const sourcePages = documents.filter((document) => document.kind === "source").sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const visible = visibleSourcePageIds(sourcePages, query);
  const searching = Boolean(query.trim());

  function pages(parentId: string | null, depth = 0, ancestors = new Set<string>()): React.ReactNode {
    const children = sourcePages.filter((document) => (document.parentDocumentId ?? null) === parentId && visible.has(document.id) && !ancestors.has(document.id));
    if (!children.length) return null;
    return <ul className="space-y-0.5">{children.map((document) => {
      const hasChildren = sourcePages.some((page) => page.parentDocumentId === document.id && visible.has(page.id));
      const expanded = searching || !collapsed.has(document.id);
      return <li key={document.id}>
        <div className="flex min-w-0 items-center gap-0.5" style={{ paddingLeft: Math.min(depth, 3) * 12 }}>
          {hasChildren ? <button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${document.title}`} aria-expanded={expanded} onClick={() => onToggle(document.id)} className="flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-brand">{expanded ? <ChevronDown aria-hidden="true" className="size-3.5" /> : <ChevronRight aria-hidden="true" className="size-3.5" />}</button> : <span className="flex size-7 shrink-0 items-center justify-center text-faint"><FileText aria-hidden="true" className="size-3" /></span>}
          <button type="button" title={document.title} disabled={busy} aria-current={selectedDocument === document.id ? "page" : undefined} onClick={() => onSelect(document.id)} className={cn("min-w-0 flex-1 rounded-md px-2 py-2 text-left text-sm leading-5 break-words transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50", selectedDocument === document.id ? "bg-brand/10 font-medium text-foreground" : "text-muted")}>{document.title}{document.error && <span className="ml-1 text-xs text-red-700 dark:text-red-300">Unavailable</span>}</button>
        </div>
        {hasChildren && expanded && pages(document.id, depth + 1, new Set([...ancestors, document.id]))}
      </li>;
    })}</ul>;
  }

  return <nav aria-label="Workspace pages" className="min-w-0">
    <label className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-muted focus-within:border-brand/60"><Search aria-hidden="true" className="size-4 shrink-0" /><input aria-label="Search pages" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search pages" className="min-w-0 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-faint" /></label>
    {pages(null)}
    {!visible.size && <p className="px-2 text-sm text-muted">No pages match your search.</p>}
  </nav>;
}
