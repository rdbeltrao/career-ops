import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageBreadcrumbs, visiblePageIds, siblingAvailability, selectedPageContent, navigationSections, collapsedPageKeys, sourcePageBreadcrumbs, visibleSourcePageIds, sourcePageMovement, collapsedSourcePageIds, initialWorkspaceDocument } from '../../src/lib/workspace-view.mjs';

const sections = [
  { id: 'career', title: 'Career history', parentId: null, level: 2, bodyStart: 18, end: 90 },
  { id: 'first', title: 'Example employer', parentId: 'career', level: 3, bodyStart: 39, end: 60 },
  { id: 'second', title: 'Other employer', parentId: 'career', level: 3, bodyStart: 80, end: 90 },
  { id: 'skills', title: 'Skills', parentId: null, level: 2, bodyStart: 100, end: 110 },
];

test('page search keeps matching descendants and their ancestors, without unrelated branches', () => {
  assert.deepEqual([...visiblePageIds(sections, 'EXAMPLE')], ['first', 'career']);
  assert.deepEqual([...visiblePageIds(sections, 'career')], ['career', 'first', 'second']);
  assert.deepEqual([...visiblePageIds(sections, '   ')], sections.map((section) => section.id));
  assert.equal(visiblePageIds(sections, 'absent').size, 0);
});

test('breadcrumbs derive from server parents and survive missing or cyclic entries', () => {
  assert.deepEqual(pageBreadcrumbs(sections, 'first').map((section) => section.id), ['career', 'first']);
  assert.deepEqual(pageBreadcrumbs(sections, null), []);
  assert.deepEqual(pageBreadcrumbs(sections, 'unknown'), []);
  assert.deepEqual(pageBreadcrumbs([{ id: 'a', title: 'A', parentId: 'a' }], 'a').map((section) => section.id), ['a']);
});

test('reordering availability counts only siblings', () => {
  assert.deepEqual(siblingAvailability(sections, 'first'), { up: false, down: true });
  assert.deepEqual(siblingAvailability(sections, 'second'), { up: true, down: false });
  assert.deepEqual(siblingAvailability(sections, 'skills'), { up: true, down: false });
  assert.deepEqual(siblingAvailability(sections, null), { up: false, down: false });
});

test('selected content uses exact server offsets and never reparses Markdown', () => {
  const content = '# Source\r\n\r\n## Page\r\nBody\r\n\r\n## Next\r\nKeep\r\n';
  const page = { id: 'page', bodyStart: content.indexOf('Body'), end: content.indexOf('## Next') };
  assert.equal(selectedPageContent({ content, sections: [page] }, 'page'), 'Body\r\n\r\n');
  assert.equal(selectedPageContent({ content, sections: [page] }, null), content);
  assert.throws(() => selectedPageContent({ content, sections: [page] }, 'missing'), /no longer exists/);
});

test('navigation hides a sole H1 wrapper without changing source headings or offsets', () => {
  const source = [
    { id: 'wrapper', title: 'Raw file title', parentId: null, level: 1, bodyStart: 12, end: 150 },
    { id: 'experience', title: 'Experience', parentId: 'wrapper', level: 2, bodyStart: 34, end: 90 },
    { id: 'role', title: 'Example role', parentId: 'experience', level: 3, bodyStart: 54, end: 90 },
    { id: 'skills', title: 'Skills', parentId: 'wrapper', level: 2, bodyStart: 104, end: 150 },
  ];
  const display = navigationSections(source);
  assert.deepEqual(display.map(({ id, parentId, level }) => ({ id, parentId, level })), [
    { id: 'experience', parentId: null, level: 2 },
    { id: 'role', parentId: 'experience', level: 3 },
    { id: 'skills', parentId: null, level: 2 },
  ]);
  assert.deepEqual(pageBreadcrumbs(display, 'role').map(({ title }) => title), ['Experience', 'Example role']);
  assert.equal(source[1].parentId, 'wrapper');
  assert.equal(display[0].bodyStart, 34);
  assert.equal(display[0].end, 90);
  assert.deepEqual(navigationSections([source[0]]), [source[0]], 'A newly created first page remains selectable.');
});

