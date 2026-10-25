import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { PdfEngine } from '../../public/vendor/bentopdf/core.js';
import { commitParagraphText, paragraphText, readParagraphs, replacementRuns } from '../../public/pdf-editor/model.mjs';
import { appendPage, generatedPageMarkerIndices, inspectParagraphLines, removeTrailingPages } from '../../public/pdf-editor/page-engine.mjs';

const fixture = () => new Uint8Array(fs.readFileSync(new URL('../fixtures/pdf-text-spacing.pdf', import.meta.url)));
const canonical = text => text.replace(/\s+/gu, ' ').trim();

test('generated pages retain dimensions, rotation and invisible durable markers after export', async () => {
  const engine = await PdfEngine.create();
  try {
    engine.open(fixture());
    const before = await engine.saveSpliced();
    assert.equal(appendPage(engine, { width: 612, height: 792, rotation: 1 }), 1);
    assert.equal(engine.pageCount, 2);
    engine.loadPage(1);
    assert.equal(engine.pageWidth, 612);
    assert.equal(engine.pageHeight, 792);
    assert.equal(engine.M._FPDFPage_GetRotation(engine.page), 1);
    assert.deepEqual(generatedPageMarkerIndices(engine), [0]);
    assert.equal(readParagraphs(engine).length, 0);
    assert.ok(engine.renderPage(1).data.every(value => value === 255), 'marker must add no visible ink');
    const after = await engine.saveSpliced();
    engine.open(before);
    assert.equal(engine.pageCount, 1, 'full snapshot undo must restore the page tree and cache');
    assert.equal(generatedPageMarkerIndices(engine).length, 0);
    engine.open(after);
    engine.loadPage(1);
    assert.deepEqual(generatedPageMarkerIndices(engine), [0]);
    assert.equal(readParagraphs(engine).length, 0);
    assert.ok(engine.renderPage(1).data.every(value => value === 255));
    assert.equal(removeTrailingPages(engine, 1), 1);
    assert.equal(engine.pageCount, 1);
    assert.equal(engine.pageIndex, 0);
    assert.ok(paragraphText(readParagraphs(engine)[0]).startsWith('Lead engineering'));
    engine.open(await engine.saveSpliced());
    assert.equal(engine.pageCount, 1);
  } finally { engine.close(); }
});

test('native line offsets preserve wide glyphs, surrogate pairs, combining accents and whitespace exactly', async () => {
  // Chrome page.pdf() fixture, Arial14px, width150px, line-height1.6; fictional text only.
  const expected = 'Design 中文🙂 teams café é punctuation… Repeat 中文🙂 delivery with evidence.';
  const engine = await PdfEngine.create();
  try {
    engine.open(new Uint8Array(fs.readFileSync(new URL('../fixtures/pdf-pagination-unicode.pdf', import.meta.url))));
    const [paragraph] = readParagraphs(engine);
    const fragments = inspectParagraphLines(engine, paragraph);
    assert.equal(fragments.length, 4);
    assert.equal(fragments.map(fragment => fragment.text).join(''), expected);
    assert.deepEqual(fragments.map(fragment => fragment.text), [
      'Design 中文🙂 teams ', 'café é punctuation… ', 'Repeat 中文🙂 delivery ', 'with evidence.',
    ]);
    assert.throws(() => inspectParagraphLines(engine, { ...paragraph, lines: [{ ...paragraph.lines[0] }, { ...paragraph.lines[1], off: 10 }] }), /offsets.*safely/);
  } finally { engine.close(); }
});

