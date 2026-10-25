"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import type { EditorState } from "lexical";
import { Code2, PenLine } from "lucide-react";
import { analyzeMarkdown, EDITOR_NODES, EDITOR_TRANSFORMERS, exportMarkdown, importMarkdown, registerAllowedLinkTransform, roundTripMarkdown, safeLinkUrl } from "@/lib/editor-markdown.mjs";
import { normalizeWorkspaceLinks } from "@/lib/workspace-links.mjs";
import { EditorToolbar } from "./editor-toolbar";
import { BlockMovePlugin, EditablePlugin, SlashMenuPlugin } from "./editor-plugins";

export type MarkdownEditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  documentKey: string;
  disabled?: boolean;
  linkPages?: { id: string; title?: string }[];
  sectionTarget?: { headingIndex: number; start: number; bodyStart: number; request: number } | null;
};

const theme = {
  paragraph: "mb-3 leading-7",
  heading: { h1: "mb-5 mt-7 text-3xl font-semibold tracking-tight", h2: "mb-4 mt-6 text-2xl font-semibold tracking-tight", h3: "mb-3 mt-5 text-xl font-semibold", h4: "mb-3 mt-4 text-lg font-semibold", h5: "mb-2 mt-4 font-semibold", h6: "mb-2 mt-4 font-semibold" },
  quote: "my-4 rounded-r-lg border-l-3 border-brand/50 bg-brand/5 px-4 py-3 text-muted",
  list: { ul: "my-3 list-disc pl-6", ol: "my-3 list-decimal pl-6", listitem: "my-1 pl-1", nested: { listitem: "list-none" } },
  link: "text-brand underline decoration-brand/40 underline-offset-3",
  text: { bold: "font-semibold", italic: "italic", strikethrough: "line-through", code: "rounded bg-surface px-1 py-0.5 font-mono text-[0.9em]" },
  code: "my-4 overflow-x-auto rounded-lg bg-surface p-4 font-mono text-sm whitespace-pre",
  hr: "my-6 border-border",
};

/** documentKey identifies a loaded revision; keystrokes do not reinitialise it. */
export function MarkdownEditor(props: MarkdownEditorProps) {
  return <EditorDocument key={props.documentKey} {...props} />;
}

function EditorDocument({ value, onChange, disabled = false, linkPages = [], sectionTarget }: MarkdownEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const [initialAnalysis] = useState(() => analyzeMarkdown(normalizeWorkspaceLinks(value, linkPages)));
  const [draft, setDraft] = useState(value);
  const [sourceMode, setSourceMode] = useState(false);
  const [richMode, setRichMode] = useState(initialAnalysis.safe);
  const [reason, setReason] = useState(initialAnalysis.reason);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!sectionTarget) return;
    // Wait until the mobile navigation dialog has closed before moving focus.
    const frame = requestAnimationFrame(() => {
      const source = container.current?.querySelector("textarea");
      if (source) {
        source.focus();
        source.setSelectionRange(sectionTarget.start, sectionTarget.bodyStart);
        source.scrollIntoView({ block: "center" });
        return;
      }
      const heading = container.current?.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")[sectionTarget.headingIndex];
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
        heading.scrollIntoView({ block: "center" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [sectionTarget, sourceMode, richMode, generation]);

  function changed(markdown: string) { setDraft(markdown); onChange(markdown); }

  function toggleMode() {
    if (!sourceMode) { setSourceMode(true); return; }
    const analysis = analyzeMarkdown(normalizeWorkspaceLinks(draft, linkPages));
    setReason(analysis.reason);
    setRichMode(analysis.safe);
    if (analysis.safe) setGeneration((value) => value + 1);
    setSourceMode(false);
  }

  return <div ref={container} className="min-w-0 rounded-xl border border-border/80 bg-surface/20">
    <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
      <p className="text-xs text-muted">{sourceMode ? "Markdown source" : richMode ? "Type / to insert a block" : "Formatted view"}</p>
      <button type="button" onClick={toggleMode} disabled={disabled} aria-pressed={sourceMode} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-surface hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-40">
        {sourceMode ? <PenLine className="size-3.5" /> : <Code2 className="size-3.5" />}{sourceMode ? richMode ? "Rich text" : "Preview" : "Source"}
      </button>
    </div>
    {reason && <p role="status" className="border-b border-border/60 px-4 py-3 text-xs leading-relaxed text-muted">{reason}</p>}
    {sourceMode ? <>
      <textarea aria-label="Markdown source" disabled={disabled} value={draft} onChange={(event) => changed(event.target.value)} spellCheck={false} className="min-h-[55vh] w-full resize-y rounded-b-xl bg-transparent p-5 font-mono text-sm leading-7 text-foreground outline-none focus:ring-2 focus:ring-inset focus:ring-brand/30 disabled:opacity-60" />
    </> : richMode ? <RichEditor key={generation} initialValue={draft} linkPages={linkPages} disabled={disabled} onChange={changed} onError={() => { setReason("Rich editing stopped. Your last recoverable draft is shown below; review its Source before saving."); setRichMode(false); }} /> : <FormattedPage value={draft} linkPages={linkPages} />}
  </div>;
}

/** Rendering never imports or rewrites the canonical Markdown draft. */
function FormattedPage({ value, linkPages }: { value: string; linkPages: NonNullable<MarkdownEditorProps["linkPages"]> }) {
  const displayValue = useMemo(() => normalizeWorkspaceLinks(value, linkPages), [value, linkPages]);
  return <article aria-label="Formatted page" className="report-prose min-h-[55vh] min-w-0 overflow-x-auto px-6 py-5 text-sm text-foreground [&>*:first-child]:mt-0">
    {/* No raw-HTML plugin: comments stay hidden and embedded HTML cannot run. */}
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={(url) => safeLinkUrl(url) ? url : undefined}>{displayValue}</ReactMarkdown>
  </article>;
}

function AllowedLinksPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerAllowedLinkTransform(editor), [editor]);
  return null;
}

