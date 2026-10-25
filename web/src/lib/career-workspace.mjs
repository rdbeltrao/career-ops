// EVIDENCE: web/AGENTS.md requires Markdown to stay authoritative. These source
// offsets let the UI expose pages without introducing another content store.

/** @typedef {{id:string,title:string,level:number,parentId:string|null,start:number,bodyStart:number,end:number}} WorkspaceSection */
/** @typedef {{action:string,section?:string|null,content?:string,title?:string,direction?:string,usage?:string}} WorkspaceMutation */

export class WorkspaceError extends Error {
  /** @param {string} message @param {string} code @param {number} [status] */
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.status = status;
  }
}

/**
 * A conservative ATX outline. Unsupported block syntax is still editable as a
 * whole document; section operations refuse to guess at its boundaries.
 * @param {string} markdown
 * @returns {{sections:WorkspaceSection[],warning:string|null}}
 */
export function inspectOutline(markdown) {
  /** @type {WorkspaceSection[]} */
  const sections = [];
  /** @type {WorkspaceSection[]} */
  const stack = [];
  const occurrences = new Map();
  let fence = null;
  let comment = false;
  let frontmatter = false;
  let warning = null;
  let previous = '';
  // JUDGMENT: refuse structural writes for HTML/Setext rather than implement a
  // second general Markdown parser. Whole-document/source editing remains safe.
  for (const match of markdown.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) continue;
    const start = match.index;
    const raw = match[0];
    const line = raw.replace(/\r?\n$/, '');
    if (line.includes('\r')) warning ??= 'The outline contains unsupported line endings.';
    if (start === 0 && line === '---') { frontmatter = true; continue; }
    if (frontmatter) { if (/^(---|\.\.\.)\s*$/.test(line)) frontmatter = false; continue; }
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.size) fence = null;
      continue;
    }
    if (comment) {
      if (line.includes('-->')) {
        comment = false;
        if (line.slice(line.indexOf('-->') + 3).trim()) warning ??= 'The outline contains inline HTML comments. Edit the complete document in source mode.';
      }
      continue;
    }
    if (line.includes('<!--')) {
      if (line.slice(0, line.indexOf('<!--')).trim() || (line.includes('-->') && line.slice(line.indexOf('-->') + 3).trim())) {
        warning ??= 'The outline contains inline HTML comments. Edit the complete document in source mode.';
      }
      comment = !line.slice(line.indexOf('<!--') + 4).includes('-->');
      previous = '';
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], size: open[1].length };
      previous = '';
      continue;
    }
    // EVIDENCE: https://spec.commonmark.org/0.31.2/#html-blocks includes processing
    // instructions, declarations and CDATA as well as tags. Types 1/6 may begin
    // at an unfinished tag ending the line. Comments are handled above.
    if (/^ {0,3}<(?:[?!]|\/?[A-Za-z][\w:-]*(?:\s|>|\/|$))/.test(line)) warning ??= 'The outline contains HTML blocks. Edit the complete document in source mode.';
    if (previous.trim() && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) warning ??= 'The outline contains Setext headings. Edit the complete document in source mode.';
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    previous = line;
    if (!heading) continue;
    if (/^ +#/.test(line)) warning ??= 'The outline contains indented headings that may belong to a list. Edit the complete document in source mode.';
    const title = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
    if (!title) { warning ??= 'The outline contains an empty heading.'; continue; }
    const level = heading[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop().end = start;
    const parentId = stack.at(-1)?.id ?? null;
    const base = `${parentId ?? ''}/${encodeURIComponent(title)}`;
    const count = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, count);
    const section = { id: `${base}:${count}`, title, level, parentId, start, bodyStart: start + raw.length, end: markdown.length };
    sections.push(section);
    stack.push(section);
  }
  if (fence || comment || frontmatter) warning ??= 'The outline contains an unclosed code fence, comment, or frontmatter block.';
  return { sections, warning };
}

/** @param {string} markdown @returns {WorkspaceSection[]} */
export function parseSections(markdown) { return inspectOutline(markdown).sections; }

/** @param {WorkspaceSection[]} sections @param {string} id */
function requireSection(sections, id) {
  const section = sections.find((s) => s.id === id);
  if (!section) throw new WorkspaceError('This page no longer exists. Reload the document.', 'missing_section', 404);
  return section;
}

/** @param {string} markdown @param {string|null} id @returns {string} */
export function sectionContent(markdown, id) {
  if (id === null) return markdown;
  const s = requireSection(parseSections(markdown), id);
  return markdown.slice(s.bodyStart, s.end);
}

/** @param {unknown} value @returns {string} */
function pageTitle(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\r\n\u0000-\u001f\u007f<>]/.test(value) || /\s#+\s*$/.test(value)) {
    throw new WorkspaceError('Page title must be 1–200 characters on one line, without HTML or closing heading markers.', 'invalid_title');
  }
  return value.trim();
}

/** @param {string} text @param {string} eol */
const lineEndings = (text, eol) => text.replace(/\r?\n/g, eol);