test('a native text object spanning two measured lines is rejected before transfer', () => {
  const heap = new Float64Array(4);
  const engine = {
    page: 1,
    paragraphObjects: () => [20],
    objectCount: () => 1,
    objectAt: () => ({ handle: 20, type: 1 }),
    objectBounds: () => ({ x: 40, y: 80, w: 60, h: 25 }),
    toModel: (x, y) => ({ x, y }),
    M: {
      HEAPF64: heap, _malloc: () => 0, _free: () => {},
      _FPDFText_LoadPage: () => 2, _FPDFText_ClosePage: () => {},
      _FPDFText_CountChars: () => 2, _FPDFText_GetTextObject: () => 20,
      _FPDFText_GetCharOrigin: (_, index) => { heap[0] = 40; heap[1] = index ? 80 : 100; return 1; },
    },
  };
  assert.throws(() => inspectParagraphLines(engine, {
    id: 1, runs: [{ text: 'AB', size: 12 }], lines: [{ off: 0, y: 100 }, { off: 1, y: 80 }],
  }), /spans multiple lines/);
  assert.throws(() => inspectParagraphLines(engine, {
    id: 1, runs: [{ text: 'AB', size: 12 }], lines: [{ off: 0, y: NaN }],
  }), /geometry/);
});

test('page reclamation preserves original blank pages and refuses generated pages containing content', async () => {
  const engine = await PdfEngine.create();
  try {
    engine.open(fixture());
    const blank = engine.M._FPDFPage_New(engine.doc, 1, 612, 792);
    engine.M._FPDFPage_GenerateContent(blank);
    engine.M._FPDF_ClosePage(blank);
    engine.pageCount = 2;
    engine._spliceOk = false;
    appendPage(engine, { width: 612, height: 792 });
    assert.throws(() => removeTrailingPages(engine, 1), /generated.*empty/i);
    assert.equal(engine.pageCount, 3, 'preflight must reject before deleting any page');
    assert.equal(removeTrailingPages(engine, 2), 1);
    assert.equal(engine.pageCount, 2);
    assert.throws(() => removeTrailingPages(engine, 1), /generated.*empty/i);
    appendPage(engine, { width: 612, height: 792 });
    engine.loadPage(2);
    const path = engine.M._FPDFPageObj_CreateNewRect(40, 40, 10, 10);
    engine.M._FPDFPath_SetDrawMode(path, 2, 0);
    engine.M._FPDFPageObj_SetFillColor(path, 0, 0, 0, 255);
    assert.ok(engine.M._FPDFPage_InsertObjectAtIndex(engine.page, path, engine.objectCount()));
    engine._pageDirty = true;
    engine.generateContent();
    assert.throws(() => removeTrailingPages(engine, 2), /generated.*empty/i);
    assert.equal(engine.pageCount, 3);
  } finally { engine.close(); }
});

test('a failed native page deletion throws so the host can restore its full snapshot', async () => {
  const engine = await PdfEngine.create();
  const remove = engine.M._FPDFPage_Delete;
  try {
    engine.open(fixture());
    appendPage(engine, { width: 612, height: 792 });
    engine.M._FPDFPage_Delete = () => {};
    assert.throws(() => removeTrailingPages(engine, 1), /Could not remove/);
  } finally { engine.M._FPDFPage_Delete = remove; engine.close(); }
});