test('navigation keeps multiple top-level headings and a sole non-H1 heading', () => {
  const roots = [{ id: 'one', title: 'One', parentId: null, level: 1 }, { id: 'two', title: 'Two', parentId: null, level: 1 }];
  assert.deepEqual(navigationSections(roots), roots);
  assert.deepEqual(navigationSections(sections), sections);
  assert.deepEqual(navigationSections([sections[0]]), [sections[0]]);
});

test('navigation opens only the selected document and selected page ancestry by default', () => {
  const documents = [{ id: 'context', sections }, { id: 'cv', sections }];
  const root = collapsedPageKeys(documents, { document: 'context', section: null });
  assert.deepEqual([...root].sort(), ['context:career', 'cv', 'cv:career']);
  const child = collapsedPageKeys(documents, { document: 'context', section: 'first' });
  assert.deepEqual([...child].sort(), ['cv', 'cv:career']);
  const other = collapsedPageKeys(documents, { document: 'cv', section: 'career' });
  assert.deepEqual([...other].sort(), ['context', 'context:career']);
});

const sourcePages = [
  { id: 'source-root', title: 'Career records', kind: 'source', parentDocumentId: null, sections: [{ id: 'body-heading', title: 'Not a child page', parentId: null }] },
  { id: 'source-work', title: 'Work', kind: 'source', parentDocumentId: 'source-root', sections: [] },
  { id: 'source-role', title: 'Example role', kind: 'source', parentDocumentId: 'source-work', sections: [] },
  { id: 'source-learning', title: 'Learning', kind: 'source', parentDocumentId: 'source-root', sections: [] },
  { id: 'context', title: 'Application profile', kind: 'local', parentDocumentId: null, sections },
  { id: 'cv', title: 'CV draft', kind: 'local', parentDocumentId: null, sections },
];

test('source navigation follows actual page parents, never body headings or app summaries', () => {
  assert.deepEqual(sourcePageBreadcrumbs(sourcePages, 'source-role').map(({ id }) => id), ['source-root', 'source-work', 'source-role']);
  assert.deepEqual([...visibleSourcePageIds(sourcePages, 'role')], ['source-role', 'source-root', 'source-work']);
  assert.deepEqual([...visibleSourcePageIds(sourcePages, 'Work')], ['source-work', 'source-root', 'source-role']);
  assert.equal(visibleSourcePageIds(sourcePages, 'Not a child page').size, 0);
  assert.equal(visibleSourcePageIds(sourcePages, 'Application profile').size, 0);
});

test('source branch and movement state use real document ancestry', () => {
  assert.deepEqual([...collapsedSourcePageIds(sourcePages, 'source-root')], ['source-work']);
  assert.deepEqual([...collapsedSourcePageIds(sourcePages, 'source-role')], []);
  assert.deepEqual(sourcePageMovement(sourcePages, 'source-root'), { up: false, down: false });
  assert.deepEqual(sourcePageMovement(sourcePages, 'source-work'), { up: false, down: true });
  assert.deepEqual(sourcePageMovement(sourcePages, 'source-learning'), { up: true, down: false });
});

test('Context opens the source root, while CV opens its separate local draft', () => {
  assert.equal(initialWorkspaceDocument(sourcePages, 'context', 'source-root'), 'source-root');
  assert.equal(initialWorkspaceDocument(sourcePages, 'context', null), 'source-root');
  assert.equal(initialWorkspaceDocument(sourcePages, 'cv', 'source-root'), 'cv');
  assert.equal(initialWorkspaceDocument(sourcePages.filter(({ kind }) => kind === 'local'), 'context', null), null);
});
