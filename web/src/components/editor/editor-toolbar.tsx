"use client";

import { useEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection, $setSelection, CAN_REDO_COMMAND, CAN_UNDO_COMMAND, COMMAND_PRIORITY_LOW, FORMAT_TEXT_COMMAND, INDENT_CONTENT_COMMAND, OUTDENT_CONTENT_COMMAND, REDO_COMMAND, UNDO_COMMAND, type BaseSelection, type LexicalCommand } from "lexical";
import { $isLinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { mergeRegister } from "@lexical/utils";
import { ArrowDown, ArrowUp, Bold, Code, IndentDecrease, IndentIncrease, Italic, Link2, Redo2, Strikethrough, Undo2 } from "lucide-react";
import { safeLinkUrl } from "@/lib/editor-markdown.mjs";
import { BLOCK_OPTIONS, changeBlock, moveSelectedBlock, type BlockKind } from "./editor-actions";

const buttonClass = "inline-flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-30";

export function EditorToolbar({ disabled }: { disabled: boolean }) {
  const [editor] = useLexicalComposerContext();
  const [undo, setUndo] = useState(false);
  const [redo, setRedo] = useState(false);
  const [formats, setFormats] = useState({ bold: false, italic: false, strikethrough: false, code: false });
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [linkError, setLinkError] = useState("");
  const savedSelection = useRef<BaseSelection | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);

  useEffect(() => mergeRegister(
    editor.registerCommand(CAN_UNDO_COMMAND, (value) => { setUndo(value); return false; }, COMMAND_PRIORITY_LOW),
    editor.registerCommand(CAN_REDO_COMMAND, (value) => { setRedo(value); return false; }, COMMAND_PRIORITY_LOW),
    editor.registerUpdateListener(({ editorState }) => editorState.read(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) setFormats({ bold: selection.hasFormat("bold"), italic: selection.hasFormat("italic"), strikethrough: selection.hasFormat("strikethrough"), code: selection.hasFormat("code") });
    })),
  ), [editor]);

  useEffect(() => { if (linkOpen) linkInput.current?.focus(); }, [linkOpen]);

  function canMutate() { return !disabled && editor.isEditable(); }

  function dispatch<T>(command: LexicalCommand<T>, payload: T) {
    if (canMutate()) editor.dispatchCommand(command, payload);
  }

  function openLink() {
    if (!canMutate()) return;
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      savedSelection.current = selection?.clone() ?? null;
      const node = $isRangeSelection(selection) ? selection.anchor.getNode() : null;
      const link = $isLinkNode(node) ? node : node?.getParent();
      setUrl($isLinkNode(link) ? link.getURL() : "");
    });
    setLinkError(""); setLinkOpen(true);
  }

  function applyLink(remove = false) {
    // A link form can remain open while its parent saves. Guard the handler too:
    // Enter or an already queued submit must not change a frozen editor draft.
    if (!canMutate()) return;
    if (!remove && !safeLinkUrl(url)) { setLinkError("Use a web address, email link or page reference."); return; }
    editor.update(() => {
      $setSelection(savedSelection.current?.clone() ?? null);
      editor.dispatchCommand(TOGGLE_LINK_COMMAND, remove ? null : url);
    });
    setLinkOpen(false); editor.focus();
  }

  return <>
    <div role="toolbar" aria-label="Text formatting" className="flex flex-wrap items-center gap-0.5 border-b border-border/60 px-3 py-2">
      <select aria-label="Block style" disabled={disabled} defaultValue="paragraph" onChange={(event) => { if (!canMutate()) return; changeBlock(editor, event.target.value as BlockKind); event.target.value = "paragraph"; editor.focus(); }} className="mr-2 h-8 max-w-36 rounded-md border border-border bg-surface px-2 text-xs text-foreground disabled:opacity-40">
        {BLOCK_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      {([
        ["bold", "Bold", Bold], ["italic", "Italic", Italic], ["strikethrough", "Strikethrough", Strikethrough], ["code", "Inline code", Code],
      ] as const).map(([format, label, Icon]) => <button key={format} type="button" title={label} aria-label={label} aria-pressed={formats[format]} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => dispatch(FORMAT_TEXT_COMMAND, format)} className={`${buttonClass} ${formats[format] ? "bg-brand/10 text-brand" : ""}`}><Icon className="size-4" /></button>)}
      <button type="button" title="Add or edit link" aria-label="Add or edit link" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={openLink} className={buttonClass}><Link2 className="size-4" /></button>
      <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
      <button type="button" title="Indent" aria-label="Indent" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => dispatch(INDENT_CONTENT_COMMAND, undefined)} className={buttonClass}><IndentIncrease className="size-4" /></button>
      <button type="button" title="Outdent" aria-label="Outdent" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => dispatch(OUTDENT_CONTENT_COMMAND, undefined)} className={buttonClass}><IndentDecrease className="size-4" /></button>
      <button type="button" title="Move block up" aria-label="Move block up" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => { if (canMutate()) moveSelectedBlock(editor, "up"); }} className={buttonClass}><ArrowUp className="size-4" /></button>
      <button type="button" title="Move block down" aria-label="Move block down" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => { if (canMutate()) moveSelectedBlock(editor, "down"); }} className={buttonClass}><ArrowDown className="size-4" /></button>
      <span className="flex-1" />
      <button type="button" title="Undo" aria-label="Undo" disabled={disabled || !undo} onMouseDown={(event) => event.preventDefault()} onClick={() => dispatch(UNDO_COMMAND, undefined)} className={buttonClass}><Undo2 className="size-4" /></button>
      <button type="button" title="Redo" aria-label="Redo" disabled={disabled || !redo} onMouseDown={(event) => event.preventDefault()} onClick={() => dispatch(REDO_COMMAND, undefined)} className={buttonClass}><Redo2 className="size-4" /></button>
    </div>
    {linkOpen && <form aria-label="Edit link" aria-disabled={disabled} onSubmit={(event) => { event.preventDefault(); applyLink(); }} className="border-b border-border bg-surface/70 p-3" onKeyDown={(event) => { if (event.key === "Escape" && !disabled) { setLinkOpen(false); editor.focus(); } }}>
      <label className="block text-xs font-medium" htmlFor="editor-link-url">Link URL</label>
      <div className="mt-1 flex flex-wrap gap-2">
        <input ref={linkInput} id="editor-link-url" type="text" value={url} disabled={disabled} onChange={(event) => setUrl(event.target.value)} placeholder="https://" className="min-w-40 flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm disabled:opacity-40" />
        <button type="submit" disabled={disabled} className="rounded-md bg-brand px-3 py-1.5 text-xs text-brand-foreground disabled:opacity-40">Apply link</button>
        <button type="button" disabled={disabled} onClick={() => applyLink(true)} className="px-2 text-xs disabled:opacity-40">Remove link</button>
        <button type="button" disabled={disabled} onClick={() => { setLinkOpen(false); editor.focus(); }} className="px-2 text-xs disabled:opacity-40">Cancel</button>
      </div>
      {linkError && <p role="alert" className="mt-2 text-xs text-red-600">{linkError}</p>}
    </form>}
  </>;
}