test('an oversized styled paragraph splits into exhaustive native lines and transfers across appended pages', async () => {
  const engine = await PdfEngine.create();
  try {
    engine.open(fixture());
    let [paragraph] = readParagraphs(engine);
    for (const handle of [...engine.paragraphObjects(paragraph.id), ...paragraph.whitespaceObjects]) engine.translateObject(handle, 0, -600);
    engine.generateContent();
    [paragraph] = readParagraphs(engine);
    const runs = [
      { ...paragraph.runs[0], text: 'Fictional engineering leadership and delivery. '.repeat(130), bold: false, italic: true, rgba: 0x143388ff },
      { ...paragraph.runs[1], text: 'Bold delivery outcomes. '.repeat(50), bold: true, underline: true, rgba: 0x8a207aff },
    ];
    const expected = canonical(runs.map(run => run.text).join(''));
    assert.ok(engine.editStep('Expand fictional paragraph', () => commitParagraphText(engine, paragraph, runs)));
    [paragraph] = readParagraphs(engine);
    const style = run => JSON.stringify([run.family, run.size, run.bold, run.italic, run.underline, run.rgba]);
    const originalStyles = [...new Set(paragraph.runs.map(style))].sort();
    const fragments = inspectParagraphLines(engine, paragraph);
    assert.ok(fragments.length > 60);
    assert.ok(fragments.at(-1).box.top < 0, 'native model must retain off-page content before pagination');
    assert.equal(fragments.map(fragment => fragment.text).join(''), paragraphText(paragraph));
    const indices = fragments.flatMap(fragment => fragment.objectIndices);
    assert.equal(new Set(indices).size, indices.length);
    assert.equal(indices.length, engine.paragraphObjects(paragraph.id).length + (paragraph.whitespaceObjects?.length ?? 0));
    assert.ok(indices.some(index => engine.objectAt(index).type === 2), 'underline paths must travel with text');
    const handles = new Map(indices.map(index => [index, engine.objectAt(index).handle]));
    const fonts = new Map(indices.filter(index => engine.objectAt(index).type === 1)
      .map(index => [handles.get(index), engine.M._FPDFTextObj_GetFont(handles.get(index))]));
    const chunks = [[]];
    let anchor = fragments[0].box.top;
    let available = anchor - 36;
    for (const fragment of fragments) {
      if (anchor - (fragment.box.top - fragment.box.h) > available) {
        chunks.push([]);
        anchor = fragment.box.top;
        available = 720;
      }
      chunks.at(-1).push(fragment);
    }
    assert.ok(chunks.length >= 3, 'fixture must exceed one full continuation page');
    engine.pinnedPages = new Set([0]);
    for (let pageIndex = 1; pageIndex < chunks.length; pageIndex++) {
      assert.equal(appendPage(engine, { width: 612, height: 792 }), pageIndex);
      engine.pinnedPages.add(pageIndex);
      engine.loadPage(0);
      const moving = chunks[pageIndex].flatMap(fragment => fragment.objectIndices).map(index => handles.get(index));
      for (const handle of moving) assert.ok(engine.M._FPDFPage_RemoveObject(engine.page, handle));
      engine._pageDirty = true;
      assert.ok(engine.generateContent());
      engine.loadPage(pageIndex);
      const dy = 756 - chunks[pageIndex][0].box.top;
      for (const handle of moving) {
        assert.ok(engine.M._FPDFPage_InsertObjectAtIndex(engine.page, handle, engine.objectCount()));
        engine.translateObject(handle, 0, dy);
        if (fonts.has(handle)) assert.equal(engine.M._FPDFTextObj_GetFont(handle), fonts.get(handle), 'transfer must retain the original embedded font');
      }
      assert.ok(engine.generateContent());
    }
    engine.open(await engine.saveSpliced());
    assert.equal(engine.pageCount, chunks.length);
    const pages = [];
    const savedStyles = new Set();
    for (let index = 0; index < engine.pageCount; index++) {
      engine.loadPage(index);
      const paragraphs = readParagraphs(engine);
      for (const value of paragraphs) for (const run of value.runs) savedStyles.add(style(run));
      pages.push(paragraphs.map(paragraphText).join(' '));
      assert.ok(paragraphs.every(value => value.box.top <= 792 && value.box.top - value.box.h >= 35));
      if (index > 0) assert.equal(generatedPageMarkerIndices(engine).length, 1);
    }
    assert.equal(canonical(pages.join(' ')), expected, 'all selectable words, spaces and punctuation must survive pagination');
    assert.deepEqual([...savedStyles].sort(), originalStyles, 'font, emphasis, underline and colors must survive export/reopen');
    const [continuation] = readParagraphs(engine);
    const edited = paragraphText(continuation).replace('outcomes', 'results');
    assert.notEqual(edited, paragraphText(continuation));
    assert.ok(engine.editStep('Edit continuation', () => commitParagraphText(engine, continuation, replacementRuns(continuation, edited))));
    engine.open(await engine.saveSpliced());
    engine.loadPage(engine.pageCount - 1);
    assert.match(readParagraphs(engine).map(paragraphText).join(' '), /results/);
  } finally { engine.close(); }
});
