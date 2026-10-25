// SPDX-License-Identifier: AGPL-3.0-only
import { paragraphText } from './model.mjs';

// JUDGMENT: explicit CV labels distinguish main sections from bold employer or
// job-title paragraphs. Unknown labels are not promoted based on font alone.
const HEADING_GROUPS = [
  ['summary', 'professional summary', 'career summary', 'executive summary', 'profile', 'professional profile', 'about me', 'profil', 'resumo', 'resumo profissional'],
  ['skills', 'technical skills', 'core skills', 'key skills', 'core competencies', 'competencies', 'expertise', 'areas of expertise', 'technical expertise', 'key competencies', 'kenntnisse', 'kompetenzen', 'habilidades', 'competencias'],
  ['experience', 'work experience', 'professional experience', 'employment history', 'career history', 'berufserfahrung', 'experiencia profissional'],
  ['education', 'academic background', 'qualifications', 'academic qualifications', 'ausbildung', 'bildung', 'formacao', 'formacao academica'],
  ['certifications', 'certificates', 'professional certifications', 'licenses and certifications', 'certifications and licenses', 'zertifizierungen', 'certificacoes'],
  ['projects', 'selected projects', 'personal projects', 'projekte', 'projetos'],
  ['languages', 'language skills', 'sprachen', 'idiomas'],
  ['publications', 'selected publications'], ['awards', 'honors and awards', 'achievements', 'selected achievements'],
  ['volunteering', 'volunteer experience', 'community involvement'], ['interests', 'personal interests'],
  ['additional information', 'additional experience'], ['references'],
];
const HEADING_KEYS = new Map(HEADING_GROUPS.flatMap((group) => group.map((label) => [label, group[0]])));
const EPSILON = 0.75;
const DEFAULT_GAP = 8;
const PAGE_MARGIN = 24;

function normalized(text) {
  return String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\s*\((?:continued|cont\.?)\)\s*$/, '')
    .replace(/^\s*(?:\d+[.)]|[ivx]{1,4}[.)])\s+/, '').replace(/[&]/g, ' and ')
    .replace(/[\s:|—–-]+$/g, '').replace(/\s+/g, ' ').trim();
}

function rectangle(box) {
  if (!box) return null;
  const result = { x: box.x, top: box.top ?? (box.y + box.h), w: box.w, h: box.h };
  return Object.values(result).every(Number.isFinite) && result.w >= 0 && result.h >= 0 ? result : null;
}
const bottom = (box) => box.top - box.h;
const verticalOverlap = (a, b) => Math.min(a.top, b.top) >= Math.max(bottom(a), bottom(b)) - EPSILON;
const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > EPSILON &&
  Math.min(a.top, b.top) - Math.max(bottom(a), bottom(b)) > EPSILON;
function union(boxes) {
  const x = Math.min(...boxes.map((box) => box.x));
  const top = Math.max(...boxes.map((box) => box.top));
  return { x, top, w: Math.max(...boxes.map((box) => box.x + box.w)) - x, h: top - Math.min(...boxes.map(bottom)) };
}
/**
 * JUDGMENT: generated CVs paint a white rectangle inside the page margins before
 * their text. Keep that native underlay stationary; size alone is never proof.
 * isRect must come from closed axis-aligned native path/matrix inspection, not
 * from its bounding box or segment count. Unknown metadata fails closed.
 */
