import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentOutline, wholeDocumentDraft } from '../../src/lib/document-outline.mjs';

const content = '# Alex Example\n\n## Summary\n\nOriginal summary.\n\n## Experience\n\n### Example Labs\n\nWork record.\n\n## Skills\n\nTypeScript.\n';

test('outline skips the document title while preserving heading locations and nesting', () => {
  const outline = documentOutline(content);
  assert.deepEqual(outline.map(({ title, headingIndex, depth }) => ({ title, headingIndex, depth })), [
    { title: 'Summary', headingIndex: 1, depth: 0 },
    { title: 'Experience', headingIndex: 2, depth: 0 },
    { title: 'Example Labs', headingIndex: 3, depth: 1 },
    { title: 'Skills', headingIndex: 4, depth: 0 },
  ]);
  for (const section of outline) assert.match(content.slice(section.start, section.bodyStart), /^#{2,3} /);
});

test('outline updates from unsaved text, distinguishes repeated headings and ignores code fences', () => {
  const draft = content + '\n## Skills\n\nOther skills.\n\n```md\n## Not a section\n```\n';
  const outline = documentOutline(draft);
  assert.deepEqual(outline.filter(({ title }) => title === 'Skills').map(({ headingIndex }) => headingIndex), [4, 5]);
  assert.equal(new Set(outline.map(({ id }) => id)).size, outline.length);
  assert.equal(outline.some(({ title }) => title === 'Not a section'), false);
  assert.deepEqual(documentOutline('# Incomplete\n\n```md\n## Hidden'), []);
});

test('old section drafts recover into the full CV without replacing unrelated sections', () => {
  const section = documentOutline(content)[0];
  const draft = { section: section.id, revision: 'same', content: 'Edited summary.', original: 'Original summary.', form: null };
  const recovered = wholeDocumentDraft({ content, revision: 'same' }, draft);
  assert.equal(recovered.section, null);
  assert.match(recovered.content, /## Summary\n\nEdited summary\./);
  assert.equal(recovered.content.slice(recovered.content.indexOf('## Experience')), content.slice(content.indexOf('## Experience')));
  assert.equal(recovered.original, content);
  assert.equal(draft.content, 'Edited summary.');
});

test('pending heading edits recover as unsaved document edits', () => {
  const section = documentOutline(content)[0];
  const recovered = wholeDocumentDraft({ content, revision: 'same' }, { section: section.id, revision: 'same', content: 'Edited summary.', original: '', form: { kind: 'rename', title: 'Profile' } });
  assert.match(recovered.content, /## Profile\n\nEdited summary\./);
  assert.equal(recovered.form, null);
  const rootDraft = wholeDocumentDraft({ content, revision: 'same' }, { section: null, revision: 'same', content, original: content, form: { kind: 'add', title: 'Languages' } });
  assert.match(rootDraft.content, /## Languages\n/);
  assert.equal(rootDraft.section, null);
  assert.equal(rootDraft.form, null, 'old local page forms become document edits');
});

test('stale or missing section drafts cannot overwrite a newer full document', () => {
  const draft = { section: documentOutline(content)[0].id, revision: 'old', content: 'Draft.', original: '', form: null };
  assert.throws(() => wholeDocumentDraft({ content, revision: 'new' }, draft), /older document/);
  assert.throws(() => wholeDocumentDraft({ content, revision: 'old' }, { ...draft, section: 'missing' }), /no longer exists/);
  const fullDraft = { ...draft, section: null, content };
  assert.equal(wholeDocumentDraft({ content, revision: 'new' }, fullDraft), fullDraft);
});
