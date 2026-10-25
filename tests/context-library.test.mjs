import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readContextLibrary, validateContextManifest, loadContextManifest, filterContextEvidence } from '../lib/context-library.mjs';
import { readContext } from '../lib/context-evidence.mjs';
import { renderContextEvidence } from '../context-evidence.mjs';

const ROOT = 'a'.repeat(32), FACTS = 'b'.repeat(32), PREFERENCES = 'c'.repeat(32), REFERENCE = 'd'.repeat(32), UNKNOWN = 'e'.repeat(32), CHILD = 'f'.repeat(32);
const indexPath = 'data/context-workspace/index.json';
const bodyPath = (id) => `data/context-workspace/pages/${id}.md`;
function manifest() { return { version: 1, rootId: ROOT, pages: [
  { id: ROOT, title: 'Career workspace', parentId: null, order: 0, usage: 'reference' },
  { id: FACTS, title: 'Fictional career', parentId: ROOT, order: 0, usage: 'facts', sourceUrl: 'https://example.com/source', sourceEditedAt: '2026-10-25', importNotes: ['Columns were flattened.'] },
  { id: PREFERENCES, title: 'Targets', parentId: ROOT, order: 1, usage: 'preferences' },
  { id: REFERENCE, title: 'Guide', parentId: ROOT, order: 2 },
  { id: UNKNOWN, title: 'Pending stories', parentId: ROOT, order: 3, usage: 'unconfirmed' },
  { id: CHILD, title: 'Fictional employer', parentId: FACTS, order: 0 },
] }; }
function put(root, relative, text) { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), text); }
function fixture(t, m = manifest()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-library-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  put(root, indexPath, JSON.stringify(m, null, 2) + '\n');
  for (const page of m.pages) put(root, bodyPath(page.id), `${page.title} content.\n`);
  return root;
}

test('authoritative hierarchy preserves every page and inherited role but evidence contains only facts', (t) => {
  const root = fixture(t);
  put(root, bodyPath(FACTS), 'Led 12 engineers.\r\n\r\n## Held for confirmation\r\nSaved 97% of costs.\r\n');
  put(root, bodyPath(PREFERENCES), 'Want a salary of EUR 120000.\n');
  put(root, bodyPath(REFERENCE), 'Example candidate led 77 engineers.\n');
  put(root, bodyPath(UNKNOWN), 'May have saved 88% of costs.\n');
  put(root, bodyPath(CHILD), 'Built 9 services.\n');
  const library = readContextLibrary(root);
  assert.equal(library.source, 'library');
  assert.equal(library.path, path.join(fs.realpathSync(root), indexPath));
  assert.deepEqual(library.pages.map((page) => page.id), [ROOT, FACTS, CHILD, PREFERENCES, REFERENCE, UNKNOWN]);
  assert.deepEqual(library.pages.map((page) => page.usage), ['reference', 'facts', 'facts', 'preferences', 'reference', 'unconfirmed']);
  const page = library.pages.find((page) => page.id === FACTS);
  assert.equal(page.content, 'Led 12 engineers.\r\n\r\n## Held for confirmation\r\nSaved 97% of costs.\r\n');
  assert.deepEqual(page.breadcrumb, ['Career workspace', 'Fictional career']);
  assert.match(library.text, /Career workspace \/ Fictional career/);
  assert.match(library.text, /97%/);
  assert.match(library.text, /77 engineers/);
  assert.match(library.text, /88%/);
  assert.match(library.text, new RegExp(bodyPath(FACTS) + ':1'));
  assert.doesNotMatch(library.text, /https:\/\/example.com\/source/);
  assert.match(library.notice, /not evidence/i);
  assert.match(library.notice, /not.*semantic|does not.*verify/i);
  assert.match(library.evidenceText, /12 engineers/);
  assert.match(library.evidenceText, /9 services/);
  assert.doesNotMatch(library.evidenceText, /97%|120000|77 engineers|88%|Career workspace content/);
  assert.deepEqual(library.files.map((file) => file.relativePath), [bodyPath(FACTS), bodyPath(CHILD)]);
  assert.ok(library.files.every((file) => !/97%|77 engineers|88%/.test(file.text)));
  assert.deepEqual(page.importNotes, ['Columns were flattened.']);
});

