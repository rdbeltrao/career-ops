// SPDX-License-Identifier: AGPL-3.0-only
const EPSILON = 1e-6;
const DEFAULT_GAP = 8;
const MAX_PAGES = 200;
const bottom = (box) => box.top - box.h;

function rectangle(value, label = 'block') {
  const box = value && { x: value.x, top: value.top, w: value.w, h: value.h };
  if (!box || !Object.values(box).every(Number.isFinite) || box.w < 0 || box.h < 0) {
    throw new Error(`The ${label} has unavailable or invalid layout bounds.`);
  }
  return box;
}
function union(boxes) {
  const x = Math.min(...boxes.map((box) => box.x));
  const top = Math.max(...boxes.map((box) => box.top));
  return { x, top, w: Math.max(...boxes.map((box) => box.x + box.w)) - x, h: top - Math.min(...boxes.map(bottom)) };
}
const overlaps = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > EPSILON &&
  Math.min(a.top, b.top) - Math.max(bottom(a), bottom(b)) > EPSILON;
const gapValue = (value) => {
  if (!Number.isFinite(value) || value < 0) throw new Error('Flow spacing must be finite and nonnegative.');
  return value;
};

/**
 * JUDGMENT: aligned short inline paragraphs form an atomic competency row, not
 * separate vertical paragraphs. Decorative objects should already be owned by
 * their paragraph, or explicitly share rowId; arbitrary overlap is not evidence.
 */
export function groupFlowRows(blocks) {
  const groups = [];
  for (const source of blocks) {
    const block = { ...source, box: rectangle(source.box), objectIndices: [...(source.objectIndices ?? [])], paragraphIds: [...(source.paragraphIds ?? [])] };
    const previous = groups.at(-1);
    const members = previous?.members;
    const sameContext = previous && previous.pageIndex === block.pageIndex && previous.sectionId === block.sectionId &&
      block.kind !== 'heading' && members.every((member) => member.kind !== 'heading' && !member.parts?.length) && !block.parts?.length;
    const explicit = sameContext && block.rowId != null && members.every((member) => member.rowId === block.rowId);
    const inline = sameContext && block.kind !== 'decoration' && block.box.h <= 32 && (block.lineCount ?? 1) === 1 &&
      members.every((member) => member.kind !== 'decoration' && member.box.h <= 32 && (member.lineCount ?? 1) === 1 &&
        Math.abs(member.box.top - block.box.top) <= 2 &&
        Math.min(member.box.x + member.box.w, block.box.x + block.box.w) <= Math.max(member.box.x, block.box.x) + EPSILON);
    if (explicit || inline) {
      members.push(block);
      previous.box = union(members.map((member) => member.box));
    } else groups.push({ ...block, members: [block] });
  }
  return groups.map(({ members, ...group }) => members.length === 1 ? { ...members[0] } : {
    ...group, id: `row:${String(members[0].id)}`, kind: 'row',
    memberIds: members.map((member) => member.id),
    objectIndices: members.flatMap((member) => member.objectIndices),
    paragraphIds: [...new Set(members.flatMap((member) => member.paragraphIds))],
  });
}

function normalizePages(input) {
  if (!Array.isArray(input) || !input.length) throw new Error('The PDF page layout is unavailable.');
  return input.map((page, index) => {
    const { width, height, contentTop, contentBottom } = page;
    if (page.pageIndex !== index || ![width, height, contentTop, contentBottom].every(Number.isFinite) ||
        width <= 0 || height <= 0 || contentBottom < 0 || contentTop > height || contentTop <= contentBottom) {
      throw new Error('The PDF has invalid page or content bounds. Load its complete page layout first.');
    }
    return { index, width, height, contentTop, contentBottom, generated: page.generated === true,
      fixedBoxes: (page.fixedBoxes ?? []).map((box) => rectangle(box, 'fixed content')) };
  });
}

