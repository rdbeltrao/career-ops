import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { PdfEngine } from '../../public/vendor/bentopdf/core.js';
import { commitParagraphText, normalizeParagraphs, paragraphText, readParagraphs, removeParagraphWhitespace, replacementRuns } from '../../public/pdf-editor/model.mjs';

const paragraph = (runs, lines = [{ off: 0 }, { off: 15 }]) => ({
  id: 7, runs, lines, box: { x: 40, top: 700, w: 400, h: 30 },
});
const normalize = (value, text) => normalizeParagraphs([value], { blocks: [{ id: 7, text }] })[0];

test('restores only evidenced whitespace and keeps style runs and line offsets', () => {
  const original = paragraph([
    { text: 'Leadengineering', italic: true, sourceIndex: 0 },
    { text: 'across web', bold: true, sourceIndex: 1 },
    { text: 'and mobile.', italic: true, sourceIndex: 2 },
  ]);
  const before = structuredClone(original);
  const result = normalize(original, 'Lead engineering\r\nacross web and mobile.');
  assert.equal(paragraphText(result), 'Lead engineering across web and mobile.');
  assert.deepEqual(result.runs, [
    { text: 'Lead engineering ', italic: true, sourceIndex: 0 },
    { text: 'across web ', bold: true, sourceIndex: 1 },
    { text: 'and mobile.', italic: true, sourceIndex: 2 },
  ]);
  assert.deepEqual(result.lines, [{ off: 0 }, { off: 17 }]);
  assert.deepEqual(original, before, 'normalization must not mutate the engine model');
  assert.deepEqual(normalize(result, 'Lead engineering\r\nacross web and mobile.'), result);
  const replaced = replacementRuns(result, 'Lead engineering across teams and mobile.');
  assert.equal(replaced.map(run => run.text).join(''), 'Lead engineering across teams and mobile.');
  assert.equal(replaced.find(run => run.text.includes('teams'))?.bold, true);
  assert.equal(replaced.at(-1).italic, true);
});

test('keeps explicit spaces, punctuation, split words, and non-space scripts unchanged', () => {
  for (const [runs, extracted, expected] of [
    [[{ text: 'Hello  world\u00a0again.' }], 'Hello world again.', 'Hello  world\u00a0again.'],
    [[{ text: 'co' }, { text: 'operate, ' }, { text: 'again!' }], 'cooperate, again!', 'cooperate, again!'],
    [[{ text: '设计移动产品。' }], '设计移动\r\n产品。', '设计移动产品。'],
    [[{ text: 'ภาษาไทย' }], 'ภาษา\nไทย', 'ภาษาไทย'],
    [[{ text: 'well-designed' }], 'well-\r\ndesigned', 'well-designed'],
    [[{ text: 'Café🙂teams' }], 'Café🙂 teams', 'Café🙂 teams'],
  ]) assert.equal(paragraphText(normalize(paragraph(runs, []), extracted)), expected);
});

test('rejects mismatched or ambiguous text evidence instead of guessing word boundaries', () => {
  const original = paragraph([{ text: 'Leadengineering' }]);
  assert.deepEqual(normalize(original, 'Lead engineering another column'), original);
  assert.deepEqual(normalizeParagraphs([original], { blocks: [
    { id: 7, text: 'Lead engineering' }, { id: 7, text: 'Leadengineering' },
  ] }), [original]);
  assert.deepEqual(normalizeParagraphs([original], null), [original]);
});

test('reconstruction only borrows whitespace objects inside the same paragraph', () => {
  const characters = [...'Lead'].map(text => ({ text, object: 10 }));
  characters.push({ text: ' ', object: 20 }, { text: ' ', object: 30 });
  characters.push(...[...'engineering'].map(text => ({ text, object: 11 })));
  let closed = false;
  const engine = {
    page: 1,
    buildModel: () => [paragraph([{ text: 'Leadengineering', italic: true }], [])],
    paragraphObjects: () => [10, 11],
    objectBounds: handle => ({ x: handle === 20 ? 70 : 500, y: 680, w: 3, h: 10 }),
    M: {
      _FPDFText_LoadPage: () => 123,
      _FPDFText_CountChars: () => characters.length,
      _FPDFText_GetUnicode: (_, index) => characters[index].text.codePointAt(0),
      _FPDFText_GetTextObject: (_, index) => characters[index].object,
      _FPDFText_ClosePage: () => { closed = true; },
    },
  };
  const [result] = readParagraphs(engine);
  assert.equal(paragraphText(result), 'Lead engineering');
  assert.deepEqual(result.whitespaceObjects, [20]);
  assert.equal(closed, true);
});

test('replacement cleans only validated whitespace after commit and invalidates stale splice export', () => {
  const calls = [];
  const engine = {
    commitParagraph: () => { calls.push('commit'); return true; },
    removeObject: handle => { calls.push(handle); return true; },
    generateContent: () => { calls.push('generate'); return true; },
  };
  const original = { id: 1, whitespaceObjects: [22, 33] };
  assert.equal(commitParagraphText(engine, original, []), true);
  assert.deepEqual(calls, ['commit', 22, 33, 'generate']);
  calls.length = 0;
  engine.commitParagraph = () => false;
  assert.equal(commitParagraphText(engine, original, []), false);
  assert.deepEqual(calls, []);
  engine.removeObject = () => false;
  assert.throws(() => removeParagraphWhitespace(engine, original), /Could not replace/);
  engine.removeObject = () => true;
  engine.generateContent = () => false;
  assert.throws(() => removeParagraphWhitespace(engine, original), /Could not save/);
});

test('Chrome Helvetica Neue italic PDF keeps spaces after extraction, editing, export, and reopening', async () => {
  // Fixture: Chrome page.pdf(), letter page, 40px margins; p width:500px,
  // font:italic 10.5px "Helvetica Neue"; line-height:1.55; text-align:justify.
  // Only "design teams" is enclosed in <b>. All content is fictional.
  const expected = 'Lead engineering across web and mobile products, working with design teams to improve delivery and build reliable services.';
  const engine = await PdfEngine.create();
  try {
    engine.open(new Uint8Array(fs.readFileSync(new URL('../fixtures/pdf-text-spacing.pdf', import.meta.url))));
    const raw = engine.buildModel();
    assert.notEqual(paragraphText(raw[0]), expected, 'fixture must reproduce the native missing-space bug');
    const [original] = readParagraphs(engine);
    assert.equal(paragraphText(original), expected);
    assert.equal(original.runs.length, raw[0].runs.length);
    assert.ok(original.runs.every(run => run.italic));
    const edited = expected.replace('reliable', 'resilient');
    assert.ok(original.whitespaceObjects.length > 0, 'omitted whitespace objects must participate in the replacement');
    assert.ok(engine.editStep('Edit fictional profile', () => commitParagraphText(engine, original, replacementRuns(original, edited))));
    engine.open(await engine.saveSpliced());
    const reopened = readParagraphs(engine);
    assert.equal(reopened.length, 1, 'old space objects must not create extra paragraphs');
    assert.equal(paragraphText(reopened[0]), edited);
    const secondEdit = edited.replace('mobile', 'online');
    assert.ok(engine.editStep('Edit reopened profile', () => commitParagraphText(engine, reopened[0], replacementRuns(reopened[0], secondEdit))));
    engine.open(await engine.saveSpliced());
    assert.equal(readParagraphs(engine).map(paragraphText).join(' '), secondEdit);
    assert.ok(engine.renderPage(1).data.some(channel => channel < 200));
  } finally { engine.close(); }
});