test('plain authored libraries default to facts and explicit child roles override inherited roles', (t) => {
  const m = manifest(); delete m.pages[0].usage; delete m.pages[1].usage;
  const root = fixture(t, m); const library = readContextLibrary(root);
  assert.equal(library.pages.find((page) => page.id === REFERENCE).usage, 'facts');
  assert.equal(library.pages.find((page) => page.id === PREFERENCES).usage, 'preferences');
  assert.match(library.evidenceText, /Guide content/);
  assert.doesNotMatch(library.evidenceText, /Targets content/);
});

test('uncertain sections, approximate prose and not-a-claim table rows cannot support facts', () => {
  const full = '# Career\n\nLed 6 engineers.\n\n## Claims to confirm\n\nSaved 91% of costs.\n\n### Detail\nManaged 40 staff.\n\n## Confirmed history\n\nBuilt 8 services.\n\nApproximately 300 users.\n\n| Claim | Status |\n| --- | --- |\n| 44% growth | not a claim |\n\n- 500 stores — user-cannot-confirm\n\n## More evidence\n\nRan 2 services.\n';
  const evidence = filterContextEvidence(full);
  assert.match(evidence, /6 engineers|8 services|2 services/);
  assert.doesNotMatch(evidence, /91%|40 staff|300 users|44%|500 stores/);
  assert.doesNotMatch(filterContextEvidence('Unverified figures\n==================\n\nLed 55 engineers.\n\nConfirmed\n---------\n\nBuilt 3 services.\n'), /55 engineers/);
  assert.doesNotMatch(filterContextEvidence('# Not a claim\n\n99% growth.\n'), /99%/);
  assert.doesNotMatch(filterContextEvidence('About 23 people.\n\n~450 users.\n\nEstimated 80 customers.\n'), /23|450|80/);
});

test('code and HTML examples cannot reopen held sections or supply fact evidence', () => {
  const text = '# Career\n\nLed 4 engineers.\n\n## Unconfirmed\n\n```markdown\n## Confirmed\n```\n\nSaved 92%.\n\n## Actual history\n\nBuilt 7 services.\n\n```text\nLed 88 engineers.\n```\n\n<!-- example 600 users -->\n';
  const evidence = filterContextEvidence(text);
  assert.match(evidence, /4 engineers/); assert.match(evidence, /7 services/);
  assert.doesNotMatch(evidence, /92%|88 engineers|600 users/);
});

test('standalone uncertainty labels, page titles and HTML examples remain outside evidence', (t) => {
  assert.doesNotMatch(filterContextEvidence('**Unconfirmed**\n\nLed 22 engineers.\n'), /22 engineers/);
  assert.doesNotMatch(filterContextEvidence('Pending confirmation\n\nLed 24 engineers.\n'), /24 engineers/);
  assert.doesNotMatch(filterContextEvidence('Career\n\n<!-- unfinished\n\nLed 33 engineers.\n'), /33 engineers/);
  assert.doesNotMatch(filterContextEvidence('Career\n\n<script>\n\nLed 44 engineers.\n\n</script>\n'), /44 engineers/);
  assert.doesNotMatch(filterContextEvidence('Career\n\n<!DOCTYPE html\n\nLed 45 engineers.\n>\n'), /45 engineers/);
  assert.doesNotMatch(filterContextEvidence('Career\n\n    Example led 66 engineers.\n'), /66 engineers/);
  const m = manifest(); m.pages[1].title = 'Claims to confirm'; const root = fixture(t, m);
  put(root, bodyPath(FACTS), '# Candidate history\n\nLed 55 engineers.\n');
  assert.doesNotMatch(readContextLibrary(root).evidenceText, /55 engineers/);
});

