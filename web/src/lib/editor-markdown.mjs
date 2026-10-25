import { $createParagraphNode, $createRangeSelection, $getSelection, $isRangeSelection, $isTextNode, $setSelection, createEditor } from 'lexical';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListNode, ListItemNode } from '@lexical/list';
import { LinkNode } from '@lexical/link';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { $createHorizontalRuleNode, $isHorizontalRuleNode, HorizontalRuleNode } from '@lexical/extension';
import { $convertFromMarkdownString, $convertToMarkdownString, TRANSFORMERS } from '@lexical/markdown';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { isNotionUrl } from './workspace-links.mjs';

export const EDITOR_NODES = [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, CodeNode, CodeHighlightNode, HorizontalRuleNode];

// EVIDENCE: Lexical's element transformer contract supports additional block
// nodes. The semantic preflight below still checks setext headings and nested
// rules, so recognising a divider can never silently change its meaning.
/** @type {import('@lexical/markdown').ElementTransformer} */
const HORIZONTAL_RULE = {
  dependencies: [HorizontalRuleNode],
  export: (node) => $isHorizontalRuleNode(node) ? '---' : null,
  regExp: /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/,
  replace: (parent, children, _match, isImport) => {
    // Shortcuts match only the first text node. A following bold span/link is
    // still part of this paragraph, so it must never be replaced by a divider.
    if (children.some((child) => !$isTextNode(child) || child.getTextContentSize() > 0)) return false;
    const rule = $createHorizontalRuleNode();
    parent.replace(rule);
    if (!isImport) {
      const paragraph = $createParagraphNode();
      rule.insertAfter(paragraph);
      paragraph.select();
    }
  },
  type: 'element',
};

export const EDITOR_TRANSFORMERS = [HORIZONTAL_RULE, ...TRANSFORMERS];

/** Remove a slash query from the live selection, including a stale menu split. */
export function $removeSlashQuery() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.anchor.type !== 'text') return false;
  const endNode = selection.anchor.getNode();
  if (!$isTextNode(endNode)) return false;
  const endOffset = selection.anchor.offset;
  const nodes = [endNode];
  let prefix = endNode.getTextContent().slice(0, endOffset);
  let previous = endNode.getPreviousSibling();
  while ($isTextNode(previous)) {
    nodes.unshift(previous);
    prefix = previous.getTextContent() + prefix;
    previous = previous.getPreviousSibling();
  }
  const match = /(?:^|\s)(\/[a-z\d-]*)$/i.exec(prefix);
  if (!match) return false;
  let startOffset = prefix.length - match[1].length;
  let startNode = nodes[0];
  for (const node of nodes) {
    startNode = node;
    const length = node === endNode ? endOffset : node.getTextContentSize();
    if (startOffset < length) break;
    startOffset -= length;
  }
  const range = $createRangeSelection();
  range.setTextNodeRange(startNode, startOffset, endNode, endOffset);
  $setSelection(range);
  range.removeText();
  return true;
}

/** Only protocols that are useful in a career document may become active links. */
export function safeLinkUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  if (isNotionUrl(value)) return false;
  if (value.startsWith('#')) return true;
  if (value.startsWith('/')) return !value.startsWith('//');
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) return /^[\w.~/-]+(?:[?#][^\s]*)?$/.test(value);
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(value).protocol); }
  catch { return false; }
}

/** Preserve pasted content while removing destinations this workspace disallows. */
export function registerAllowedLinkTransform(editor) {
  // LinkPlugin validates link commands, but HTML paste imports LinkNodes
  // directly. Transforms run before rendering and before the change listener.
  return editor.registerNodeTransform(LinkNode, (node) => {
    if (safeLinkUrl(node.getURL())) return;
    for (const child of node.getChildren()) node.insertBefore(child);
    node.remove();
  });
}