function RichEditor({ initialValue, linkPages, disabled, onChange, onError }: { initialValue: string; linkPages: NonNullable<MarkdownEditorProps["linkPages"]>; disabled: boolean; onChange: (markdown: string) => void; onError: () => void }) {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const [displayValue] = useState(() => normalizeWorkspaceLinks(initialValue, linkPages));
  const original = useRef(initialValue);
  const baseline = useRef<string | null>(null);
  if (baseline.current === null) baseline.current = roundTripMarkdown(displayValue);
  const previous = useRef(baseline.current);
  const config = useMemo(() => ({
    namespace: "career-document",
    nodes: EDITOR_NODES,
    theme,
    editable: !disabled,
    editorState: () => importMarkdown(displayValue),
    onError,
    // The component is remounted explicitly when its document or mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  function handleChange(state: EditorState) {
    try {
      const markdown = state.read(() => exportMarkdown());
      if (markdown === previous.current) return;
      previous.current = markdown;
      // Display labels and import/export may normalise Markdown spelling. Never
      // publish that on open; undoing to the display baseline restores exact source.
      onChange(markdown === baseline.current ? original.current : markdown);
    } catch { onError(); }
  }

  return <LexicalComposer initialConfig={config}>
    <EditorToolbar disabled={disabled} />
    <div ref={setAnchor} className="relative min-h-[55vh]">
      <RichTextPlugin contentEditable={<ContentEditable aria-label="Page content" aria-placeholder="Write here, or type / for blocks…" placeholder={<div className="pointer-events-none absolute left-9 top-6 text-sm text-faint">Write here, or type / for blocks…</div>} className="min-h-[55vh] px-9 py-5 text-sm text-foreground outline-none focus:ring-2 focus:ring-inset focus:ring-brand/20 [&>*:first-child]:mt-0" />} ErrorBoundary={LexicalErrorBoundary} />
      {anchor && <BlockMovePlugin anchor={anchor} />}
    </div>
    <HistoryPlugin />
    <ListPlugin />
    <AllowedLinksPlugin />
    <LinkPlugin validateUrl={safeLinkUrl} />
    <MarkdownShortcutPlugin transformers={EDITOR_TRANSFORMERS} />
    <OnChangePlugin ignoreSelectionChange ignoreHistoryMergeTagChange={false} onChange={handleChange} />
    <EditablePlugin disabled={disabled} />
    {!disabled && <SlashMenuPlugin />}
  </LexicalComposer>;
}
