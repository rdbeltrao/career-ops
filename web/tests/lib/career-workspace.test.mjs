import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSections, sectionContent, mutateDocument, inspectOutline } from '../../src/lib/career-workspace.mjs';

const sample = '# Context\r\n\r\nIntro stays.\r\n\r\n## History\r\n\r\nFirst.\r\n### Employer\r\nA fact.\r\n\r\n## Skills\r\n\r\nPHP.\r\n';
const find = (md, title) => parseSections(md).find((s) => s.title === title);

test('nested headings expose original offsets, parents and complete subtree bodies', () => {
  const sections = parseSections(sample);
  assert.deepEqual(sections.map((s) => [s.title, s.level]), [['Context', 1], ['History', 2], ['Employer', 3], ['Skills', 2]]);
  assert.equal(sections[2].parentId, sections[1].id);
  assert.equal(sections[1].parentId, sections[0].id);
  assert.equal(sections[0].end, sample.length);
  assert.equal(sample.slice(sections[1].start, sections[1].bodyStart), '## History\r\n');
  assert.equal(sectionContent(sample, sections[1].id), '\r\nFirst.\r\n### Employer\r\nA fact.\r\n\r\n');
});

test('duplicate names get distinct stable identities and fences/comments are not pages', () => {
  const md = '# Root\n## Same\nA\n## Same\nB\n```md\n## Hidden\n```\n<!--\n## Also hidden\n-->\n~~~\n# Hidden again\n~~~\n';
  const a = parseSections(md);
  assert.deepEqual(a.map((s) => s.title), ['Root', 'Same', 'Same']);
  assert.equal(new Set(a.map((s) => s.id)).size, 3);
  assert.deepEqual(parseSections(md.replace('A\n', 'Longer body\n')).map((s) => s.id), a.map((s) => s.id));
});

test('frontmatter and fenced backticks with embedded shorter fences are ignored', () => {
  const md = '---\ntitle: Example\n# Not a page\n---\n# Page\n````md\n```\n## Not a page\n````\n## Real\n';
  assert.deepEqual(parseSections(md).map((s) => s.title), ['Page', 'Real']);
});

test('replace edits only selected body, preserves boundary whitespace and source line endings', () => {
  const section = find(sample, 'History');
  const result = mutateDocument(sample, { action: 'replace', section: section.id, content: 'Changed.\n### Employer\nStill attributed.' });
  assert.equal(result.content, sample.slice(0, section.bodyStart) + '\r\nChanged.\r\n### Employer\r\nStill attributed.\r\n\r\n' + sample.slice(section.end));
  assert.equal(result.selectedSection, section.id);
});

test('unchanged section body is a byte-exact no-op', () => {
  const section = find(sample, 'History');
  assert.equal(mutateDocument(sample, { action: 'replace', section: section.id, content: sectionContent(sample, section.id) }).content, sample);
});

test('replacing a section refuses sibling escape and unclosed fences', () => {
  const section = find(sample, 'History');
  for (const content of ['Text\n## Injected sibling\n', '```\nText', '<!-- Hidden remainder']) {
    assert.throws(() => mutateDocument(sample, { action: 'replace', section: section.id, content }), /section|outline/i);
  }
});

test('whole-document replacement stays available for unsupported outline syntax', () => {
  const md = 'Setext heading\n===\n\n<details>\n## Nested HTML heading\n</details>\n';
  assert.ok(inspectOutline(md).warning);
  assert.equal(mutateDocument(md, { action: 'replace', content: md + 'Preserved.\n' }).content, md + 'Preserved.\n');
  assert.throws(() => mutateDocument(md, { action: 'add', title: 'Child' }), /outline/i);
});

test('add nested page before following sibling and rename heading only', () => {
  const history = find(sample, 'History');
  const added = mutateDocument(sample, { action: 'add', section: history.id, title: 'Second employer' });
  const child = parseSections(added.content).find((s) => s.id === added.selectedSection);
  assert.equal(child.title, 'Second employer');
  assert.equal(child.level, 3);
  assert.equal(child.parentId, history.id);
  assert.ok(added.content.endsWith(sample.slice(find(sample, 'Skills').start)));
  const renamed = mutateDocument(added.content, { action: 'rename', section: child.id, title: 'Renamed' });
  assert.equal(renamed.content, added.content.replace('### Second employer', '### Renamed'));
  assert.equal(find(renamed.content, 'Renamed').id, renamed.selectedSection);
});

