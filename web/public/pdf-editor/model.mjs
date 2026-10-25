// SPDX-License-Identifier: AGPL-3.0-only
// EVIDENCE: BentoPDF editcore models existing PDF paragraphs and commits style runs.
// https://github.com/alam00000/bentopdf/blob/4edb1718cc195a59f0cedb473ca96f30c1bb6f43/src/js/editcore/core.js
export const paragraphText = (paragraph) => paragraph.runs.map((run) => run.text).join('');

const withoutWhitespace = (text) => text.replace(/\s/gu, '');
const noWordSpaces = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function evidencedSpaces(original, extracted) {
  if (withoutWhitespace(original) !== withoutWhitespace(extracted)) return null;
  const additions = new Map();
  let offset = 0;
  for (const match of extracted.matchAll(/\s+|\S/gu)) {
    const value = match[0];
    if (!/^\s/u.test(value)) {
      while (offset < original.length && /\s/u.test(original[offset])) offset++;
      offset += value.length;
      continue;
    }
    // Preserve whitespace already present, including non-breaking and repeated spaces.
    if (!offset || offset >= original.length || /\s/u.test(original[offset])) continue;
    let space = value;
    if (/[\r\n]/u.test(value)) {
      const before = [...original.slice(0, offset)].at(-1);
      const after = String.fromCodePoint(original.codePointAt(offset));
      // A visual line wrap is not a new word boundary in these scripts or compounds.
      space = noWordSpaces.test(before) || noWordSpaces.test(after) || /[-‐‑\u00ad]/u.test(before) ? '' : ' ';
    }
    if (space) additions.set(offset, space);
  }
  return additions;
}

/** Reconcile whitespace only; unmatched content or duplicate block IDs are not evidence. */
export function normalizeParagraphs(paragraphs, pageTextJson) {
  const blocks = new Map();
  for (const block of pageTextJson?.blocks ?? []) {
    blocks.set(block.id, blocks.has(block.id) ? null : block);
  }
  return paragraphs.map((paragraph) => {
    const text = blocks.get(paragraph.id)?.text;
    if (typeof text !== 'string') return paragraph;
    const original = paragraphText(paragraph);
    const additions = evidencedSpaces(original, text);
    if (!additions?.size) return paragraph;
    let offset = 0;
    const runs = paragraph.runs.map((run) => {
      let normalized = '';
      for (const char of run.text) {
        normalized += char;
        offset += char.length;
        normalized += additions.get(offset) ?? '';
      }
      return { ...run, text: normalized };
    });
    return {
      ...paragraph,
      runs,
      lines: paragraph.lines?.map((line) => ({
        ...line,
        off: line.off + [...additions].reduce((count, [at, whitespace]) => count + (at <= line.off ? whitespace.length : 0), 0),
      })),
    };
  });
}

/** Read the current page model, retaining spaces represented by separate PDF objects. */
export function readParagraphs(engine) {
  const paragraphs = engine.buildModel();
  const M = engine.M;
  const textPage = M._FPDFText_LoadPage(engine.page);
  if (!textPage) return paragraphs;
  try {
    // EVIDENCE: PDFium exposes Unicode characters (including generated spaces) and
    // their source objects. Bento can omit whitespace-only objects from paragraphs.
    // https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_text.h
    const characters = [];
    const handles = [];
    const spans = new Map();
    const objectText = new Map();
    const count = M._FPDFText_CountChars(textPage);
    for (let index = 0; index < count; index++) {
      const unicode = M._FPDFText_GetUnicode(textPage, index);
      characters.push(unicode ? String.fromCodePoint(unicode) : '\u0000');
      const object = M._FPDFText_GetTextObject(textPage, index);
      handles.push(object);
      if (object) {
        spans.set(object, [spans.get(object)?.[0] ?? index, index]);
        objectText.set(object, (objectText.get(object) ?? '') + characters.at(-1));
      }
    }
    const objects = new Map(paragraphs.map((paragraph) => [paragraph.id, engine.paragraphObjects(paragraph.id)]));
    const owned = new Set([...objects.values()].flat());
    const unownedSpaces = [...spans].filter(([object]) => !owned.has(object) && /^\s+$/u.test(objectText.get(object)))
      .map(([object, range]) => ({ object, range, bounds: engine.objectBounds(object) }));
    const whitespaceObjects = new Map();
    const blocks = paragraphs.map((paragraph) => {
      const ownObjects = new Set(objects.get(paragraph.id));
      const ranges = [...ownObjects].map((object) => spans.get(object)).filter(Boolean);
      if (!ranges.length) return { id: paragraph.id };
      const [start, end] = ranges.reduce(([first, last], range) => [Math.min(first, range[0]), Math.max(last, range[1])], [Infinity, -1]);
      const omitted = new Set(unownedSpaces.filter(({ range: [first, last], bounds }) => {
        if (first < start || last > end) return false;
        const box = paragraph.box;
        return bounds && bounds.x >= box.x - 1 && bounds.x + bounds.w <= box.x + box.w + 1 &&
          bounds.y >= box.top - box.h - 1 && bounds.y + bounds.h <= box.top + 1;
      }).map(({ object }) => object));
      const text = characters.slice(start, end + 1).filter((char, index) => {
        const object = handles[start + index];
        return !object || !/^\s$/u.test(char) || ownObjects.has(object) || omitted.has(object);
      }).join('');
      if (omitted.size && withoutWhitespace(text) === withoutWhitespace(paragraphText(paragraph))) whitespaceObjects.set(paragraph.id, [...omitted]);
      return { id: paragraph.id, text };
    });
    return normalizeParagraphs(paragraphs, { blocks }).map((paragraph) => whitespaceObjects.has(paragraph.id)
      ? { ...paragraph, whitespaceObjects: whitespaceObjects.get(paragraph.id) }
      : paragraph);
  } finally {
    M._FPDFText_ClosePage(textPage);
  }
}

