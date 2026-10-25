"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LexicalTypeaheadMenuPlugin, MenuOption, useBasicTypeaheadTriggerMatch } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { DraggableBlockPlugin_EXPERIMENTAL } from "@lexical/react/LexicalDraggableBlockPlugin";
import { COMMAND_PRIORITY_LOW, KEY_DOWN_COMMAND } from "lexical";
import { GripVertical } from "lucide-react";
import { $removeSlashQuery } from "@/lib/editor-markdown.mjs";
import { BLOCK_OPTIONS, changeBlock, moveSelectedBlock, type BlockKind } from "./editor-actions";

class BlockOption extends MenuOption {
  kind: BlockKind;
  label: string;
  description: string;
  constructor(option: typeof BLOCK_OPTIONS[number]) {
    super(option.id); this.kind = option.id; this.label = option.label; this.description = option.description;
  }
}

export function SlashMenuPlugin() {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const trigger = useBasicTypeaheadTriggerMatch("/", { minLength: 0 });
  const options = useMemo(() => BLOCK_OPTIONS.filter((option) => `${option.label} ${option.description}`.toLowerCase().includes((query ?? "").toLowerCase())).map((option) => new BlockOption(option)), [query]);

  // EVIDENCE: Lexical's typeahead plugin owns arrow/Enter/Escape behavior and
  // preserves the text selection while its menu is open.
  return <LexicalTypeaheadMenuPlugin<BlockOption>
    onQueryChange={setQuery}
    triggerFn={trigger}
    options={options}
    onSelectOption={(option, _textNode, closeMenu) => {
      editor.update(() => {
        // EVIDENCE: LexicalMenu splits using a React-transition match snapshot.
        // Fast input can leave that snapshot behind the live caret, so removing
        // only its supplied node leaves part of /heading in the document.
        if (editor.isEditable() && $removeSlashQuery()) changeBlock(editor, option.kind);
        closeMenu();
      });
    }}
    menuRenderFn={(anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) => anchorRef.current && options.length ? createPortal(
      <ul role="listbox" aria-label="Insert block" className="z-50 max-h-72 w-64 overflow-auto rounded-xl border border-border bg-surface p-1.5 shadow-xl">
        {options.map((option, index) => <li key={option.key} ref={option.setRefElement} role="option" aria-selected={selectedIndex === index} id={`typeahead-item-${index}`} onMouseEnter={() => setHighlightedIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => selectOptionAndCleanUp(option)} className={`cursor-pointer rounded-lg px-3 py-2 ${selectedIndex === index ? "bg-brand/10 text-foreground" : "text-muted hover:bg-surface"}`}>
          <span className="block text-sm font-medium">{option.label}</span><span className="block text-xs text-muted">{option.description}</span>
        </li>)}
      </ul>, anchorRef.current,
    ) : null}
  />;
}

export function BlockMovePlugin({ anchor }: { anchor: HTMLElement }) {
  const [editor] = useLexicalComposerContext();
  const menuRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);

  useEffect(() => editor.registerCommand(KEY_DOWN_COMMAND, (event) => {
    if (!editor.isEditable() || !event.altKey || !event.shiftKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return false;
    event.preventDefault(); moveSelectedBlock(editor, event.key === "ArrowUp" ? "up" : "down"); return true;
  }, COMMAND_PRIORITY_LOW), [editor]);

  return <DraggableBlockPlugin_EXPERIMENTAL
    anchorElem={anchor}
    menuRef={menuRef}
    targetLineRef={lineRef}
    isOnMenu={(element) => menuRef.current?.contains(element) ?? false}
    menuComponent={<div ref={menuRef} title="Drag to move block. Keyboard: Alt+Shift+Up or Down." aria-hidden="true" className="pointer-events-auto absolute left-0 top-0 z-20 -mt-0.5 flex size-7 cursor-grab items-center justify-center rounded-md text-muted opacity-0 hover:bg-surface active:cursor-grabbing"><GripVertical className="size-4" /></div>}
    targetLineComponent={<div ref={lineRef} className="pointer-events-none absolute left-0 top-0 z-20 h-0.5 bg-brand opacity-0" />}
  />;
}

export function EditablePlugin({ disabled }: { disabled: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.setEditable(!disabled), [editor, disabled]);
  return null;
}