test('preferences and future learning sections within a facts page cannot become skills evidence', () => {
  const full = '# Career\n\nBuilt services with PHP.\n\n## Future learning interests\n\nKubernetes, Rust, and Kafka.\n\n### Planned study\n\nDynamoDB.\n\n## Actual work\n\nUsed PostgreSQL.\n\n## Application preferences recorded in May\n\nTarget Azure and 15 direct reports.\n\n## More work\n\nBuilt Redis queues.\n';
  const evidence = filterContextEvidence(full);
  assert.match(evidence, /PHP/); assert.match(evidence, /PostgreSQL/); assert.match(evidence, /Redis/);
  assert.doesNotMatch(evidence, /Kubernetes|Rust|Kafka|DynamoDB|Azure|15 direct reports/);
});

test('container headings and invalid fence closers cannot reopen an unconfirmed subtree', () => {
  const nested = '## Unconfirmed\n\n- Example story\n  ## Confirmed\n  Led a team of 88 engineers.\n';
  const invalidClose = '## Unconfirmed\n\n```text\n```not-a-close\n## Confirmed\nLed a team of 88 engineers.\n```\n';
  const indentedClose = '## Unconfirmed\n\n```text\n    ```\n## Confirmed\nLed a team of 88 engineers.\n```\n';
  const quotedClose = '## Unconfirmed\n\n```text\n> ```\n## Confirmed\nLed a team of 88 engineers.\n```\n';
  const listedClose = '## Unconfirmed\n\n```text\n- ```\n## Confirmed\nLed a team of 88 engineers.\n```\n';
  for (const text of [nested, invalidClose, indentedClose, quotedClose, listedClose]) assert.doesNotMatch(filterContextEvidence(text), /88 engineers/);
});

test('qualified page titles scope implicit descendants but an explicit facts role can override', (t) => {
  const m = manifest(); m.pages[1].title = 'Claims to confirm'; const root = fixture(t, m);
  put(root, bodyPath(CHILD), 'Led 65 engineers.\n');
  assert.doesNotMatch(readContextLibrary(root).evidenceText, /65 engineers/);
  m.pages[5].usage = 'facts'; put(root, indexPath, JSON.stringify(m));
  assert.match(readContextLibrary(root).evidenceText, /65 engineers/);
});

test('empty or entirely held facts pages provide no heading-only evidence', (t) => {
  const root = fixture(t);
  put(root, bodyPath(FACTS), ''); put(root, bodyPath(CHILD), '# History\n\n## Held for confirmation\n\nLed 45 engineers.\n');
  const library = readContextLibrary(root);
  assert.equal(library.evidenceText, ''); assert.deepEqual(library.files, []);
  assert.match(library.text, /45 engineers/);
});

test('readContext and CLI immediately use edited hierarchy instead of stale summaries without writing', (t) => {
  const root = fixture(t); put(root, 'modes/_context.md', 'STALE SUMMARY 999 engineers.\n');
  const before = fs.readFileSync(path.join(root, indexPath), 'utf8');
  assert.equal(readContext(root, { raw: true }).source, 'library');
  assert.doesNotMatch(readContext(root, { raw: true }).text, /STALE SUMMARY/);
  put(root, bodyPath(CHILD), 'Now led 15 engineers.\n');
  const context = readContext(root, { raw: true });
  assert.match(context.text, /15 engineers/); assert.match(context.evidenceText, /15 engineers/);
  const rendered = renderContextEvidence({ dataRoot: root, raw: true });
  assert.equal(rendered.ok, true); assert.match(rendered.text, /15 engineers/);
  assert.doesNotMatch(rendered.text, /modes\/_context\.md is the source of truth/);
  const masked = readContext(root, { mask: true });
  assert.doesNotMatch(masked.text, /15 engineers/);
  assert.match(masked.text, /\[n\] engineers/);
  assert.equal(fs.readFileSync(path.join(root, indexPath), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(root, 'modes/_context.md'), 'utf8'), 'STALE SUMMARY 999 engineers.\n');
});