function normalizeBlocks(input, pages) {
  if (!Array.isArray(input)) throw new Error('The ordered PDF flow blocks are unavailable.');
  const ids = new Set();
  const ownership = new Set();
  function identity(block) {
    if (!['string', 'number'].includes(typeof block.id) || ids.has(block.id)) throw new Error('Flow blocks have missing or duplicate identities.');
    ids.add(block.id);
    if (!Number.isInteger(block.pageIndex) || !pages[block.pageIndex]) throw new Error('A flow block references an unavailable source page.');
    if (!Array.isArray(block.objectIndices) || block.objectIndices.some((index) => !Number.isInteger(index) || index < 0)) {
      throw new Error('A flow block has invalid native object identities.');
    }
    if (new Set(block.objectIndices).size !== block.objectIndices.length) throw new Error('A native object is owned more than once by a flow block.');
    return { ...block, box: rectangle(block.box), objectIndices: [...block.objectIndices], paragraphIds: [...(block.paragraphIds ?? [])] };
  }
  return input.map((source, index) => {
    const block = identity(source);
    const previous = input[index - 1];
    block.gapBefore = gapValue(source.gapBefore ?? (previous && previous.pageIndex === block.pageIndex
      ? Math.max(0, bottom(rectangle(previous.box)) - block.box.top) : DEFAULT_GAP));
    block.keepWithNext = source.keepWithNext ?? source.kind === 'heading';
    block.units = source.parts?.length ? source.parts.map((part, partIndex) => {
      const unit = identity({ ...part, pageIndex: part.pageIndex ?? block.pageIndex });
      if (unit.pageIndex !== block.pageIndex || part.parts?.length) throw new Error('Paragraph line parts must belong to one source page without nested parts.');
      const before = source.parts[partIndex - 1];
      unit.gapBefore = partIndex ? gapValue(part.gapBefore ?? Math.max(0, bottom(rectangle(before.box)) - unit.box.top)) : block.gapBefore;
      unit.parentBlockId = block.id;
      return unit;
    }) : [block];
    const objects = block.units.flatMap((unit) => unit.objectIndices);
    if (objects.length !== block.objectIndices.length || new Set(objects).size !== objects.length ||
        objects.some((object) => !block.objectIndices.includes(object))) {
      throw new Error('Paragraph line parts must own every original native object exactly once.');
    }
    for (const object of objects) {
      const key = `${block.pageIndex}:${object}`;
      if (ownership.has(key)) throw new Error('A native PDF object is owned by duplicate flow blocks.');
      ownership.add(key);
    }
    return block;
  });
}

function span(units) {
  return { ...union(units.map((unit) => unit.box)), h: units.reduce((height, unit, index) => height + unit.box.h + (index ? unit.gapBefore : 0), 0) };
}
function slot(page, box, cursor) {
  if (box.x < -EPSILON || box.x + box.w > page.width + EPSILON) return null;
  let top = Math.min(cursor, page.contentTop);
  // Moving below each intersected fixed object makes progress. Headers and
  // footers outside the content area never participate in the flowing body.
  for (let count = 0; count <= page.fixedBoxes.length; count++) {
    if (top - box.h < page.contentBottom - EPSILON) return null;
    const obstacles = page.fixedBoxes.filter((fixed) => overlaps({ ...box, top }, fixed));
    if (!obstacles.length) return top;
    top = Math.min(...obstacles.map(bottom));
  }
  return null;
}

/**
 * EVIDENCE: page fragmentation keeps heading breaks together and permits breaks
 * between paragraph lines. Existing PDF page boundaries are not flow breaks.
 * https://www.w3.org/TR/css-break-3/#breaking-rules
 *
 * Input ownership/order must come from the pre-edit snapshot. Replace only the
 * edited block's geometry/line parts; overlapping expanded text is not new order.
 * Parts must be executable native-object groups, never estimated text slices.
 *
 * EVIDENCE: PDFium creates/deletes pages explicitly. The executor must append
 * matching pages, move objects in one rollback transaction, then delete returned
 * empty generated pages in descending order and reopen the saved document.
 * https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_edit.h
 */
