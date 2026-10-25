"use client";

import { FileText, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import type { WorkspaceDocumentSummary } from "./types";

type Props = {
  documents: WorkspaceDocumentSummary[];
  selectedDocument: string | null;
  query: string;
  busy: boolean;
  onQuery: (value: string) => void;
  onSelect: (id: string) => void;
};

/** Local files are documents; their headings belong in the separate outline. */
export function DocumentList({ documents, selectedDocument, query, busy, onQuery, onSelect }: Props) {
  const needle = query.trim().toLocaleLowerCase();
  const visible = documents.filter((document) => document.kind !== "source" && document.title.toLocaleLowerCase().includes(needle));
  const groups = [...new Set(visible.map((document) => document.group))];
  return <nav aria-label="Workspace documents" className="min-w-0">
    <label className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-muted focus-within:border-brand/60">
      <Search aria-hidden="true" className="size-4 shrink-0" />
      <input aria-label="Search documents" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search documents" className="min-w-0 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-faint" />
    </label>
    {groups.map((group) => <div key={group} className="mt-5 first:mt-0">
      <h3 className="mb-2 px-2 text-xs font-medium uppercase tracking-wider text-faint">{group}</h3>
      <ul className="space-y-0.5">{visible.filter((document) => document.group === group).map((document) => <li key={document.id}>
        <button type="button" title={document.title} disabled={busy} aria-current={selectedDocument === document.id ? "page" : undefined} onClick={() => onSelect(document.id)} className={cn("flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-2 text-left text-sm leading-5 break-words transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50", selectedDocument === document.id ? "bg-brand/10 font-medium text-foreground" : "text-muted")}>
          <FileText aria-hidden="true" className="mt-1 size-3 shrink-0 text-faint" /><span className="min-w-0">{document.title}{document.error && <span className="ml-1 text-xs text-red-700 dark:text-red-300">Unavailable</span>}{!document.exists && !document.error && <span className="ml-1 text-xs font-normal text-faint">Empty</span>}</span>
        </button>
      </li>)}</ul>
    </div>)}
    {!visible.length && <p className="px-2 text-sm text-muted">No documents match your search.</p>}
  </nav>;
}