test('add to empty document creates only requested heading, no candidate facts', () => {
  const out = mutateDocument('', { action: 'add', title: 'Career history' });
  assert.equal(out.content, '## Career history\n\n');
  assert.equal(parseSections(out.content)[0].id, out.selectedSection);
});

test('reorder moves complete sibling subtree while preserving preamble and bytes', () => {
  const history = find(sample, 'History');
  const skills = find(sample, 'Skills');
  const moved = mutateDocument(sample, { action: 'move', section: history.id, direction: 'down' });
  assert.equal(moved.content, sample.slice(0, history.start) + sample.slice(skills.start, skills.end) + sample.slice(history.start, history.end));
  assert.deepEqual(parseSections(moved.content).map((s) => s.title), ['Context', 'Skills', 'History', 'Employer']);
  assert.equal(mutateDocument(moved.content, { action: 'move', section: moved.selectedSection, direction: 'up' }).content, sample);
});

test('operations reject invalid inputs and impossible positions', () => {
  const last = '###### Last\nText\n';
  assert.throws(() => mutateDocument(last, { action: 'add', section: parseSections(last)[0].id, title: 'Too deep' }), /six|6/i);
  for (const title of ['', '  ', 'Break\n## Other', 'nul\0']) assert.throws(() => mutateDocument(sample, { action: 'add', title }));
  assert.throws(() => mutateDocument(sample, { action: 'rename', section: 'unknown', title: 'Title' }), /page|section/i);
  assert.throws(() => mutateDocument(sample, { action: 'move', section: find(sample, 'Skills').id, direction: 'down' }), /sibling|last/i);
});

test('inline-comment headings and indented list headings cannot silently change section boundaries', () => {
  for (const md of ['## First\nText\n## Second <!-- private marker -->\nKeep.\n', '- Item\n  ## Nested list heading\n  Keep.\n']) {
    assert.ok(inspectOutline(md).warning);
    assert.throws(() => mutateDocument(md, { action: 'add', title: 'New page' }), /outline/i);
  }
});

test('headings inside list and quote fences stay out of the document outline', () => {
  const md = '# Root\n\n- Item\n  ```md\n  ## Inside list fence\n  ```\n\n> ```md\n> ## Inside quote fence\n> ```\n\n## Real page\nKeep.\n';
  assert.deepEqual(parseSections(md).map((s) => s.title), ['Root', 'Real page']);
  const real = find(md, 'Real page');
  const out = mutateDocument(md, { action: 'replace', section: real.id, content: 'Changed.' });
  assert.equal(out.content.slice(0, real.bodyStart), md.slice(0, real.bodyStart));
});

test('closing a multiline comment beside other content is treated as an ambiguous outline', () => {
  const md = '# Root\n<!--\n--> ## Mixed heading\nKept.\n';
  assert.ok(inspectOutline(md).warning);
  assert.throws(() => mutateDocument(md, { action: 'add', title: 'Child' }), /outline/i);
});

test('CommonMark processing instructions, CDATA, declarations and incomplete HTML tags refuse structural edits', () => {
  for (const [opening, closing] of [
    ['<?example', '?>'],
    ['<![CDATA[', ']]>'],
    ['<!DOCTYPE html', '>'],
    ['<script', '</script>'],
    ['<div', '</div>'],
    ['<custom-element property="value">', '</custom-element>'],
  ]) {
    const md = `## First\n\n${opening}\n## Hidden\n${closing}\n\n## Last\nKept.\n`;
    assert.ok(inspectOutline(md).warning, opening);
    const hidden = find(md, 'Hidden');
    assert.throws(() => mutateDocument(md, { action: 'replace', section: hidden.id, content: 'Replacement.' }), (e) => e.code === 'unsafe_outline', opening);
    assert.throws(() => mutateDocument(md, { action: 'add', title: 'Child' }), (e) => e.code === 'unsafe_outline', opening);
    assert.equal(mutateDocument(md, { action: 'replace', content: md }).content, md);
  }
});