export function planPdfPagination({ pages: inputPages, blocks: inputBlocks, templatePageIndex, continuationPage, maxPages = 20 } = {}) {
  const pages = normalizePages(inputPages);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES || pages.length > maxPages) {
    throw new Error('The PDF exceeds the supported page limit.');
  }
  const originalCount = pages.length;
  const templateSource = pages[templatePageIndex ?? pages.length - 1];
  if (!templateSource) throw new Error('The continuation page template is unavailable.');
  const continuation = normalizePages([{ ...templateSource, ...continuationPage, pageIndex: 0 }])[0];
  // A continuation repeats page scaffolding, not unrelated fixed body artwork.
  // The executor may override its content bounds and fixedBoxes to exclude a
  // first-page-only name/contact header. Explicit obstacles (such as a repeated
  // counter extending into the body) must remain protected. Filter only inherited
  // artwork; existing page bounds remain unchanged.
  const template = { ...continuation, templatePageIndex: templateSource.index,
    fixedBoxes: continuationPage?.fixedBoxes !== undefined ? continuation.fixedBoxes
      : continuation.fixedBoxes.filter((box) => bottom(box) >= continuation.contentTop || box.top <= continuation.contentBottom) };
  const blocks = normalizeBlocks(inputBlocks, pages);
  const placements = [];
  let pagePosition = 0;
  let cursor = pages[0].contentTop;
  let pageHasFlow = false;

  const canFitFresh = (box) => [...pages.slice(pagePosition), template].some((page) => slot(page, box, page.contentTop) !== null);
  function seek(box, gap) {
    let position = slot(pages[pagePosition], box, cursor - (pageHasFlow ? gap : 0));
    while (position === null) {
      pagePosition++;
      if (!pages[pagePosition]) {
        if (slot(template, box, template.contentTop) === null) {
          if (box.x < -EPSILON || box.x + box.w > template.width + EPSILON) throw new Error('This flow block is wider than the available page width.');
          throw new Error('This block cannot fit a page. Supply separate native line parts to split a tall paragraph safely.');
        }
        if (pages.length >= maxPages) throw new Error('This edit exceeds the supported PDF page limit.');
        pages.push({ ...template, index: pages.length, generated: true, fixedBoxes: template.fixedBoxes.map((box) => ({ ...box })) });
      }
      cursor = pages[pagePosition].contentTop;
      pageHasFlow = false;
      position = slot(pages[pagePosition], box, cursor);
    }
    cursor = position;
  }
  function place(unit, gap = unit.gapBefore) {
    seek(unit.box, gap);
    const box = { ...unit.box, top: cursor };
    placements.push({ blockId: unit.id, ...(unit.parentBlockId !== undefined ? { parentBlockId: unit.parentBlockId } : {}),
      fromPage: unit.pageIndex, toPage: pagePosition, objectIndices: [...unit.objectIndices], paragraphIds: [...unit.paragraphIds],
      dx: 0, dy: cursor - unit.box.top, box });
    cursor -= unit.box.h;
    pageHasFlow = true;
  }
  function placeTogether(units) {
    seek(span(units), units[0].gapBefore);
    units.forEach((unit, index) => place(unit, index ? unit.gapBefore : 0));
  }

  for (let index = 0; index < blocks.length; index++) {
    const chain = [blocks[index]];
    while (chain.at(-1).keepWithNext && index + 1 < blocks.length) chain.push(blocks[++index]);
    const units = chain.flatMap((block) => block.units);
    if (canFitFresh(span(units))) {
      placeTogether(units);
    } else if (chain.length > 1) {
      const body = chain.at(-1);
      const headings = chain.slice(0, -1).flatMap((block) => block.units);
      // JUDGMENT: prefer two body lines after a heading. Fall back to one only
      // when the actual page cannot contain that prefix; never orphan a heading.
      let prefix = [...headings, ...body.units.slice(0, 2)];
      if (!canFitFresh(span(prefix))) prefix = [...headings, body.units[0]];
      placeTogether(prefix);
      body.units.slice(prefix.length - headings.length).forEach((unit) => place(unit));
    } else {
      units.forEach((unit) => place(unit));
    }
  }
  const occupied = new Set(placements.map((item) => item.toPage));
  const removedPages = [];
  while (pages.length > 1) {
    const last = pages.at(-1);
    const unmanagedBody = last.fixedBoxes.some((box) => box.top > last.contentBottom && bottom(box) < last.contentTop);
    if (!last.generated || occupied.has(last.index) || unmanagedBody) break;
    removedPages.push(pages.pop().index);
  }
  return {
    pages, addedPages: pages.filter((page) => page.index >= originalCount), removedPages, placements,
    moves: placements.filter((item) => item.fromPage !== item.toPage || Math.abs(item.dy) > EPSILON),
  };
}