/** @param {string} markdown @param {WorkspaceMutation} mutation @returns {{content:string,selectedSection:string|null}} */
export function mutateDocument(markdown, mutation) {
  if (!mutation || typeof mutation !== 'object') throw new WorkspaceError('Invalid document operation.', 'invalid_operation');
  const { action, section: id = null } = mutation;
  if (id !== null && (typeof id !== 'string' || !id)) throw new WorkspaceError('Invalid page identifier.', 'invalid_section');
  if (action === 'replace' && id === null) {
    if (typeof mutation.content !== 'string') throw new WorkspaceError('Document content must be text.', 'invalid_content');
    return { content: mutation.content, selectedSection: null };
  }
  const { sections, warning } = inspectOutline(markdown);
  if (warning) throw new WorkspaceError(`Cannot change this outline safely: ${warning}`, 'unsafe_outline', 409);
  const selected = id === null ? null : requireSection(sections, id);
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  let content = markdown;
  let selectedStart = selected?.start ?? null;
  if (action === 'replace') {
    if (typeof mutation.content !== 'string') throw new WorkspaceError('Page content must be text.', 'invalid_content');
    const old = markdown.slice(selected.bodyStart, selected.end);
    if (old === mutation.content) return { content: markdown, selectedSection: id };
    const body = lineEndings(mutation.content, eol);
    const parsed = inspectOutline(body);
    if (parsed.warning || parsed.sections.some((s) => s.level <= selected.level)) {
      throw new WorkspaceError('Page content would change the surrounding outline. Use child headings or edit the whole document.', 'unsafe_outline', 409);
    }
    const lead = /^(?:[ \t]*\r?\n)*/.exec(old)[0];
    const trail = /\s*$/.exec(old.slice(lead.length))[0];
    const trimmed = body.replace(/^(?:[ \t]*\r?\n)*/, '').replace(/[ \t\r\n]*$/, '');
    const startGap = selected.bodyStart === selected.start || !markdown.slice(selected.start, selected.bodyStart).endsWith('\n') ? eol + eol : lead || eol;
    const endGap = trail || (selected.end < markdown.length ? eol + eol : eol);
    content = markdown.slice(0, selected.bodyStart) + startGap + trimmed + endGap + markdown.slice(selected.end);
  } else if (action === 'add') {
    const title = pageTitle(mutation.title);
    const level = selected ? selected.level + 1 : 2;
    if (level > 6) throw new WorkspaceError('Markdown supports at most six heading levels.', 'maximum_depth');
    const at = selected ? selected.end : markdown.length;
    const before = markdown.slice(0, at);
    const gap = !before || before.endsWith(eol + eol) ? '' : before.endsWith(eol) ? eol : eol + eol;
    const block = gap + '#'.repeat(level) + ' ' + title + eol + eol;
    selectedStart = at + gap.length;
    content = before + block + markdown.slice(at);
  } else if (action === 'rename') {
    if (!selected) throw new WorkspaceError('Choose a page to rename.', 'invalid_section');
    const title = pageTitle(mutation.title);
    const raw = markdown.slice(selected.start, selected.bodyStart);
    const prefix = /^ {0,3}#{1,6}[ \t]*/.exec(raw)[0];
    const ending = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '';
    content = markdown.slice(0, selected.start) + prefix + title + ending + markdown.slice(selected.bodyStart);
  } else if (action === 'move') {
    if (!selected || !['up', 'down'].includes(mutation.direction)) throw new WorkspaceError('Choose a page and a valid move direction.', 'invalid_operation');
    const siblings = sections.filter((s) => s.parentId === selected.parentId && s.level === selected.level);
    const i = siblings.findIndex((s) => s.id === selected.id);
    const neighbor = siblings[i + (mutation.direction === 'up' ? -1 : 1)];
    if (!neighbor) throw new WorkspaceError('This page has no sibling in that direction.', 'no_sibling');
    const first = selected.start < neighbor.start ? selected : neighbor;
    const second = first === selected ? neighbor : selected;
    if (first.end !== second.start) throw new WorkspaceError('These sibling sections are not adjacent in the outline.', 'unsafe_outline', 409);
    const firstBody = markdown.slice(first.start, first.end);
    const secondBody = markdown.slice(second.start, second.end);
    // A last section without a final newline cannot move before another heading
    // byte-for-byte. Refuse instead of joining its last paragraph to the heading.
    if (!secondBody.endsWith('\n')) throw new WorkspaceError('Add a final newline before moving this page.', 'unsafe_outline', 409);
    content = markdown.slice(0, first.start) + secondBody + firstBody + markdown.slice(second.end);
    selectedStart = selected === second ? first.start : first.start + secondBody.length;
  } else {
    throw new WorkspaceError('Unknown document operation.', 'invalid_operation');
  }
  const after = inspectOutline(content);
  if (after.warning) throw new WorkspaceError(`The change would damage the outline: ${after.warning}`, 'unsafe_outline', 409);
  const result = selectedStart === null ? null : after.sections.find((s) => s.start === selectedStart);
  return { content, selectedSection: result?.id ?? null };
}
