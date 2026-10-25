/** @typedef {{id: string, title: string, parentId: string|null, level?: number, bodyStart?: number, end?: number}} PageSection */

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
