import test from 'node:test';
import assert from 'node:assert/strict';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import { isNotionUrl, normalizeWorkspaceLinks, neutralizeImportNotes } from '../../src/lib/workspace-links.mjs';

const ID = '11111111111111111111111111111111';
const known = [{ id: ID, title: 'Career notes', sourceUrl: `https://app.notion.com/p/${ID}` }];
const url = `https://app.notion.com/p/${ID}`;
const internal = `/context?document=source-${ID}`;
const unknown = 'https://other.notion.site/22222222222222222222222222222222';
const parse = (source) => fromMarkdown(source, { extensions: [gfmAutolinkLiteral()], mdastExtensions: [gfmAutolinkLiteralFromMarkdown()] });
function destinations(source) {
  const found = [];
  function visit(node) { if (node.url) found.push(node.url); for (const child of node.children || []) visit(child); }
  visit(parse(source));
  return found;
}

test('recognizes Notion destinations without matching unrelated hosts', () => {
  for (const value of [url, unknown, '//APP.NOTION.COM/path', 'HTTPS://WWW.NOTION.SO./page', 'https://%6eotion.so/page', 'notion://page', 'notion-file-block://asset', 'notion.so/page', 'app.notion.com/page']) assert.equal(isNotionUrl(value), true, value);
  for (const value of ['/context', 'https://notion.so.example.com', 'https://example.com/notion.so', 'https://notion.so@example.com', null]) assert.equal(isNotionUrl(value), false, String(value));
});

test('maps imported pages and preserves human labels, formatting and surrounding bytes', () => {
  const source = `Before.\r\n\r\n[**Career** notes](${url} "Source title") and [Research](https://example.com/a "Keep title").\r\nAfter.\r\n`;
  assert.equal(normalizeWorkspaceLinks(source, known), `Before.\r\n\r\n[**Career** notes](${internal} "Source title") and [Research](https://example.com/a "Keep title").\r\nAfter.\r\n`);
});

test('raw URL labels for the same imported page display its title without changing custom labels', () => {
  const alias = `https://www.notion.so/Career-${ID}?source=copy_link`;
  const source = `Before.\r\n[${url}](${url}) and [${alias}](${url} "Original").\r\n[Career proof](${url}) and [See ${url}](${url}) and [**${url}**](${url}).\r\n[${unknown}](${url})\r\n`;
  const result = normalizeWorkspaceLinks(source, known);
  assert.equal(result, `Before.\r\n[Career notes](${internal}) and [Career notes](${internal} "Original").\r\n[Career proof](${internal}) and [See ${url}](${internal}) and [**${url}**](${internal}).\r\n[${unknown}](${internal})\r\n`);
  assert.ok(source.includes(`[${url}](${url})`), 'the pure display transform does not mutate the source');
  assert.equal(normalizeWorkspaceLinks(result, known), result);
});

test('raw URL reference labels use escaped imported titles and retain reference titles', () => {
  const source = `[${url}][career]\n\n[career]: ${url} "Original"\n`;
  assert.equal(normalizeWorkspaceLinks(source, [{ id: ID, title: 'Career [facts] *confirmed*' }]), `[Career \\[facts\\] \\*confirmed\\*](${internal} "Original")\n\n\n`);
  assert.equal(normalizeWorkspaceLinks(`[${url}](${url})`, [{ id: ID }]), `[${url}](${internal})`, 'a missing imported title preserves the URL label');
});

test('already-internal links replace only matching raw URL labels from known pages', () => {
  const source = `[${url}](${internal} "Keep title")\r\n[Career proof](${internal})\r\n[${unknown}](${internal})\r\n[${url}](https://example.com${internal})\r\n`;
  assert.equal(normalizeWorkspaceLinks(source, known), `[Career notes](${internal} "Keep title")\r\n[Career proof](${internal})\r\n[${unknown}](${internal})\r\n[${url}](https://example.com${internal})\r\n`);
  assert.equal(normalizeWorkspaceLinks(`[${url}](${internal})`, []), `[${url}](${internal})`, 'unknown local IDs retain their label');
  const reference = `[${url}][local]\n\n[local]: ${internal} "Reference title"\n`;
  assert.equal(normalizeWorkspaceLinks(reference, known), `[Career notes](${internal} "Reference title")\n\n[local]: ${internal} "Reference title"\n`);
  const result = normalizeWorkspaceLinks(source, known);
  assert.equal(normalizeWorkspaceLinks(result, known), result);
});

test('unknown references become plain labels, while image links become page links or captions', () => {
  const result = normalizeWorkspaceLinks(`[Unknown **reference**](${unknown})\n![Career picture](${url})\n![Unavailable picture](${unknown})`, known);
  assert.equal(result, `Unknown **reference**\n[Career picture](${internal})\nUnavailable picture`);
  assert.ok(destinations(result).every((href) => !isNotionUrl(href)));
});

test('reference-style links and definitions are normalized without changing unrelated definitions', () => {
  const source = `[Known][k] and [Unknown][u] and ![Image][k].\n\n[k]: ${url} "Original"\n[u]: ${unknown}\n[other]: https://example.com\n`;
  const result = normalizeWorkspaceLinks(source, known);
  assert.equal(result, `[Known](${internal} "Original") and Unknown and [Image](${internal} "Original").\n\n\n\n[other]: https://example.com\n`);
  assert.ok(destinations(result).every((href) => !isNotionUrl(href)));
});

test('bare URLs and autolinks cannot turn back into external links after normalization', () => {
  const result = normalizeWorkspaceLinks(`See ${url}.\n<${unknown}>\nwww.notion.so/missing`, known);
  assert.match(result, /\[Career notes\]\(\/context\?document=source-/);
  assert.ok(destinations(result).every((href) => !isNotionUrl(href)));
  assert.equal(normalizeWorkspaceLinks(result, known), result);
});

test('code and unrelated bytes remain exact', () => {
  const source = `\tconst source = "${url}";\r\n\r\n\`${unknown}\`\r\n\r\n\`\`\`md\r\n[Example](${url})\r\n\`\`\`\r\n\r\n[Research](https://example.com)\r\n`;
  assert.equal(normalizeWorkspaceLinks(source, known), source);
  const escaped = 'https\\://notion.so/missing';
  assert.equal(normalizeWorkspaceLinks(escaped, known), escaped);
});

test('accepts manifest UUIDs, API document IDs and known-ID sets', () => {
  const hyphenated = '11111111-1111-1111-1111-111111111111';
  for (const pages of [[{ id: hyphenated }], [{ id: `source-${ID}` }], new Set([ID])]) assert.equal(normalizeWorkspaceLinks(`[Page](${url})`, pages), `[Page](${internal})`);
});

test('existing import notices and media fallback captions no longer instruct external navigation', () => {
  const source = `[Image: Chart (view in Notion)](${url})\n[PDF (view in Notion)](${url})`;
  assert.equal(normalizeWorkspaceLinks(source, known), 'Image: Chart\nPDF');
  const notes = neutralizeImportNotes(['Private or unavailable images are linked to their original Notion page.', 'The generated table of contents or breadcrumb remains available in Notion.', 'Toggle sections are expanded in the local copy.']);
  assert.equal(notes.length, 3);
  assert.ok(notes.every((note) => !/Notion|original.*link/.test(note)));
});
