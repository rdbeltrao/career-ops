import test from 'node:test';
import assert from 'node:assert/strict';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { planImport } from '../../src/lib/notion-workspace-import.mjs';

const ROOT = '11111111111111111111111111111111';
const CHILD = '22222222222222222222222222222222';
const OTHER = '33333333333333333333333333333333';
const url = (id) => `https://app.notion.com/p/${id}`;
const wrapped = (body) => `<page url="${url(ROOT)}"><ancestor-path>not content</ancestor-path><properties>{"title":"Example"}</properties><content>\n${body}\n</content></page>`;
const page = (id, body, parentId = null, children = []) => ({ id, parentId, children, title: id === ROOT ? 'Example library' : 'Same child title', url: url(id), lastEditedAt: '2026-10-25T12:00:00.000Z', text: wrapped(body) });
const input = (body = 'A source paragraph.') => ({ version: 1, rootId: ROOT, pages: [page(ROOT, body)] });
const bodyOf = (plan, id = ROOT) => plan.files.find((file) => file.path === `pages/${id}.md`).content;

test('plans the exact true page hierarchy and archives untouched connector text', () => {
  const source = { version: 1, rootId: ROOT, pages: [page(ROOT, '## Inside the landing page', null, [OTHER, CHILD]), page(CHILD, 'Child two.', ROOT), page(OTHER, 'Child one.', ROOT)] };
  const plan = planImport(source);
  assert.equal(plan.manifest.pages.length, 3);
  assert.equal(plan.manifest.pages.find((p) => p.id === CHILD).order, 1);
  assert.equal(plan.manifest.pages.find((p) => p.id === OTHER).order, 0);
  assert.equal(plan.manifest.pages[0].sourceUrl, url(ROOT));
  assert.equal(bodyOf(plan), '## Inside the landing page\n');
  assert.deepEqual(JSON.parse(plan.files.find((f) => f.path === `sources/${ROOT}.json`).content), source.pages[0]);
  assert.deepEqual(JSON.parse(plan.files.find((f) => f.path === 'index.json').content), plan.manifest);
});

test('renders child pages and mentions as internal links without inventing pages', () => {
  const source = { version: 1, rootId: ROOT, pages: [page(ROOT, `<page url="${url(CHILD)}">Child &amp; notes</page>\n<mention url="${url(CHILD)}">Same page</mention> and <mention-page url="${url(OTHER)}">External reference</mention-page>`, null, [CHILD]), page(CHILD, 'Child.', ROOT)] };
  const markdown = bodyOf(planImport(source));
  assert.match(markdown, new RegExp(`\\[Child & notes\\]\\(/context\\?document=source-${CHILD}\\)`));
  assert.match(markdown, new RegExp(`\\[Same page\\]\\(/context\\?document=source-${CHILD}\\)`));
  assert.match(markdown, new RegExp(`\\[External reference\\]\\(https://app.notion.com/p/${OTHER}\\)`));
  assert.doesNotMatch(markdown, /<page|<mention|ancestor-path|properties/);
});

