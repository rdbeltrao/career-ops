// SPDX-License-Identifier: AGPL-3.0-only
// EVIDENCE: BentoPDF editcore models existing PDF paragraphs and commits style runs.
// https://github.com/alam00000/bentopdf/blob/4edb1718cc195a59f0cedb473ca96f30c1bb6f43/src/js/editcore/core.js
export const paragraphText = (paragraph) => paragraph.runs.map((run) => run.text).join('');

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
