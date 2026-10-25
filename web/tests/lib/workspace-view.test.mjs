import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageBreadcrumbs, visiblePageIds, siblingAvailability, selectedPageContent } from '../../src/lib/workspace-view.mjs';

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
