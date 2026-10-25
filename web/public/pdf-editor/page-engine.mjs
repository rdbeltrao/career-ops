// SPDX-License-Identifier: AGPL-3.0-only
import { paragraphText } from './model.mjs';

const GENERATED_PAGE_MARK = 'CareerOpsGeneratedPage';

function forceFullSave(engine) {
  // A stream-splice plan cannot represent changes to the document's page tree.
  engine._spliceOk = false;
  engine._splicePlans = null;
}

function markName(M, mark) {
  const length = M._malloc(4);
  let buffer = 0;
  try {
    if (!M._FPDFPageObjMark_GetName(mark, 0, 0, length)) return '';
    const bytes = M.HEAPU32[length >> 2];
    if (bytes !== (GENERATED_PAGE_MARK.length + 1) * 2) return '';
    buffer = M._malloc(bytes);
    if (!M._FPDFPageObjMark_GetName(mark, buffer, bytes, length)) return '';
    return new TextDecoder('utf-16le').decode(M.HEAPU8.subarray(buffer, buffer + bytes)).replace(/\0$/, '');
  } finally {
    if (buffer) M._free(buffer);
    M._free(length);
  }
}

/** Native indices of this page's invisible provenance markers, never body content. */
export function generatedPageMarkerIndices(engine) {
  const M = engine.M;
  const markers = [];
  const color = M._malloc(16);
  try {
    for (let index = 0; index < engine.objectCount(); index++) {
      const object = engine.objectAt(index);
      if (object.type !== 2) continue;
      const bounds = engine.objectBounds(object.handle);
      if (!bounds || Math.abs(bounds.w) > 0.001 || Math.abs(bounds.h) > 0.001) continue;
      if (!M._FPDFPageObj_GetFillColor(object.handle, color, color + 4, color + 8, color + 12) || M.HEAPU32[(color + 12) >> 2] !== 0) continue;
      if (!M._FPDFPageObj_GetStrokeColor(object.handle, color, color + 4, color + 8, color + 12) || M.HEAPU32[(color + 12) >> 2] !== 0) continue;
      for (let mark = 0; mark < M._FPDFPageObj_CountMarks(object.handle); mark++) {
        if (markName(M, M._FPDFPageObj_GetMark(object.handle, mark)) === GENERATED_PAGE_MARK) {
          markers.push(index);
          break;
        }
      }
    }
  } finally { M._free(color); }
  return markers;
}

/** Append a marked blank page. Width/height are displayed dimensions in points. */
export function appendPage(engine, { width, height, rotation = 0 }) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= 14400) || !Number.isInteger(rotation) || rotation < 0 || rotation > 3) {
    throw new Error('Cannot append a page with invalid dimensions or rotation.');
  }
  const M = engine.M;
  const index = M._FPDF_GetPageCount(engine.doc);
  // EVIDENCE: PDFium transfers page-object ownership on insertion and requires
  // GenerateContent before saving. Appending leaves existing page indices stable.
  // https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_edit.h
  const page = M._FPDFPage_New(engine.doc, index, rotation % 2 ? height : width, rotation % 2 ? width : height);
  if (!page) throw new Error('Could not create the continuation page.');
  let marker = 0;
  let inserted = false;
  let complete = false;
  try {
    M._FPDFPage_SetRotation(page, rotation);
    marker = M._FPDFPageObj_CreateNewRect(0, 0, 0, 0);
    if (!marker) throw new Error('Could not mark the continuation page.');
    M._FPDFPath_SetDrawMode(marker, 2, 0);
    M._FPDFPageObj_SetFillColor(marker, 0, 0, 0, 0);
    M._FPDFPageObj_SetStrokeColor(marker, 0, 0, 0, 0);
    const name = engine._allocStr(GENERATED_PAGE_MARK);
    let mark;
    try { mark = M._FPDFPageObj_AddMark(marker, name); } finally { M._free(name); }
    if (!mark) throw new Error('Could not mark the continuation page.');
    inserted = !!M._FPDFPage_InsertObjectAtIndex(page, marker, 0);
    if (!inserted || !M._FPDFPage_GenerateContent(page)) throw new Error('Could not save the continuation page.');
    complete = true;
  } finally {
    if (marker && !inserted) M._FPDFPageObj_Destroy(marker);
    M._FPDF_ClosePage(page);
    if (!complete) M._FPDFPage_Delete(engine.doc, index);
    engine.pageCount = M._FPDF_GetPageCount(engine.doc);
    forceFullSave(engine);
  }
  return index;
}

/** Remove only an empty, marked suffix. Invalidates all native object handles. */
export function removeTrailingPages(engine, fromIndex) {
  if (!Number.isInteger(fromIndex) || fromIndex < 1 || fromIndex > engine.pageCount) throw new Error('Cannot remove this page range.');
  if (fromIndex === engine.pageCount) return 0;
  const keep = engine.pageIndex;
  const count = engine.pageCount - fromIndex;
  try {
    // Preflight every page before mutating the page tree; original blank pages,
    // annotations and any unmanaged content are deliberately preserved.
    for (let index = fromIndex; index < engine.pageCount; index++) {
      engine.loadPage(index);
      const markers = generatedPageMarkerIndices(engine);
      if (!markers.length || markers.length !== engine.objectCount() || engine.M._FPDFPage_GetAnnotCount(engine.page) !== 0) {
        throw new Error('Only generated, empty continuation pages can be removed.');
      }
    }
  } finally { engine.loadPage(keep); }
  engine.renderParagraphLiveEnd();
  if (!engine.generateContent()) throw new Error('Could not save the page before removing continuation pages.');
  engine.historyClear();
  const M = engine.M;
  const handles = new Set([engine.page, ...(engine._pageCache?.values() ?? [])]);
  for (const handle of handles) if (handle) M._FPDF_ClosePage(handle);
  engine._pageCache?.clear();
  engine.page = 0;
  engine._pageDirty = false;
  engine._pageStale = false;
  for (let index = engine.pageCount - 1; index >= fromIndex; index--) M._FPDFPage_Delete(engine.doc, index);
  engine.pageCount = M._FPDF_GetPageCount(engine.doc);
  forceFullSave(engine);
  if (engine.pageCount !== fromIndex) throw new Error('Could not remove the continuation pages.');
  const bytes = engine.save();
  if (!bytes?.length) throw new Error('Could not save the document after removing continuation pages.');
  // Recreate editcore's per-page models and all cached indices after structural
  // changes. The host transaction owns rollback through full-PDF snapshots.
  engine.open(bytes);
  if (engine.pinnedPages) engine.pinnedPages = new Set([...engine.pinnedPages].filter(index => index < engine.pageCount));
  engine.loadPage(Math.min(keep, engine.pageCount - 1));
  return count;
}