export function isPageUnderlay(object, page) {
  const box = rectangle(object.box);
  const color = object.fillColor;
  if (object.type !== 2 || object.isRect !== true || ![4, 5].includes(object.segmentCount) ||
      object.pathStyle?.fill !== true || object.pathStyle.stroke !== false ||
      !color || ![color.r, color.g, color.b, color.a].every((value) => Number.isFinite(value) && value >= 0 && value <= 255) ||
      !(color.a === 0 || (color.r === 255 && color.g === 255 && color.b === 255)) ||
      !box || box.w < page.width * 0.6 || box.h < page.height * 0.6 ||
      box.x < -EPSILON || bottom(box) < -EPSILON || box.x + box.w > page.width + EPSILON || box.top > page.height + EPSILON) return false;
  const textObjects = (page.objects ?? []).filter((item) => item.type === 1);
  if (!Number.isInteger(object.index) || object.index < 0 || !(page.objects ?? []).some((item) => item.index === object.index && item.type === 2) ||
      textObjects.some((item) => !Number.isInteger(item.index) || item.index <= object.index)) return false;
  const content = (page.paragraphs ?? []).filter((paragraph) => !paragraph.invisible &&
    (paragraph.text ?? paragraphText(paragraph)).trim()).map((paragraph) => rectangle(paragraph.box));
  const ink = textObjects.map((item) => rectangle(item.box));
  if (content.some((item) => !item) || ink.some((item) => !item)) return false;
  // Running page numbers and marginal headers do not define the body underlay.
  const inBody = (item) => item.top > 36 && bottom(item) < page.height - 24;
  const body = content.filter(inBody);
  const bodyInk = ink.filter((item) => item.w > 0 && item.h > 0 && inBody(item));
  // Logical paragraph boxes include font leading. Only native ink must fit the
  // rectangle. Both models must still account for nonempty body content; a page
  // emptied by reflow can retain its proven white rectangle without any text.
  if ((body.length > 0) !== (bodyInk.length > 0)) return false;
  return bodyInk.every((item) => item.x >= box.x - EPSILON && item.x + item.w <= box.x + box.w + EPSILON &&
    item.top <= box.top + EPSILON && bottom(item) >= bottom(box) - EPSILON);
}
function reason(section, message) { if (!section.reasons.includes(message)) section.reasons.push(message); }