test('missing library permits legacy context, but malformed library and missing page never fall back', (t) => {
  const root = fixture(t); put(root, 'modes/_context.md', 'Legacy facts.\n');
  fs.unlinkSync(path.join(root, indexPath));
  assert.equal(readContextLibrary(root), null); assert.equal(loadContextManifest(root), null);
  assert.equal(readContext(root).text, 'Legacy facts.');
  put(root, indexPath, '{broken');
  assert.throws(() => readContext(root), (error) => error.code === 'invalid_manifest');
  assert.equal(renderContextEvidence({ dataRoot: root }).ok, false);
  put(root, indexPath, JSON.stringify(manifest())); fs.unlinkSync(path.join(root, bodyPath(REFERENCE)));
  assert.throws(() => readContextLibrary(root), (error) => error.code === 'missing_context_page');
  assert.equal(renderContextEvidence({ dataRoot: root }).ok, false);
  const cli = spawnSync(process.execPath, ['context-evidence.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_MASK_CONTEXT: '0' } });
  assert.equal(cli.status, 1); assert.equal(cli.stdout, ''); assert.match(cli.stderr, /missing/i);
});

test('manifest validation rejects invalid usage, cycles, orphans, duplicate positions and bad provenance', () => {
  for (const corrupt of [
    (m) => { m.version = 2; }, (m) => { m.pages[1].usage = 'verified'; },
    (m) => { m.pages[1].parentId = CHILD; }, (m) => { m.pages[1].parentId = '0'.repeat(32); },
    (m) => { m.pages[2].order = 0; }, (m) => { m.pages[1].id = '../outside'; },
    (m) => { m.pages[1].sourceEditedAt = '2026-02-30'; }, (m) => { m.pages[1].sourceUrl = 'javascript:bad'; },
    (m) => { m.pages[1].importNotes = [42]; },
  ]) { const m = manifest(); corrupt(m); assert.throws(() => validateContextManifest(m), (error) => error.code === 'invalid_manifest'); }
});

test('symlinks, non-UTF8 and oversized bodies fail closed even for reference pages', (t) => {
  const root = fixture(t); const outside = fixture(t);
  fs.unlinkSync(path.join(root, bodyPath(REFERENCE))); fs.symlinkSync(path.join(outside, bodyPath(REFERENCE)), path.join(root, bodyPath(REFERENCE)));
  assert.throws(() => readContextLibrary(root), (error) => error.code === 'unsafe_path');
  fs.unlinkSync(path.join(root, bodyPath(REFERENCE))); put(root, bodyPath(REFERENCE), Buffer.from([0xc3, 0x28]));
  assert.throws(() => readContextLibrary(root), (error) => error.code === 'invalid_encoding');
  put(root, bodyPath(REFERENCE), 'a'.repeat(200001));
  assert.throws(() => readContextLibrary(root), (error) => error.code === 'too_large');
  fs.rmSync(path.join(root, 'data'), { recursive: true }); fs.symlinkSync(path.join(outside, 'data'), path.join(root, 'data'));
  assert.throws(() => readContextLibrary(root), (error) => error.code === 'unsafe_path');
});

test('root aliases work, deep trees and oversized aggregate libraries fail without truncation', (t) => {
  const root = fixture(t); const alias = path.join(root, 'root-alias'); fs.symlinkSync(root, alias);
  assert.equal(readContextLibrary(alias).text, readContextLibrary(root).text);
  const m = manifest(); m.pages = [m.pages[0]];
  let previous = ROOT;
  for (let i = 0; i < 65; i++) { const id = i.toString(16).padStart(32, '0'); m.pages.push({ id, title: 'Nested', parentId: previous, order: 0 }); previous = id; }
  assert.throws(() => validateContextManifest(m), (error) => error.code === 'invalid_manifest');
  m.pages = [m.pages[0]];
  for (let i = 0; i < 101; i++) { const id = i.toString(16).padStart(32, '0'); m.pages.push({ id, title: 'Large page', parentId: ROOT, order: i }); put(root, bodyPath(id), 'x'.repeat(200000)); }
  put(root, indexPath, JSON.stringify(m));
  assert.throws(() => readContextLibrary(root), (error) => error.code === 'too_large');
});