/** EVIDENCE: Lexical supports rootless state operations; no DOM emulator is needed. */
export function roundTripMarkdown(markdown) {
  const editor = createEditor({ namespace: 'markdown-safety', nodes: EDITOR_NODES, onError: (error) => { throw error; } });
  editor.update(() => importMarkdown(markdown), { discrete: true });
  return editor.getEditorState().read(() => exportMarkdown());
}

// EVIDENCE: https://lexicaljs.org/docs/packages/lexical-markdown — use the same
// explicit transformers for preflight, initial state, shortcuts and every save.
export function importMarkdown(markdown) {
  $convertFromMarkdownString(markdown, EDITOR_TRANSFORMERS, undefined, false, true);
}

export function exportMarkdown() {
  return $convertToMarkdownString(EDITOR_TRANSFORMERS);
}

const supported = new Set(['root', 'paragraph', 'text', 'heading', 'emphasis', 'strong', 'inlineCode', 'code', 'blockquote', 'list', 'listItem', 'link', 'thematicBreak']);

function unsupportedNode(node, source) {
  if (!supported.has(node.type)) return node.type;
  if (node.type === 'link' && !safeLinkUrl(node.url)) return 'link destination';
  const spelling = source.slice(node.position?.start.offset, node.position?.end.offset);
  if (node.type === 'link' && !spelling.startsWith('[')) return 'autolink';
  if (node.type === 'code' && !/^ {0,3}`{3,}/.test(spelling)) return 'code spelling';
  for (const child of node.children ?? []) {
    const found = unsupportedNode(child, source);
    if (found) return found;
  }
  return null;
}

function semanticTree(node) {
  const result = {};
  for (const [key, value] of Object.entries(node)) {
    // Position and list spacing describe the spelling, not the document meaning.
    if (key === 'position' || key === 'spread') continue;
    if (key === 'children') result.children = value.map(semanticTree);
    else if (key === 'value' && node.type === 'text') result.value = value.replace(/\r?\n/g, ' ');
    else result[key] = value;
  }
  return result;
}

function outsideCode(source, tree) {
  const spans = [];
  function visit(node) {
    if (node.type === 'code') spans.push([node.position.start.offset, node.position.end.offset]);
    else for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  let result = source;
  for (const [start, end] of spans.reverse()) result = result.slice(0, start) + '\n' + result.slice(end);
  return result;
}

/**
 * Check whether rich editing can preserve this document. The original source is
 * always returned untouched, including on a failed import. This is deliberately
 * conservative: a formatted read view is preferable to a lost evidence link.
 * @param {string} source
 * @returns {{safe:boolean, equivalent:boolean, source:string, reason:string}}
 */
export function analyzeMarkdown(source) {
  const fallback = (reason) => ({ safe: false, equivalent: false, source, reason });
  try {
    const original = fromMarkdown(source);
    const unsupported = unsupportedNode(original, source);
    if (unsupported) return fallback('Choose Source to edit this page. Its original formatting is preserved.');
    const prose = outsideCode(source, original);
    // JUDGMENT: GFM tables/tasks, footnotes and definition lists are outside the
    // current transformer set. Detect them before CommonMark treats them as text.
    if (/^\s*\|?\s*:?-{3,}:?\s*\|/m.test(prose) ||
        /^\s*[-+*]\s+\[[ xX]\]/m.test(prose) ||
        /\[\^[^\]]+\]/.test(prose) || /^\s*:\s+\S/m.test(prose) ||
        /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);/i.test(prose)) {
      return fallback('Choose Source to edit this page. Its original formatting is preserved.');
    }
    const converted = fromMarkdown(roundTripMarkdown(source));
    if (JSON.stringify(semanticTree(original)) !== JSON.stringify(semanticTree(converted))) {
      return fallback('Choose Source to edit this page while keeping its original formatting intact.');
    }
    return { safe: true, equivalent: true, source, reason: '' };
  } catch {
    return fallback('This page is available to read. Choose Source to edit its original text.');
  }
}