function analyze(pages) {
  if (!Array.isArray(pages)) throw new Error('The PDF page layout is unavailable.');
  const normalizedPages = pages.map((page) => ({
    ...page, paragraphs: (page.paragraphs ?? []).map((paragraph) => ({ ...paragraph, text: paragraphText(paragraph), box: rectangle(paragraph.box) })),
    objects: (page.objects ?? []).map((object) => ({ ...object, box: rectangle(object.box) })),
    fixedParagraphs: [], fragments: [], headings: [], ignoredObjects: new Set(),
  })).sort((a, b) => a.pageIndex - b.pageIndex);
  const pageIds = new Set();
  for (const page of normalizedPages) {
    if (!Number.isInteger(page.pageIndex) || page.pageIndex < 0 || pageIds.has(page.pageIndex) ||
        !Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0) {
      throw new Error('The PDF has an unsupported page layout.');
    }
    pageIds.add(page.pageIndex);
  }
  const repeatedMargins = new Map();
  for (const page of normalizedPages) for (const paragraph of page.paragraphs) {
    if (!paragraph.box || HEADING_KEYS.has(normalized(paragraph.text))) continue;
    if (paragraph.box.top > page.height - 65 || bottom(paragraph.box) < 45) {
      const key = normalized(paragraph.text);
      const occurrences = repeatedMargins.get(key) ?? new Set();
      occurrences.add(page.pageIndex); repeatedMargins.set(key, occurrences);
    }
  }
  const sections = [];
  const issues = [];
  let current = null;
  for (const page of normalizedPages) {
    page.continuation = current;
    page.paragraphs.sort((a, b) => (b.box?.top ?? 0) - (a.box?.top ?? 0) || (a.box?.x ?? 0) - (b.box?.x ?? 0));
    for (const paragraph of page.paragraphs) {
      const key = normalized(paragraph.text);
      const heading = HEADING_KEYS.get(key);
      const box = paragraph.box;
      const inMargin = box && (box.top > page.height - 65 || bottom(box) < 45);
      const pageNumber = box && bottom(box) < 45 && /^(?:page\s*)?\d+(?:\s*(?:of|\/)\s*\d+)?$/.test(key);
      if (!box || paragraph.invisible || !paragraph.text.trim() || pageNumber ||
          (!heading && inMargin && (repeatedMargins.get(key)?.size ?? 0) > 1)) {
        page.fixedParagraphs.push(paragraph); continue;
      }
      if (heading) {
        page.headings.push(paragraph);
        // A repeated heading on a continuation page belongs to the same logical
        // section; it is not a separately draggable fragment of that section.
        if (!current || current.key !== heading || current.fragments.at(-1)?.pageIndex === page.pageIndex) {
          current = { id: `section:${page.pageIndex}:${paragraph.id}`, title: paragraph.text.trim(), key: heading, fragments: [], reasons: [] };
          sections.push(current);
        }
      }
      if (!current) { page.fixedParagraphs.push(paragraph); continue; }
      let fragment = current.fragments.find((item) => item.pageIndex === page.pageIndex);
      if (!fragment) {
        fragment = { pageIndex: page.pageIndex, paragraphIds: [], objectIndices: [], paragraphs: [], boxes: [], section: current };
        current.fragments.push(fragment); page.fragments.push(fragment);
      }
      fragment.paragraphIds.push(paragraph.id); fragment.paragraphs.push(paragraph); fragment.boxes.push(box);
    }
    for (const fragment of page.fragments) fragment.coreBox = union(fragment.boxes);
  }

  for (const page of normalizedPages) {
    // JUDGMENT: an artwork-only continuation cannot be segmented from the
    // paragraph model. Refuse a partial move instead of leaving that page behind.
    if (!page.fragments.length && page.continuation && (page.annotations?.length || page.objects.some((object) =>
      !object.box || (!isPageUnderlay(object, page) && object.box.top > 45 && bottom(object.box) < page.height - 65)))) {
      reason(page.continuation, 'This section has an artwork-only continuation page that cannot be grouped safely.');
    }
    if (page.paragraphs.some((paragraph) => !paragraph.box && !paragraph.invisible && paragraph.text.trim())) {
      for (const fragment of page.fragments) reason(fragment.section, 'Some paragraph bounds are unavailable and cannot be grouped safely.');
    }
    for (const a of page.headings) for (const b of page.headings) {
      if (a === b) continue;
      const horizontal = Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - Math.max(a.box.x, b.box.x);
      if (Math.abs(a.box.x - b.box.x) > 24 && horizontal < Math.min(a.box.w, b.box.w) * 0.25) {
        for (const fragment of page.fragments) reason(fragment.section, 'This page has ambiguous section columns. Use the classic editor to change their order.');
      }
    }
    const explicitlyOwned = new Map();
    for (const fragment of page.fragments) for (const paragraph of fragment.paragraphs) {
      for (const index of paragraph.objectIndices ?? []) {
        const owners = explicitlyOwned.get(index) ?? new Set(); owners.add(fragment); explicitlyOwned.set(index, owners);
      }
    }
    for (const paragraph of page.fixedParagraphs) for (const index of paragraph.objectIndices ?? []) {
      const owners = explicitlyOwned.get(index) ?? new Set(); owners.add(null); explicitlyOwned.set(index, owners);
    }
    const indices = new Set();
    for (const object of page.objects) {
      if (!Number.isInteger(object.index) || object.index < 0 || indices.has(object.index) || !object.box) {
        for (const fragment of page.fragments) reason(fragment.section, 'Some PDF objects have unknown bounds or ambiguous identities and cannot be moved safely.');
        continue;
      }
      indices.add(object.index);
      if (isPageUnderlay(object, page) && !explicitlyOwned.has(object.index)) { page.ignoredObjects.add(object.index); continue; }
      let owners = [...(explicitlyOwned.get(object.index) ?? [])];
      if (!owners.length) {
        owners = page.fragments.filter((fragment) => verticalOverlap(object.box, fragment.coreBox));
        if (page.fixedParagraphs.some((paragraph) => paragraph.box && verticalOverlap(object.box, paragraph.box))) owners.push(null);
      }
      if (!owners.length && page.fragments.length) {
        const distances = page.fragments.map((fragment) => ({ fragment, distance: Math.max(bottom(object.box) - fragment.coreBox.top, bottom(fragment.coreBox) - object.box.top, 0) }))
          .sort((a, b) => a.distance - b.distance);
        const inGap = page.fragments.some((fragment) => bottom(fragment.coreBox) > object.box.top) && page.fragments.some((fragment) => fragment.coreBox.top < bottom(object.box));
        if (distances[0].distance <= 18 || inGap) {
          const tied = distances.filter((entry) => Math.abs(entry.distance - distances[0].distance) <= EPSILON);
          // JUDGMENT: a separator exactly between sections introduces the next
          // heading. Other equally plausible decorations remain ambiguous.
          owners = tied.length > 1 && object.type === 2 && object.box.h <= 3
            ? [tied.find((entry) => entry.fragment.coreBox.top < object.box.top)?.fragment ?? tied[0].fragment]
            : tied.map((entry) => entry.fragment);
        } else {
          // Body artwork after the final paragraph still belongs to that main
          // section. Keep footer decorations in the bottom margin stationary.
          const last = page.fragments.at(-1);
          if (object.box.top < bottom(last.coreBox) && bottom(object.box) >= 45) owners = [last];
        }
      }
      if (owners.length > 1) {
        for (const fragment of owners.filter(Boolean)) reason(fragment.section, 'A shared PDF object crosses section boundaries and cannot be moved as one section.');
      } else if (owners[0]) {
        owners[0].objectIndices.push(object.index); owners[0].boxes.push(object.box);
      }
    }
    for (const fragment of page.fragments) {
      fragment.box = union(fragment.boxes);
      fragment.objectIndices.sort((a, b) => a - b);
      if (fragment.box.x < -EPSILON || fragment.box.x + fragment.box.w > page.width + EPSILON ||
          fragment.box.top > page.height + EPSILON || bottom(fragment.box) < -EPSILON) {
        reason(fragment.section, 'This section contains objects outside its page boundaries and cannot be moved safely.');
      }
      if (!fragment.objectIndices.length) reason(fragment.section, 'The native PDF objects for this section are unavailable.');
      for (const annotation of page.annotations ?? []) {
        const box = rectangle(annotation.box);
        if (!box || overlap(box, fragment.box)) reason(fragment.section, 'This section contains a link or annotation that cannot be moved safely with its text.');
      }
      for (const other of page.fragments) {
        if (other === fragment || !other.box) continue;
        if (overlap(fragment.box, other.box)) {
          reason(fragment.section, 'The PDF section boundaries overlap and need the classic editor.');
          reason(other.section, 'The PDF section boundaries overlap and need the classic editor.');
        }
      }
    }
  }
  for (const section of sections) section.movable = section.reasons.length === 0;
  if (!sections.length) issues.push('No supported CV section headings were found in this PDF.');
  for (const section of sections) for (const message of section.reasons) if (!issues.includes(message)) issues.push(message);
  return { pages: normalizedPages, sections, issues };
}