test('renders formatting, nested callouts, expanded toggles and columns', () => {
  const plan = planImport(input('<b>Bold</b>, <i>italic</i>, <s>gone</s>.\n<callout icon="💡"><b>Note</b>\n<details><summary>More</summary>\nA fact.\n</details></callout>\n<columns><column>First column.</column><column>Second column.</column></columns>\n<p />\n# Heading {color="red" toggle="true"}\n\tChild text.'));
  const markdown = bodyOf(plan);
  assert.match(markdown, /\*\*Bold\*\*, \*italic\*, ~~gone~~\./);
  assert.match(markdown, /> 💡 \*\*Note\*\*/);
  assert.match(markdown, /> \*\*More\*\*/);
  assert.match(markdown, /> A fact\./);
  assert.match(markdown, /First column\.\n\nSecond column\./);
  assert.match(markdown, /# Heading\n/);
  assert.doesNotMatch(markdown, /<(?:b|i|s|callout|details|summary|columns|column)|\{color=/);
  assert.ok(plan.warnings[0].warnings.some((warning) => /column/i.test(warning)));
});

test('tables preserve every cell and neutral headers when the original has no header row', () => {
  const markdown = bodyOf(planImport(input('<table header-row="true"><tr><td>Name</td><td>Value</td></tr><tr><td><b>A</b></td><td>One | two<br>three</td></tr></table>\n<table><tr><td>Fact</td><td>Detail</td></tr></table>')));
  assert.match(markdown, /\| Name \| Value \|\n\| --- \| --- \|\n\| \*\*A\*\* \| One \\\| two; three \|/);
  assert.match(markdown, /\|  \|  \|\n\| --- \| --- \|\n\| Fact \| Detail \|/);
  assert.doesNotMatch(markdown, /<table|<tr|<td|<br/);
});

test('media stays accessible and unsafe HTML or links cannot execute', () => {
  const plan = planImport(input('<video src="https://example.com/movie">Interview clip</video>\n<pdf src="https://example.com/reference.pdf"/>\n<bookmark href="https://example.com">Website</bookmark>\n<embed src="javascript:alert(1)">Unsafe</embed>\n<script>alert("no")</script>\n<img src="javascript:bad" onerror="steal()" />\n<unknown url="https://example.com/block" alt="drawing"/>'));
  const markdown = bodyOf(plan);
  assert.match(markdown, /\[Interview clip\]\(https:\/\/example.com\/movie\)/);
  assert.match(markdown, /\[PDF\]\(https:\/\/example.com\/reference.pdf\)/);
  assert.match(markdown, /\[Website\]\(https:\/\/example.com\)/);
  assert.doesNotMatch(markdown, /\]\(javascript:|<script>|<img/);
  assert.match(markdown, /alert\("no"\)/);
  assert.match(markdown, /drawing/);
  assert.ok(plan.warnings[0].warnings.some((warning) => /unsafe/i.test(warning)));
});

test('code fences and inline code remain literal while ordinary links are rewritten', () => {
  const source = { version: 1, rootId: ROOT, pages: [page(ROOT, '```html\n<b>Code</b>\n<page url="https://example.com">Literal</page>\n```\n\n`<b>inline</b>`\n\n[Child](' + url(CHILD) + ')', null, [CHILD]), page(CHILD, '', ROOT)] };
  const markdown = bodyOf(planImport(source));
  assert.match(markdown, /```html\n<b>Code<\/b>\n<page url="https:\/\/example.com">Literal<\/page>\n```/);
  assert.match(markdown, /`<b>inline<\/b>`/);
  assert.match(markdown, new RegExp(`\\[Child\\]\\(/context\\?document=source-${CHILD}\\)`));
});

test('rejects incomplete, malformed and unsafe hierarchies before planning any writes', () => {
  const missing = input(); missing.pages[0].children.push(CHILD);
  assert.throws(() => planImport(missing), /missing|unfetched/i);
  const orphan = input(); orphan.pages.push(page(CHILD, '', OTHER));
  assert.throws(() => planImport(orphan), /parent|unreachable/i);
  const incomplete = input(); incomplete.pages[0].truncated = true;
  assert.throws(() => planImport(incomplete), /incomplete|truncated/i);
  const unknown = input(); unknown.pages[0].unknown_block_count = 1;
  assert.throws(() => planImport(unknown), /incomplete|unknown/i);
  const unsafe = input(); unsafe.pages[0].id = '../escape';
  assert.throws(() => planImport(unsafe), /id/i);
  const wrapper = input(); wrapper.pages[0].text = 'Fetch failed.';
  assert.throws(() => planImport(wrapper), /content|wrapper/i);
  const duplicate = input(); duplicate.pages.push(duplicate.pages[0]);
  assert.throws(() => planImport(duplicate), /duplicate/i);
});

test('unknown custom markup remains visible and original source remains available', () => {
  const plan = planImport(input('<widget mode="special">Important source phrase</widget>'));
  assert.match(bodyOf(plan), /Important source phrase/);
  assert.match(bodyOf(plan), /&lt;widget/);
  assert.ok(plan.warnings[0].warnings.some((warning) => /widget/.test(warning)));
});

test('supports connector legacy tags, nested lists and private media references', () => {
  const plan = planImport(input('<date start="2026-10-25"/>\n<code>&lt;goal&gt;</code>\n<ul><li>First item<ul><li>Nested item</li></ul></li><li>Second item</li></ul>\n<ol><li>One</li><li>Two</li></ol>\n<toggle heading="h3">A question\n\nAn answer.</toggle>\n<image source="notion-file-block://private/image">Source image caption</image>\n<bookmark source="https://example.com"/>\n<table-of-contents/>'));
  const markdown = bodyOf(plan);
  assert.match(markdown, /2026-10-25/);
  assert.match(markdown, /`<goal>`/);
  assert.match(markdown, /- First item\n\n  - Nested item\n- Second item/);
  assert.match(markdown, /1\. One\n2\. Two/);
  assert.match(markdown, /### A question\n\nAn answer\./);
  assert.match(markdown, new RegExp(`\\[Image: Source image caption \\(view in Notion\\)\\]\\(https://app.notion.com/p/${ROOT}\\)`));
  assert.match(markdown, /\[Bookmark\]\(https:\/\/example.com\)/);
  assert.doesNotMatch(markdown, /&lt;(?:date|code|ul|li|ol|toggle|image|table-of-contents)/);
});

test('normalizes conventional UUIDs without changing archived source', () => {
  const hyphenated = '11111111-1111-1111-1111-111111111111';
  const source = input(); source.rootId = hyphenated; source.pages[0].id = hyphenated;
  const plan = planImport(source);
  assert.equal(plan.manifest.rootId, ROOT);
  assert.equal(JSON.parse(plan.files.find((f) => f.path === `sources/${ROOT}.json`).content).id, hyphenated);
});

test('legacy code preserves embedded backticks and formatting preserves word spacing', () => {
  const markdown = bodyOf(planImport(input('<code>const x = `foo`</code>\n<code>const x = `foo`;\nconst y = 1;</code>\n<b>one </b>two <i> three</i>.')));
  assert.equal(fromMarkdown(markdown).children[0].children[0].value, 'const x = `foo`');
  assert.match(markdown, /```\nconst x = `foo`;\nconst y = 1;\n```/);
  assert.match(markdown, /\*\*one\*\* two  \*three\*\./);
  assert.doesNotMatch(markdown, /NOTION_LITERAL/);
});

test('preserves conversion notes on the imported page for later display', () => {
  const plan = planImport(input('<columns><column>One</column><column>Two</column></columns>'));
  assert.deepEqual(plan.manifest.pages[0].importNotes, plan.warnings[0].warnings);
  assert.deepEqual(JSON.parse(plan.files[0].content), plan.manifest);
});

test('code fences retain blockquote and list prefixes after conversion', () => {
  const quote = fromMarkdown(bodyOf(planImport(input('<callout>\n```js\nconst x = 1;\n```\n</callout>\nAfter.'))));
  assert.equal(quote.children[0].type, 'blockquote');
  assert.equal(quote.children[0].children[0].type, 'code');
  assert.equal(quote.children[0].children[0].value, 'const x = 1;');
  assert.equal(quote.children[1].children[0].value, 'After.');
  const list = fromMarkdown(bodyOf(planImport(input('<ul><li>Example\n\n```js\nconst x = 1;\n```\n</li></ul>\nAfter.'))));
  assert.equal(list.children[0].children[0].children[1].type, 'code');
  assert.equal(list.children[0].children[0].children[1].value, 'const x = 1;');
  assert.equal(list.children[1].children[0].value, 'After.');
});

test('unexpected list or table children remain visible rather than disappearing', () => {
  const plan = planImport(input('<ul><widget>Keep this phrase</widget><li>Ordinary item</li></ul>\n<table header-row="true"><tr><td>Heading</td></tr><widget>Keep the table note</widget></table>'));
  const markdown = bodyOf(plan);
  assert.match(markdown, /Keep this phrase/);
  assert.match(markdown, /Ordinary item/);
  assert.match(markdown, /Keep the table note/);
});

test('container indentation does not become literal code-fence content', () => {
  const markdown = bodyOf(planImport(input('<columns>\n\t<column>\n\t\t<callout>\n\t\t\t```js\n\t\t\t  const x = 1;\n\t\t\t```\n\t\t</callout>\n\t</column>\n</columns>')));
  const code = fromMarkdown(markdown).children[0].children[0];
  assert.equal(code.type, 'code');
  assert.equal(code.lang, 'js');
  assert.equal(code.value, '  const x = 1;');
});
