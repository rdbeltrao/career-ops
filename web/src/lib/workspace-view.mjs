/** @typedef {{id: string, title: string, parentId: string|null, level?: number, bodyStart?: number, end?: number}} PageSection */

/** A sole H1 names the document already shown by the document button. Lift its
 * children for navigation only; source sections, heading levels and offsets stay intact.
 * @param {PageSection[]} sections
 */
export function navigationSections(sections) {
  const roots = sections.filter((section) => section.parentId === null);
  if (roots.length !== 1 || roots[0].level !== 1 || !sections.some((section) => section.parentId === roots[0].id)) return sections;
  const wrapper = roots[0].id;
  return sections.filter((section) => section.id !== wrapper).map((section) => section.parentId === wrapper ? { ...section, parentId: null } : section);
}

/** Keep inactive documents and branches compact while opening the selected path.
 * @param {{id: string, sections: PageSection[]}[]} documents
 * @param {{document: string, section: string|null}} selected
 */
export function collapsedPageKeys(documents, selected) {
  const collapsed = new Set();
  for (const document of documents) {
    if (document.id !== selected.document) collapsed.add(document.id);
    const sections = navigationSections(document.sections);
    const open = new Set(document.id === selected.document ? pageBreadcrumbs(sections, selected.section).map((section) => section.id) : []);
    for (const section of sections) {
      if (sections.some((child) => child.parentId === section.id) && !open.has(section.id)) collapsed.add(`${document.id}:${section.id}`);
    }
  }
  return collapsed;
}

/** @typedef {{id: string, title: string, kind?: string, parentDocumentId?: string|null, order?: number, usage?: string, declaredUsage?: string|null}} SourceDocument */

/** Source pages are whole documents. Their Markdown headings never define the
 * page hierarchy imported from Notion.
 * @param {SourceDocument[]} documents
 */
function sourceTree(documents) {
  return documents.filter((document) => document.kind === 'source').sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((document) => ({ ...document, parentId: document.parentDocumentId ?? null }));
}

/** @param {SourceDocument[]} documents @param {string|null} selectedId */
export function sourcePageBreadcrumbs(documents, selectedId) {
  return pageBreadcrumbs(sourceTree(documents), selectedId);
}

/** @param {SourceDocument[]} documents @param {string} query */
export function visibleSourcePageIds(documents, query) {
  return visiblePageIds(sourceTree(documents), query);
}

/** Career-fact pages plus the ancestors needed to reach them in the tree.
 * @param {SourceDocument[]} documents
 */
export function evidenceSourcePageIds(documents) {
  const pages = sourceTree(documents);
  const byId = new Map(pages.map((page) => [page.id, page]));
  const ids = new Set();
  for (const page of pages) {
    if (page.usage !== 'facts') continue;
    for (let current = page; current && !ids.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) ids.add(current.id);
  }
  return ids;
}

/** Where a page's purpose comes from. `from` is the nearest ancestor that sets
 * it, or null when the page sets it itself or falls back to the default.
 * @param {SourceDocument[]} documents @param {string} selectedId
 */
export function sourcePurposeOrigin(documents, selectedId) {
  const pages = sourceTree(documents);
  const byId = new Map(pages.map((page) => [page.id, page]));
  const page = byId.get(selectedId);
  if (!page || page.declaredUsage) return { from: null };
  const seen = new Set([page.id]);
  for (let current = page.parentId ? byId.get(page.parentId) : undefined; current && !seen.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) {
    seen.add(current.id);
    if (current.declaredUsage) return { from: { id: current.id, title: current.title } };
  }
  return { from: null };
}

/** Pages below this one that follow its purpose because they set none of their own.
 * @param {SourceDocument[]} documents @param {string} selectedId
 */
export function inheritingSourcePageCount(documents, selectedId) {
  const pages = sourceTree(documents);
  const seen = new Set([selectedId]);
  let count = 0;
  const pending = [selectedId];
  while (pending.length) {
    const parentId = pending.pop();
    for (const child of pages) {
      if (child.parentId !== parentId || seen.has(child.id) || child.declaredUsage) continue;
      seen.add(child.id);
      count++;
      pending.push(child.id);
    }
  }
  return count;
}