function publicSection(section) {
  return { id: section.id, title: section.title, movable: section.movable, reasons: [...section.reasons],
    fragments: section.fragments.map((fragment) => ({ pageIndex: fragment.pageIndex, paragraphIds: [...fragment.paragraphIds], objectIndices: [...fragment.objectIndices], box: { ...fragment.box } })) };
}

/**
 * EVIDENCE: Bento models describe paragraphs; PDFium separately exposes native
 * page objects and bounds. Both are needed to keep rules/backgrounds/bullets.
 * https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_edit.h
 * Input objects use native bottom-up bounds {x,y,w,h}; paragraph boxes use top.
 */
export function analyzeCvSections(pages) {
  const analysis = analyze(pages);
  return { sections: analysis.sections.map(publicSection), issues: analysis.issues };
}

/**
 * Reorder logical sections, retaining every fragment's internal geometry and
 * transferring entire fragments between existing pages. This does not split a
 * paragraph, invent a page, or present a continuation fragment as a section.
 * Native execution must snapshot/rollback the full document if any move fails.
 */
export function planSectionReorder(pages, sectionId, beforeSectionId = null) {
  const analysis = analyze(pages);
  const original = analysis.sections;
  const source = original.find((section) => section.id === sectionId);
  if (!source || (beforeSectionId !== null && !original.some((section) => section.id === beforeSectionId))) {
    throw new Error('The section selection is stale. Select the section again.');
  }
  if (sectionId === beforeSectionId) return { order: original.map((section) => section.id), moves: [] };
  const ordered = original.filter((section) => section !== source);
  const target = beforeSectionId === null ? ordered.length : ordered.findIndex((section) => section.id === beforeSectionId);
  ordered.splice(target, 0, source);
  const different = ordered.map((section, index) => section === original[index] ? -1 : index).filter((index) => index >= 0);
  const order = ordered.map((section) => section.id);
  if (!different.length) return { order, moves: [] };
  const first = different[0];
  const last = different.at(-1);
  const affected = original.slice(first, last + 1);
  for (const section of affected) if (!section.movable) throw new Error(section.reasons[0]);
  const fromPage = affected[0].fragments[0].pageIndex;
  const throughPage = affected.at(-1).fragments.at(-1).pageIndex;
  const available = analysis.pages.filter((page) => page.pageIndex >= fromPage && page.pageIndex <= throughPage);
  if (available.length !== throughPage - fromPage + 1) throw new Error('All pages of this section must be loaded before it can move.');
  const affectedIds = new Set(affected.map((section) => section.id));
  const allGaps = [];
  for (const page of available) {
    const fragments = [...page.fragments].sort((a, b) => b.box.top - a.box.top);
    for (let index = 1; index < fragments.length; index++) allGaps.push(Math.max(0, bottom(fragments[index - 1].box) - fragments[index].box.top));
  }
  const gap = Math.min(DEFAULT_GAP, ...allGaps);
  const pageTop = (page) => page.fragments.length
    ? Math.min(page.height - PAGE_MARGIN, Math.max(...page.fragments.map((fragment) => fragment.box.top)))
    : page.height - PAGE_MARGIN;
  const pageBottom = (page) => Math.max(PAGE_MARGIN,
    ...page.fragments.filter((fragment) => !affectedIds.has(fragment.section.id) && original.indexOf(fragment.section) > last).map((fragment) => fragment.box.top + gap),
    ...page.fixedParagraphs.filter((paragraph) => paragraph.box && paragraph.box.top < 70).map((paragraph) => paragraph.box.top + gap));
  let pagePosition = 0;
  let cursor = affected[0].fragments[0].box.top;
  const moves = [];
  function advancePage() {
    pagePosition++;
    if (pagePosition >= available.length) throw new Error('This whole section does not fit in the available pages without splitting its layout. Use the classic editor to repaginate it.');
    cursor = pageTop(available[pagePosition]);
  }
  for (const section of ordered.slice(first, last + 1)) {
    for (const [index, fragment] of section.fragments.entries()) {
      if (index > 0) advancePage();
      while (cursor - fragment.box.h < pageBottom(available[pagePosition]) - EPSILON) advancePage();
      const destination = available[pagePosition];
      if (fragment.box.x < -EPSILON || fragment.box.x + fragment.box.w > destination.width + EPSILON) {
        throw new Error('This section is wider than its destination page. Its layout cannot be preserved.');
      }
      const dy = cursor - fragment.box.top;
      const box = { ...fragment.box, top: cursor };
      if (destination.pageIndex !== fragment.pageIndex || Math.abs(dy) > EPSILON) {
        moves.push({ sectionId: section.id, fromPage: fragment.pageIndex, toPage: destination.pageIndex,
          objectIndices: [...fragment.objectIndices], paragraphIds: [...fragment.paragraphIds], dx: 0, dy, box });
      }
      cursor -= fragment.box.h;
    }
    cursor -= gap;
  }
  const movedObjects = new Set(moves.flatMap((move) => move.objectIndices.map((index) => `${move.fromPage}:${index}`)));
  for (const move of moves) {
    const destination = analysis.pages.find((page) => page.pageIndex === move.toPage);
    for (const object of destination.objects) {
      if (!object.box || destination.ignoredObjects.has(object.index) || movedObjects.has(`${destination.pageIndex}:${object.index}`)) continue;
      if (overlap(move.box, object.box)) throw new Error('This move would overlap content outside the selected sections.');
    }
    for (const other of moves) {
      if (other !== move && other.toPage === move.toPage && other.sectionId !== move.sectionId && overlap(move.box, other.box)) {
        throw new Error('This move would make two sections overlap.');
      }
    }
  }
  return { order, moves };
}