function unionBounds(bounds) {
  const edges = bounds.reduce((value, box) => ({
    left: Math.min(value.left, box.x), right: Math.max(value.right, box.x + box.w),
    top: Math.max(value.top, box.y + box.h), bottom: Math.min(value.bottom, box.y),
  }), { left: Infinity, right: -Infinity, top: -Infinity, bottom: Infinity });
  return { x: edges.left, top: edges.top, w: edges.right - edges.left, h: edges.top - edges.bottom };
}

function isTextBoundary(text, offset) {
  return offset <= 0 || offset >= text.length || !(/[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]));
}

/** Current-page native line fragments; all offsets are UTF-16 string offsets. */
export function inspectParagraphLines(engine, paragraph) {
  if (paragraph.vertical || paragraph.rotation) throw new Error('This rotated paragraph cannot be split into page lines safely.');
  const text = paragraphText(paragraph);
  const lines = paragraph.lines ?? [];
  if (!lines.length) throw new Error('This paragraph has no measurable text lines.');
  const fragments = lines.map((line, index) => {
    if (!Number.isFinite(line.y)) throw new Error('The PDF line geometry cannot be measured safely.');
    const start = line.off;
    const end = lines[index + 1]?.off ?? text.length;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length || !isTextBoundary(text, start) || !isTextBoundary(text, end)) {
      throw new Error('The PDF line offsets cannot preserve this paragraph text safely.');
    }
    return { objectIndices: [], baseline: line.y, box: null, start, end, text: text.slice(start, end) };
  });
  if (fragments.map(fragment => fragment.text).join('') !== text) throw new Error('The PDF line offsets do not cover the complete paragraph.');
  const selected = new Set([...engine.paragraphObjects(paragraph.id), ...(paragraph.whitespaceObjects ?? [])]);
  const objects = [];
  for (let index = 0; index < engine.objectCount(); index++) {
    const object = engine.objectAt(index);
    if (selected.has(object.handle)) objects.push({ ...object, index, bounds: engine.objectBounds(object.handle) });
  }
  if (objects.length !== selected.size || objects.some(object => !object.bounds || !Object.values(object.bounds).every(Number.isFinite))) {
    throw new Error('The paragraph objects changed before pagination.');
  }
  const nearest = y => {
    let best = 0;
    for (let index = 1; index < fragments.length; index++) {
      if (Math.abs(fragments[index].baseline - y) < Math.abs(fragments[best].baseline - y)) best = index;
    }
    return best;
  };
  const origins = new Map();
  const M = engine.M;
  const textPage = M._FPDFText_LoadPage(engine.page);
  const position = M._malloc(16);
  try {
    if (!textPage) throw new Error('Could not inspect the paragraph glyph positions.');
    const count = M._FPDFText_CountChars(textPage);
    for (let index = 0; index < count; index++) {
      const object = M._FPDFText_GetTextObject(textPage, index);
      if (!selected.has(object) || !M._FPDFText_GetCharOrigin(textPage, index, position, position + 8)) continue;
      const point = engine.toModel(M.HEAPF64[position >> 3], M.HEAPF64[(position + 8) >> 3]);
      if (!Number.isFinite(point.y)) throw new Error('The PDF glyph geometry cannot be measured safely.');
      const group = origins.get(object) ?? new Set();
      group.add(nearest(point.y));
      origins.set(object, group);
    }
  } finally {
    M._free(position);
    if (textPage) M._FPDFText_ClosePage(textPage);
  }
  const boundsByLine = fragments.map(() => []);
  const pitch = fragments.slice(1).reduce((minimum, value, index) => Math.min(minimum, Math.abs(value.baseline - fragments[index].baseline)), Infinity);
  for (const object of objects) {
    const assignments = origins.get(object.handle);
    if (assignments?.size > 1) throw new Error('A PDF text object spans multiple lines and cannot be split safely.');
    const line = assignments?.size ? [...assignments][0] : nearest(object.bounds.y + object.bounds.h / 2);
    if (object.type !== 1 && fragments.length > 1) {
      if (object.bounds.h > pitch / 2) throw new Error('A paragraph decoration spans multiple lines and cannot be split safely.');
    }
    fragments[line].objectIndices.push(object.index);
    boundsByLine[line].push(object.bounds);
  }
  const size = paragraph.runs.reduce((maximum, run) => Math.max(maximum, run.size || 0), 1);
  for (let index = 0; index < fragments.length; index++) {
    const line = lines[index];
    fragments[index].box = boundsByLine[index].length ? unionBounds(boundsByLine[index])
      : { x: line.x, top: line.y + size, w: line.w ?? 0, h: size };
  }
  return fragments;
}
