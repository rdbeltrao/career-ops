import { inspectOutline, mutateDocument } from './career-workspace.mjs';
import { navigationSections, pageBreadcrumbs } from './workspace-view.mjs';

/** Reuse the canonical parser; headings are locations inside one document.
 * @param {string} content
 */
export function documentOutline(content) {
  const { sections, warning } = inspectOutline(content);
  if (warning) return [];
  const visible = navigationSections(sections);
  return visible.map((section) => {
    const headingIndex = sections.findIndex((heading) => heading.id === section.id);
    return {
      ...sections[headingIndex],
      parentId: section.parentId,
      headingIndex,
      depth: pageBreadcrumbs(visible, section.id).length - 1,
    };
  });
}

/** Preserve old section-only browser drafts when opening a complete document.
 * @param {{content:string,revision:string}} document
 * @param {{section:string|null,revision:string,content:string,original:string,form:{kind:string,title:string}|null}} draft
 */
export function wholeDocumentDraft(document, draft) {
  if (!draft.section && !draft.form) return draft;
  if (document.revision !== draft.revision) throw new Error('This section draft belongs to an older document. Copy its recovered text before opening the saved document.');
  let content = draft.section ? mutateDocument(document.content, { action: 'replace', section: draft.section, content: draft.content }).content : draft.content;
  if (draft.form) content = mutateDocument(content, { action: draft.form.kind, section: draft.section, title: draft.form.title }).content;
  return { ...draft, section: null, content, original: document.content, form: null };
}
