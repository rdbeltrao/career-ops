import { $createParagraphNode, $createTextNode, $getSelection, $isRangeSelection, type LexicalEditor } from "lexical";
import { $createHeadingNode, $createQuoteNode } from "@lexical/rich-text";
import { $createCodeNode } from "@lexical/code";
import { $setBlocksType } from "@lexical/selection";
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, REMOVE_LIST_COMMAND } from "@lexical/list";

export const BLOCK_OPTIONS = [
  { id: "paragraph", label: "Text", description: "Plain paragraph" },
  { id: "h1", label: "Heading 1", description: "Large section heading" },
  { id: "h2", label: "Heading 2", description: "Section heading" },
  { id: "h3", label: "Heading 3", description: "Small section heading" },
  { id: "bullet", label: "Bulleted list", description: "An unordered list" },
  { id: "number", label: "Numbered list", description: "An ordered list" },
  { id: "quote", label: "Quote", description: "A quoted source" },
  { id: "callout", label: "Callout", description: "A note or reminder" },
  { id: "code", label: "Code block", description: "Preserve literal text" },
] as const;

export type BlockKind = typeof BLOCK_OPTIONS[number]["id"];

export function changeBlock(editor: LexicalEditor, kind: BlockKind) {
  if (kind === "bullet" || kind === "number") {
    editor.dispatchCommand(kind === "bullet" ? INSERT_UNORDERED_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND, undefined);
    return;
  }
  editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    $setBlocksType(selection, () => {
      if (kind === "h1" || kind === "h2" || kind === "h3") return $createHeadingNode(kind);
      if (kind === "quote" || kind === "callout") return $createQuoteNode();
      if (kind === "code") return $createCodeNode();
      return $createParagraphNode();
    });
    if (kind === "callout") {
      const block = selection.anchor.getNode().getTopLevelElement();
      if (block && !block.getTextContent().startsWith("[!NOTE]")) {
        const first = block.getFirstChild();
        const marker = $createTextNode("[!NOTE] ");
        if (first) first.insertBefore(marker); else block.append(marker);
      }
    }
  });
}

export function moveSelectedBlock(editor: LexicalEditor, direction: "up" | "down") {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    const block = selection.anchor.getNode().getTopLevelElement();
    if (!block) return;
    const sibling = direction === "up" ? block.getPreviousSibling() : block.getNextSibling();
    if (!sibling) return;
    if (direction === "up") sibling.insertBefore(block); else sibling.insertAfter(block);
  });
}