/** @param {SourceDocument[]} documents @param {string} selectedId */
export function sourcePageMovement(documents, selectedId) {
  const pages = sourceTree(documents);
  if (!pages.find((page) => page.id === selectedId)?.parentId) return { up: false, down: false };
  return siblingAvailability(pages, selectedId);
}

/** @param {SourceDocument[]} documents @param {string|null} selectedId */
export function collapsedSourcePageIds(documents, selectedId) {
  const pages = sourceTree(documents);
  const open = new Set(pageBreadcrumbs(pages, selectedId).map((page) => page.id));
  return new Set(pages.filter((page) => !open.has(page.id) && pages.some((child) => child.parentId === page.id)).map((page) => page.id));
}

/** Context has one hierarchy. Legacy files are a fallback only; CV is a separate output.
 * @template {SourceDocument} T
 * @param {T[]} documents @param {'context'|'cv'} route
 */
export function workspaceNavigationDocuments(documents, route) {
  if (route === 'cv') return documents.filter((document) => document.id === 'cv');
  const pages = documents.filter((document) => document.kind === 'source');
  return pages.length ? pages : documents.filter((document) => document.kind !== 'source' && document.id !== 'cv');
}

/** A stale link to a legacy file must not expose a second Context hierarchy.
 * @param {SourceDocument[]} documents @param {'context'|'cv'} route
 * @param {string|null} sourceRootId @param {string|null} [requestedId]
 */
export function initialWorkspaceDocument(documents, route, sourceRootId, requestedId = null) {
  if (route === 'cv') return 'cv';
  const pages = workspaceNavigationDocuments(documents, route);
  const requested = pages.find((page) => page.id === requestedId);
  if (requested) return requested.id;
  const sourceRoot = pages.find((page) => page.kind === 'source' && page.id === sourceRootId) ?? pages.find((page) => page.kind === 'source' && !page.parentDocumentId);
  return sourceRoot?.id ?? pages.find((page) => page.id === 'context')?.id ?? pages[0]?.id ?? null;
}

/** @param {PageSection[]} sections @param {string|null} selectedId */
export function pageBreadcrumbs(sections, selectedId) {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const trail = [];
  const seen = new Set();
  let current = selectedId ? byId.get(selectedId) : undefined;
  while (current && !seen.has(current.id)) {
    trail.unshift(current);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return trail;
}

/** Search includes ancestors for orientation and descendants of a matching page.
 * @param {PageSection[]} sections @param {string} query
 */
export function visiblePageIds(sections, query) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return new Set(sections.map((section) => section.id));
  const visible = new Set();
  const matches = new Set(sections.filter((section) => section.title.toLocaleLowerCase().includes(needle)).map((section) => section.id));
  for (const section of sections) {
    const trail = pageBreadcrumbs(sections, section.id);
    if (matches.has(section.id)) {
      visible.add(section.id);
      for (const parent of trail) visible.add(parent.id);
    } else if (trail.some((parent) => matches.has(parent.id))) visible.add(section.id);
  }
  return visible;
}

/** @param {PageSection[]} sections @param {string|null} selectedId */
export function siblingAvailability(sections, selectedId) {
  const current = sections.find((section) => section.id === selectedId);
  if (!current) return { up: false, down: false };
  const siblings = sections.filter((section) => section.parentId === current.parentId);
  const index = siblings.findIndex((section) => section.id === selectedId);
  return { up: index > 0, down: index >= 0 && index < siblings.length - 1 };
}

/** EVIDENCE: The server owns Markdown parsing; source offsets preserve line endings
 * and prevent the UI from developing a competing section parser (web/AGENTS.md).
 * @param {{content: string, sections: PageSection[]}} document @param {string|null} selectedId
 */
export function selectedPageContent(document, selectedId) {
  if (!selectedId) return document.content;
  const section = document.sections.find((page) => page.id === selectedId);
  if (!section || section.bodyStart === undefined || section.end === undefined) throw new Error('This page no longer exists. Open its parent to continue.');
  return document.content.slice(section.bodyStart, section.end);
}
