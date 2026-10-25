import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';

function parsedUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  try {
    if (text.startsWith('//')) return new URL(`https:${text}`);
    if (/^[a-z][a-z\d+.-]*:/i.test(text)) return new URL(text);
    if (/^[\w.-]+(?::\d+)?(?:[/?#]|$)/.test(text)) return new URL(`https://${text}`);
  } catch { /* A malformed address is not a page reference. */ }
  return null;
}

/** Browser-safe policy shared by the rich editor and formatted reader. */
export function isNotionUrl(value) {
  const url = parsedUrl(value);
  if (!url) return false;
  if (['notion:', 'notion-file-block:'].includes(url.protocol)) return true;
  return /(?:^|\.)(?:notion\.so|notion\.com|notion\.site)$/.test(url.hostname.toLowerCase().replace(/\.$/, ''));
}

function normalizedId(value) {
  if (typeof value !== 'string') return null;
  const id = value.replace(/^source-/, '').replaceAll('-', '').toLowerCase();
  return /^[a-f\d]{32}$/.test(id) ? id : null;
}

/** Resolve IDs from imported Notion pages; never infer unrelated URL redirects. */
function notionPageId(value) {
  const url = parsedUrl(value);
  if (!url || !isNotionUrl(value) || !['http:', 'https:'].includes(url.protocol)) return null;
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
  const match = pathname.match(/([a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\/?$/i);
  return match ? normalizedId(match[1]) : null;
}

function internalPageId(value) {
  if (typeof value !== 'string' || !value.startsWith('/context?')) return null;
  const document = new URL(value, 'https://workspace.invalid').searchParams.get('document');
  return document?.startsWith('source-') ? normalizedId(document) : null;
}

function pageIndex(pages) {
  const result = new Map();
  for (const page of pages || []) {
    const id = normalizedId(typeof page === 'string' ? page : page?.id);
    if (id) result.set(id, { id, title: typeof page?.title === 'string' ? page.title : '' });
  }
  return result;
}

function markdownText(value) { return String(value).replace(/([\\`*_[\]<>])/g, '\\$1'); }
function titleSuffix(value) { return value ? ` "${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : ''; }
function unlinkedAutolink(value) {
  // GFM also autolinks entity-encoded and backslash-escaped URL text. A literal
  // keeps an unlabeled address readable without creating another destination.
  const fence = '`'.repeat(Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length)) + 1);
  return `${fence}${/^[` ]|[` ]$/.test(value) ? ` ${value} ` : value}${fence}`;
}

/**
 * EVIDENCE: mdast-util-from-markdown exposes source offsets; its GFM autolink
 * extension recognizes the same bare links as the reader. Replace only parsed
 * reference spans so unrelated bytes, line endings and literal code stay exact.
 * This pure helper does not read or write canonical user documents.
 * @param {string} markdown
 * @param {Iterable<string|{id:string,title?:string}>} [pages]
 * @returns {string}
 */
export function normalizeWorkspaceLinks(markdown, pages = []) {
  if (typeof markdown !== 'string') throw new TypeError('Workspace Markdown must be a string.');
  const known = pageIndex(pages);
  return normalize(markdown, known);
}

function normalize(markdown, known) {
  const autolinks = gfmAutolinkLiteralFromMarkdown();
  // The extension's fallback text transform creates positionless nodes after
  // decoding escapes. Keep its tokenizer, which retains source offsets. The
  // runtime URL policy also blocks references deliberately spelled as escapes.
  const tree = fromMarkdown(markdown, { extensions: [gfmAutolinkLiteral()], mdastExtensions: [{ ...autolinks, transforms: [] }] });
  const definitions = new Map();
  function collect(node) {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    for (const child of node.children || []) collect(child);
  }
  collect(tree);

  function range(node) { return [node.position.start.offset, node.position.end.offset]; }
  function original(node) { const [start, end] = range(node); return markdown.slice(start, end); }
  function withChildren(node, start = node.position.start.offset, end = node.position.end.offset) {
    let cursor = start;
    let result = '';
    for (const child of node.children || []) {
      const [childStart, childEnd] = range(child);
      result += markdown.slice(cursor, childStart) + render(child);
      cursor = childEnd;
    }
    return result + markdown.slice(cursor, end);
  }
  function caption(node) {
    if (node.type === 'image' || node.type === 'imageReference') return markdownText(node.alt || '');
    if (!node.children?.length) return '';
    return withChildren(node, node.children[0].position.start.offset, node.children.at(-1).position.end.offset);
  }
  function render(node) {
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') return original(node);
    if (node.type === 'definition') return isNotionUrl(node.url) ? '' : original(node);
    const reference = node.type === 'linkReference' || node.type === 'imageReference' ? definitions.get(node.identifier) : null;
    const destination = reference?.url || node.url;
    if (!['link', 'image', 'linkReference', 'imageReference'].includes(node.type)) return withChildren(node);
    const plainLabel = node.children?.length === 1 && node.children[0].type === 'text' ? node.children[0].value : null;
    if (!isNotionUrl(destination)) {
      const internalPage = known.get(internalPageId(destination));
      if (internalPage?.title && notionPageId(plainLabel) === internalPage.id) return `[${markdownText(internalPage.title)}](${destination}${titleSuffix(node.title || reference?.title)})`;
      return withChildren(node);
    }

    const text = caption(node);
    // Earlier imports used the containing page as a private-media fallback.
    // Those labels must not become a misleading link back to the same page.
    if (/\s*\(view in Notion\)\s*$/i.test(text)) return normalize(text.replace(/\s*\(view in Notion\)\s*$/i, ''), known);
    const imported = known.get(notionPageId(destination));
    const explicitLabel = /^!?\[/.test(original(node));
    if (!imported) return explicitLabel ? normalize(text, known) : unlinkedAutolink(node.children?.[0]?.value || node.alt || destination);
    const rawPageUrlLabel = explicitLabel && notionPageId(plainLabel) === imported.id;
    const displayed = imported.title && (!explicitLabel || rawPageUrlLabel) ? markdownText(imported.title) : text;
    return `[${displayed}](/context?document=source-${imported.id}${titleSuffix(node.title || reference?.title)})`;
  }
  return render(tree);
}

/** Remove obsolete external-navigation instructions from generated import notes. */
export function neutralizeImportNotes(notes = []) {
  return [...new Set(notes.map((note) => {
    if (note === 'Private or unavailable images are linked to their original Notion page.') return 'Some images were unavailable during import; their captions are preserved.';
    if (note === 'The generated table of contents or breadcrumb remains available in Notion.') return 'The generated table of contents or breadcrumb was omitted; page content is preserved.';
    if (note === 'Unclosed source markup was preserved; check the original source.') return 'Unclosed source markup is preserved as visible text.';
    const unsupported = note.match(/^The (.+) block is available through its original source link\.$/);
    if (unsupported) return `The ${unsupported[1]} block retains its source label.`;
    return note;
  }))];
}
