import { fromMarkdown } from 'mdast-util-from-markdown';

const UUID = /^[a-f0-9]{32}$/;
const MAX_BODY_BYTES = 200_000;
const MAX_MANIFEST_BYTES = 1_000_000;
const VOID_TAGS = new Set(['br', 'hr', 'col', 'img', 'empty-block', 'table_of_contents', 'table-of-contents', 'breadcrumb', 'mention-date', 'date', 'unknown', 'custom-block']);

function idOf(value) {
  if (typeof value !== 'string' || !/^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(value)) throw new Error('Invalid source page ID.');
  return value.replaceAll('-', '').toLowerCase();
}

function decode(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (original, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? original;
    const point = Number.parseInt(entity.slice(entity[1]?.toLowerCase() === 'x' ? 2 : 1), entity[1]?.toLowerCase() === 'x' ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : original;
  });
}

function escapeHtml(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function label(value) { return decode(value).trim().replace(/\s*\n\s*/g, ' ').replace(/([\\[\]])/g, '\\$1'); }
function dedent(value) {
  const lines = value.replace(/^\n|\n[\t ]*$/g, '').split('\n');
  const widths = lines.filter((line) => line.trim()).map((line) => line.match(/^[\t ]*/)[0].length);
  const width = widths.length ? Math.min(...widths) : 0;
  return lines.map((line) => line.slice(Math.min(width, line.match(/^[\t ]*/)[0].length))).join('\n');
}

function safeUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  const decoded = decode(value);
  if (/[\u0000-\u0020\u007f\\]/.test(decoded)) return null;
  if (/^(?:https?:|mailto:)/i.test(decoded)) {
    try { const parsed = new URL(decoded); return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? decoded.replaceAll('(', '%28').replaceAll(')', '%29').replaceAll('<', '%3C').replaceAll('>', '%3E') : null; } catch { return null; }
  }
  if (/^(?:\/[^/]|#|\.\/|\.\.\/)/.test(decoded) && !decoded.includes('://')) return decoded;
  return null;
}

function notionId(url) {
  try {
    const parsed = new URL(url);
    if (!/(?:^|\.)(?:notion\.so|notion\.com|notion\.site)$/.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/([a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\/?$/i);
    return match ? idOf(match[1]) : null;
  } catch { return null; }
}

/** Preserve literal code before interpreting the XML-like Notion wrappers. */
function protectCode(source) {
  let marker = '\uE000NOTION_LITERAL_';
  while (source.includes(marker)) marker += '_';
  const literals = [];
  const restore = (text) => text.replace(new RegExp(`${marker}(\\d+)\uE001`, 'g'), (_, index, offset) => {
    const literal = literals[Number(index)];
    const before = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset);
    const prefix = before.match(/^([\t >]*)(?:([-+*]|\d+[.)])([\t ]+))?$/);
    const continuation = prefix ? `${prefix[1]}${prefix[2] ? ' '.repeat(prefix[2].length + prefix[3].length) : ''}` : '';
    return continuation ? literal.replaceAll('\n', `\n${continuation}`) : literal;
  });
  // Generated links may contain an already protected code caption. Resolve it
  // before storing the outer literal so restoration never leaves nested tokens.
  const hold = (text) => `${marker}${literals.push(restore(text)) - 1}\uE001`;
  const lines = source.split('\n');
  const protectedLines = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^[\t ]*(`{3,}|~{3,})/);
    if (!fence) { protectedLines.push(lines[i]); continue; }
    const indentation = lines[i].match(/^[\t ]*/)[0];
    const collected = [lines[i]];
    const closing = new RegExp(`^[\\t ]*${fence[1][0]}{${fence[1].length},}\\s*$`);
    while (++i < lines.length) { collected.push(lines[i]); if (closing.test(lines[i])) break; }
    protectedLines.push(indentation + hold(collected.map((line) => line.startsWith(indentation) ? line.slice(indentation.length) : line).join('\n')));
  }
  const text = protectedLines.join('\n').replace(/<code(?:\s[^>]*)?>([\s\S]*?)<\/code>/gi, (_, code) => {
    const literal = decode(code);
    const longest = Math.max(0, ...[...literal.matchAll(/`+/g)].map((match) => match[0].length));
    if (literal.includes('\n')) {
      const fence = '`'.repeat(Math.max(3, longest + 1));
      return hold(`${fence}\n${literal}\n${fence}`);
    }
    const fence = '`'.repeat(longest + 1);
    return hold(`${fence}${/^[` ]|[` ]$/.test(literal) ? ` ${literal} ` : literal}${fence}`);
  }).replace(/(`+)([^`]|(?!\1)`)*?\1/g, hold);
  return { text, hold, restore };
}

function attributes(raw) {
  const result = {};
  for (const match of raw.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) result[match[1].toLowerCase()] = decode(match[2] ?? match[3]);
  return result;
}

/**
 * EVIDENCE: notion://docs/enhanced-markdown-spec defines XML-like block wrappers
 * mixed with Markdown. A small token tree handles nested wrappers without using
 * an HTML renderer or executing source attributes. Originals are archived whole.
 */
function tokenTree(source, warnings) {
  const root = { tag: 'root', children: [] };
  const stack = [root];
  const pattern = /<!--[\s\S]*?-->|<\/?[a-z][\w:-]*(?=\s|\/?>)(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let end = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > end) stack.at(-1).children.push(source.slice(end, match.index));
    const raw = match[0];
    end = match.index + raw.length;
    if (raw.startsWith('<!--')) { stack.at(-1).children.push({ tag: 'comment', raw, children: [] }); continue; }
    const tag = raw.match(/^<\/?([\w:-]+)/)[1].toLowerCase();
    if (raw.startsWith('</')) {
      if (stack.at(-1).tag === tag) { stack.at(-1).close = raw; stack.pop(); }
      else { warnings.add(`Unmatched ${tag} closing markup was preserved as text.`); stack.at(-1).children.push(escapeHtml(raw)); }
      continue;
    }
    const node = { tag, raw, attrs: attributes(raw), children: [], close: '' };
    stack.at(-1).children.push(node);
    if (!/\/\s*>$/.test(raw) && !VOID_TAGS.has(tag)) stack.push(node);
  }
  if (end < source.length) stack.at(-1).children.push(source.slice(end));
  if (stack.length > 1) warnings.add('Unclosed source markup was preserved; check the original source.');
  return root;
}

function contentOf(page) {
  if (typeof page.text !== 'string') throw new Error('A fetched source page is missing its content.');
  const start = page.text.indexOf('<content>');
  const end = page.text.lastIndexOf('</content>');
  if (start < 0 || end < start || !/<\/page>\s*$/.test(page.text)) throw new Error('A fetched source page has no complete content wrapper.');
  return page.text.slice(start + '<content>'.length, end);
}

function convertPage(page, knownIds) {
  const warnings = new Set();
  const protectedCode = protectCode(contentOf(page));
  const tree = tokenTree(protectedCode.text, warnings);
  const destination = (value) => {
    const safe = safeUrl(value);
    if (!safe) { warnings.add('An unsafe or unavailable URL was retained only in the original source archive.'); return null; }
    const id = notionId(safe);
    return id && knownIds.has(id) ? `/context?document=source-${id}` : safe;
  };
  const linked = (text, url, image = false) => {
    const dest = destination(url);
    return dest ? `${image ? '!' : ''}[${label(text)}](${dest})` : label(text);
  };
  // An unavailable attachment must open the actual source, not loop back to the
  // imported page through the ordinary internal page-link rewrite.
  const originalLink = (text) => protectedCode.hold(`[${label(text)}](${safeUrl(page.url)})`);
  const children = (node) => node.children.map(render).join('');
  const originalMarkup = (node) => typeof node === 'string' ? node : `${node.raw || ''}${node.children.map(originalMarkup).join('')}${node.close || ''}`;
  const block = (text) => `\n\n${dedent(text).trim()}\n\n`;
  const emphasized = (text, marker) => {
    const [, before, content, after] = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return content ? `${before}${marker}${content}${marker}${after}` : text;
  };
  function render(node) {
    if (typeof node === 'string') return node;
    const inner = () => children(node);
    switch (node.tag) {
      case 'root': return inner();
      case 'b': case 'strong': return emphasized(inner(), '**');
      case 'i': case 'em': return emphasized(inner(), '*');
      case 's': case 'del': case 'strike': return emphasized(inner(), '~~');
      case 'span': case 'u': return inner();
      case 'br': return '  \n';
      case 'p': return block(inner());
      case 'empty-block': return '\n\n';
      case 'hr': return '\n\n---\n\n';
      case 'page': case 'folder': return block(linked(inner() || 'Source page', node.attrs.url));
      case 'mention': case 'mention-page': case 'mention-database': case 'mention-data-source': case 'mention-user': case 'mention-agent': return linked(inner() || node.attrs.url || 'Source reference', node.attrs.url);
      case 'mention-date': case 'date': return [node.attrs.start, node.attrs.starttime, node.attrs.end ? '–' : null, node.attrs.end, node.attrs.endtime, node.attrs.timezone].filter(Boolean).join(' ');
      case 'a': return linked(inner(), node.attrs.href);
      case 'callout': {
        const icon = node.attrs.icon && !node.attrs.icon.startsWith('icons/') ? `${label(node.attrs.icon)} ` : '';
        return block(`${icon}${dedent(inner()).trim()}`.split('\n').map((line) => line ? `> ${line}` : '>').join('\n'));
      }
      case 'details': warnings.add('Toggle sections are expanded in the local copy.'); return block(inner());
      case 'toggle': {
        warnings.add('Toggle sections are expanded in the local copy.');
        const [title, ...rest] = dedent(inner()).trim().split('\n');
        const heading = /^h[1-6]$/.test(node.attrs.heading || '') ? `${'#'.repeat(Number(node.attrs.heading[1]))} ${title}` : `**${title}**`;
        return block(`${heading}\n\n${rest.join('\n').trim()}`);
      }
      case 'summary': return block(`**${inner().trim()}**`);
      case 'ul': case 'ol': {
        if (node.children.some((child) => typeof child === 'string' ? child.trim() : child.tag !== 'li')) {
          warnings.add('An unexpected list structure was preserved as visible source text.');
          return block(escapeHtml(originalMarkup(node)));
        }
        const items = node.children.filter((child) => typeof child !== 'string' && child.tag === 'li');
        const lines = items.map((item, index) => {
          const marker = node.tag === 'ul' ? '- ' : `${index + 1}. `;
          return dedent(children(item)).trim().split('\n').map((line, lineIndex) => lineIndex === 0 ? `${marker}${line}` : line ? `${' '.repeat(marker.length)}${line}` : '').join('\n');
        });
        return block(lines.join('\n'));
      }
      case 'li': return block(inner());
      case 'columns': warnings.add('Columns are shown in source reading order.'); return block(inner());
      case 'column': case 'tabs': return block(inner());
      case 'tab': warnings.add('Tabs are expanded in source order.'); return block(inner());
      case 'table': {
        if (node.children.some((child) => typeof child === 'string' ? child.trim() : !['tr', 'colgroup', 'col'].includes(child.tag)) || node.children.some((child) => typeof child !== 'string' && child.tag === 'tr' && child.children.some((cell) => typeof cell === 'string' ? cell.trim() : !['td', 'th'].includes(cell.tag)))) {
          warnings.add('An unexpected table structure was preserved as visible source text.');
          return block(escapeHtml(originalMarkup(node)));
        }
        const rows = node.children.filter((child) => typeof child !== 'string' && child.tag === 'tr').map((row) => row.children.filter((cell) => typeof cell !== 'string' && ['td', 'th'].includes(cell.tag)).map((cell) => children(cell).trim().replace(/\s*\n\s*/g, '; ').replace(/(?<!\\)\|/g, '\\|')));
        if (!rows.length) { warnings.add('An empty or unsupported table was preserved as source text.'); return escapeHtml(node.raw) + inner() + escapeHtml(node.close); }
        const width = Math.max(...rows.map((row) => row.length));
        const line = (row) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ')} |`;
        const header = node.attrs['header-row'] === 'true' ? rows.shift() : [];
        return block([line(header), line(Array(width).fill('---')), ...rows.map(line)].join('\n'));
      }
      case 'colgroup': case 'col': return '';
      case 'tr': case 'td': case 'th': return inner();
      case 'image': case 'img': {
        const caption = inner() || node.attrs.alt || 'Image';
        const source = node.attrs.src || node.attrs.source;
        if (safeUrl(source)) return linked(caption, source, true);
        warnings.add('Private or unavailable images are linked to their original Notion page.');
        return block(originalLink(`Image: ${caption.trim()} (view in Notion)`));
      }
      case 'audio': case 'video': case 'pdf': case 'file': case 'embed': case 'bookmark': {
        warnings.add('Media and embedded content are linked to the original resource.');
        const caption = inner() || (node.tag === 'pdf' ? 'PDF' : node.tag[0].toUpperCase() + node.tag.slice(1));
        const source = node.attrs.src || node.attrs.url || node.attrs.href || node.attrs.source;
        if (safeUrl(source)) return block(linked(caption, source));
        warnings.add('An unsafe or unavailable URL was retained only in the original source archive.');
        return block(originalLink(`${caption.trim()} (view in Notion)`));
      }
      case 'table_of_contents': case 'table-of-contents': case 'breadcrumb': warnings.add('The generated table of contents or breadcrumb remains available in Notion.'); return '';
      case 'synced_block': return block(inner());
      case 'synced_block_reference': return block(inner().trim() || linked(node.attrs.notice || 'Synced source block', node.attrs.url));
      case 'meeting-notes': case 'notes': case 'transcript': return block(inner());
      case 'unknown': case 'custom-block': case 'database': {
        warnings.add(`The ${node.tag} block is available through its original source link.`);
        return block(linked(inner() || node.attrs.alt || 'Source block', node.attrs.url || node.attrs['data-source-url']));
      }
      default: warnings.add(`Unsupported ${node.tag} markup was preserved as visible text.`); return `${escapeHtml(node.raw)}${inner()}${escapeHtml(node.close || '')}`;
    }
  }

  let markdown = render(tree).replace(/\s*\{(?:(?:color|toggle)="[^"]*"\s*)+\}/g, '').replace(/\n[\t ]+\n/g, '\n\n').replace(/\n{3,}/g, '\n\n').trim();
  // Notion indentation belongs to removed containers; do not expose it as code.
  markdown = markdown.replace(/^\t+/gm, (tabs) => '  '.repeat(tabs.length));
  const replacements = [];
  function inspect(node) {
    if (['link', 'image', 'definition'].includes(node.type)) {
      const dest = destination(node.url);
      if (dest !== node.url) {
        const start = node.position.start.offset;
        const end = node.position.end.offset;
        const original = markdown.slice(start, end);
        if (node.type === 'definition') replacements.push({ start, end, value: dest ? `[${node.label || node.identifier}]: ${dest}${node.title ? ` "${node.title.replaceAll('"', '&quot;')}"` : ''}` : `[${node.label || node.identifier}]: #` });
        else {
          const split = original.lastIndexOf('](');
          const caption = split >= 0 ? original.slice(node.type === 'image' ? 2 : 1, split) : node.alt || node.children?.map((child) => child.value || '').join('') || '';
          replacements.push({ start, end, value: dest ? `${node.type === 'image' ? '!' : ''}[${caption}](${dest}${node.title ? ` "${node.title.replaceAll('"', '&quot;')}"` : ''})` : caption });
        }
      }
    } else for (const child of node.children || []) inspect(child);
  }
  inspect(fromMarkdown(markdown));
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) markdown = markdown.slice(0, replacement.start) + replacement.value + markdown.slice(replacement.end);
  return { content: `${protectedCode.restore(markdown)}\n`, warnings: [...warnings] };
}

/**
 * Pure import plan. The caller must write these files only into a new directory;
 * this function never reads or writes user files and never changes canonical CV
 * facts. Source pages remain a separate library with immutable original copies.
 * @param {unknown} input
 */
export function planImport(input) {
  if (!input || typeof input !== 'object' || input.version !== 1 || !Array.isArray(input.pages) || !input.pages.length || input.pages.length > 5000) throw new Error('Invalid source workspace export.');
  const rootId = idOf(input.rootId);
  const pages = input.pages.map((original) => {
    if (!original || typeof original !== 'object') throw new Error('Invalid source page.');
    if (original.truncated || original.unknown_block_count > 0 || original.unknown_block_ids?.length) throw new Error('A source page is incomplete or contains unknown blocks. Fetch the complete source before importing.');
    const id = idOf(original.id);
    const parentId = original.parentId === null ? null : idOf(original.parentId);
    if (typeof original.title !== 'string' || !original.title.trim() || original.title.length > 300 || /[\u0000-\u001f\u007f]/.test(original.title)) throw new Error('Invalid source page title.');
    if (!Array.isArray(original.children)) throw new Error('A source page is missing its complete child page list.');
    const children = original.children.map(idOf);
    if (new Set(children).size !== children.length) throw new Error('Duplicate child page ID.');
    const sourceUrl = safeUrl(original.url);
    if (!sourceUrl || !/^https?:/.test(sourceUrl) || sourceUrl.length > 2048) throw new Error('Invalid source page URL.');
    if (typeof original.lastEditedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(original.lastEditedAt) || !Number.isFinite(Date.parse(original.lastEditedAt))) throw new Error('Invalid source page edit timestamp.');
    contentOf(original);
    return { id, parentId, children, title: original.title, sourceUrl, sourceEditedAt: original.lastEditedAt, original };
  });
  const byId = new Map(pages.map((page) => [page.id, page]));
  if (byId.size !== pages.length) throw new Error('Duplicate source page ID.');
  if (!byId.has(rootId) || byId.get(rootId).parentId !== null || pages.filter((page) => page.parentId === null).length !== 1) throw new Error('The source workspace needs exactly one root page.');
  for (const page of pages) {
    if (page.parentId && !byId.has(page.parentId)) throw new Error('A source page parent is missing.');
    if (page.parentId && !byId.get(page.parentId).children.includes(page.id)) throw new Error('A source page is absent from its parent child list.');
    for (const childId of page.children) {
      if (!byId.has(childId)) throw new Error('A child source page is missing or unfetched.');
      if (byId.get(childId).parentId !== page.id) throw new Error('A child source page has a mismatched parent.');
    }
  }
  const seen = new Set();
  const ordered = [];
  function visit(id, order = 0) {
    if (seen.has(id)) throw new Error('The source hierarchy contains a cycle.');
    seen.add(id);
    const page = byId.get(id);
    ordered.push({ id, title: page.title, parentId: page.parentId, order, sourceUrl: page.sourceUrl, sourceEditedAt: page.sourceEditedAt });
    page.children.forEach((childId, index) => visit(childId, index));
  }
  visit(rootId);
  if (seen.size !== pages.length) throw new Error('The source hierarchy contains unreachable pages.');
  const manifest = { version: 1, rootId, pages: ordered };
  const files = [];
  const warnings = [];
  for (const page of pages) {
    const converted = convertPage(page.original, seen);
    if (Buffer.byteLength(converted.content, 'utf8') > MAX_BODY_BYTES) throw new Error('A converted source page exceeds 200KB.');
    if (Buffer.from(converted.content, 'utf8').toString('utf8') !== converted.content) throw new Error('A converted source page contains invalid Unicode.');
    if (converted.warnings.length) {
      warnings.push({ id: page.id, warnings: converted.warnings });
      manifest.pages.find((record) => record.id === page.id).importNotes = converted.warnings;
    }
    files.push({ path: `pages/${page.id}.md`, content: converted.content });
    files.push({ path: `sources/${page.id}.json`, content: `${JSON.stringify(page.original, null, 2)}\n` });
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(manifestText, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('The source workspace manifest exceeds 1MB.');
  files.unshift({ path: 'index.json', content: manifestText });
  return { manifest, files, warnings };
}