/** Call inside the caller's existing editStep/snapshot transaction. */
export function commitParagraphText(engine, paragraph, runs, format = paragraph.format) {
  if (!engine.commitParagraph(paragraph.id, runs, format)) return false;
  removeParagraphWhitespace(engine, paragraph);
  return true;
}

/** Call only for replacement/deletion, inside the same editStep as that operation. */
export function removeParagraphWhitespace(engine, paragraph) {
  // Replacing the text must also remove original whitespace objects that editcore
  // did not claim; otherwise export retains them as phantom lines/blank runs.
  for (const object of paragraph.whitespaceObjects ?? []) {
    if (!engine.removeObject(object)) throw new Error('Could not replace the paragraph whitespace. Undo this edit and retry.');
  }
  // The native splice plan covers only native paragraph objects, so it would
  // resurrect these spaces. Regenerate the page to use the complete object state.
  if (paragraph.whitespaceObjects?.length && !engine.generateContent()) {
    throw new Error('Could not save the paragraph whitespace. Undo this edit and retry.');
  }
}

export function replacementRuns(paragraph, text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 12000) {
    throw new Error('Enter between 1 and 12,000 characters for this paragraph.');
  }
  const original = paragraphText(paragraph);
  if (text === original) return paragraph.runs.map((run) => ({ ...run }));
  // Preserve unchanged leading/trailing runs; replacements inherit their insertion style.
  let prefix = 0;
  while (prefix < original.length && prefix < text.length && original[prefix] === text[prefix]) prefix++;
  let suffix = 0;
  while (suffix < original.length - prefix && suffix < text.length - prefix && original.at(-1 - suffix) === text.at(-1 - suffix)) suffix++;
  const slice = (start, end) => {
    let offset = 0;
    const result = [];
    for (const run of paragraph.runs) {
      const from = Math.max(0, start - offset);
      const to = Math.min(run.text.length, end - offset);
      if (to > from) result.push({ ...run, text: run.text.slice(from, to) });
      offset += run.text.length;
    }
    return result;
  };
  const before = slice(0, prefix);
  const after = slice(original.length - suffix, original.length);
  const style = slice(prefix, prefix + 1)[0] ?? before.at(-1) ?? paragraph.runs[0];
  if (!style) throw new Error('This paragraph has no editable text style.');
  const middle = text.slice(prefix, text.length - suffix);
  return [...before, ...(middle ? [{ ...style, text: middle }] : []), ...after];
}

const rectangle = (value) => ({
  x: value.x,
  top: value.top ?? value.yTop,
  w: value.w ?? value.width,
  h: value.h ?? value.height,
});

export function assertReplacementFits(original, preview, paragraphs, pageWidth, pageHeight) {
  if (!preview) throw new Error('This paragraph cannot be edited without changing its layout.');
  const box = rectangle(preview.box ?? preview);
  if (![box.x, box.top, box.w, box.h].every(Number.isFinite)) {
    throw new Error('Could not verify the new paragraph layout.');
  }
  const tolerance = 1;
  if (box.x < -tolerance || box.x + box.w > pageWidth + tolerance || box.top > pageHeight + tolerance || box.top - box.h < -tolerance) {
    throw new Error('This change would extend beyond the page. Shorten the text or use Classic CV Studio to reflow the document.');
  }
  const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > tolerance &&
    Math.min(a.top, b.top) - Math.max(a.top - a.h, b.top - b.h) > tolerance;
  for (const paragraph of paragraphs) {
    if (paragraph.id === original.id || !paragraph.box || paragraph.invisible) continue;
    if (overlap(box, paragraph.box) && !overlap(original.box, paragraph.box)) {
      throw new Error('This change would overlap another paragraph. Shorten the text or use Classic CV Studio to reflow the document.');
    }
  }
  return box;
}
