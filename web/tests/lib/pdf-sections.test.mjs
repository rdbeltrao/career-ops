import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeCvSections, isPageUnderlay, planSectionReorder } from '../../public/pdf-editor/sections.mjs';
import { PdfEngine } from '../../public/vendor/bentopdf/core.js';

const paragraph = (id, text, top, h = 18, x = 50, w = 480) => ({ id, runs: [{ text, size: 12 }], box: { x, top, w, h }, editable: true });
function page(pageIndex, paragraphs, decorations = []) {
  return { pageIndex, width: 612, height: 792, paragraphs,
    objects: [...paragraphs.map((p, index) => ({ index, handle: index + 100, type: 1, box: { ...p.box } })),
      ...decorations.map((decoration, offset) => ({ index: paragraphs.length + offset, handle: paragraphs.length + offset + 100, type: 2, ...decoration }))] };
}
function singlePage() {
  return [page(0, [
    paragraph(1, 'Fictional Candidate', 780),
    paragraph(2, 'Summary', 720), paragraph(3, 'Engineering leader working on reliable systems.', 680, 25),
    paragraph(4, 'Core Competencies', 620), paragraph(5, 'Leadership, software delivery, mentoring.', 580, 25),
    paragraph(6, 'Professional Experience', 520), paragraph(7, 'Senior Engineering Manager — Example Ltd', 480), paragraph(8, 'Led an engineering team and improved delivery.', 450, 50),
    paragraph(9, 'Education', 350), paragraph(10, 'Example University', 310, 25),
  ], [
    { box: { x: 40, top: 729, w: 530, h: 1 } },
    { box: { x: 40, top: 635, w: 530, h: 90 } },
    { box: { x: 35, top: 451, w: 5, h: 8 } },
  ])];
}

function underlay(box, overrides = {}) {
  return { index: 0, handle: 999, type: 2, box, fillColor: { r: 255, g: 255, b: 255, a: 255 },
    pathStyle: { fill: true, stroke: false }, segmentCount: 5, isRect: true, ...overrides };
}

test('main headings group complete sections, bullets, dividers and background objects', () => {
  const pages = singlePage();
  const { sections } = analyzeCvSections(pages);
  assert.deepEqual(sections.map((section) => section.title), ['Summary', 'Core Competencies', 'Professional Experience', 'Education']);
  assert.ok(sections.every((section) => section.movable), JSON.stringify(sections.map((s) => s.reasons)));
  assert.deepEqual(sections[2].fragments[0].paragraphIds, [6, 7, 8]);
  assert.ok(sections[0].fragments[0].objectIndices.includes(10), 'Divider moves with Summary');
  assert.ok(sections[1].fragments[0].objectIndices.includes(11), 'Background moves with Skills');
  assert.ok(sections[2].fragments[0].objectIndices.includes(12), 'Bullet glyph moves with Experience');
  assert.equal(sections.some((section) => section.fragments.some((fragment) => fragment.objectIndices.includes(0))), false, 'Name header stays fixed');
});

test('reorder translates whole sections and intervening sections, preserving their internal geometry', () => {
  const pages = singlePage();
  const { sections } = analyzeCvSections(pages);
  const plan = planSectionReorder(pages, sections[1].id, sections[0].id);
  assert.deepEqual(plan.order, [sections[1].id, sections[0].id, sections[2].id, sections[3].id]);
  assert.deepEqual(new Set(plan.moves.map((move) => move.sectionId)), new Set([sections[0].id, sections[1].id]));
  for (const move of plan.moves) {
    const original = sections.find((section) => section.id === move.sectionId).fragments[0];
    assert.deepEqual(move.objectIndices, original.objectIndices);
    assert.deepEqual(move.paragraphIds, original.paragraphIds);
    assert.equal(move.dx, 0);
    assert.equal(move.box.top, original.box.top + move.dy);
    assert.equal(move.box.h, original.box.h);
  }
  const moved = plan.moves.map((move) => move.box).sort((a, b) => b.top - a.top);
  assert.ok(moved[0].top - moved[0].h >= moved[1].top);
  assert.equal(planSectionReorder(pages, sections[0].id, sections[1].id).moves.length, 0, 'Existing order is a no-op');
});

test('a logical section spanning pages is never exposed or moved as separate page fragments', () => {
  const pages = [
    page(0, [paragraph(1, 'Summary', 730), paragraph(2, 'Profile details.', 690), paragraph(3, 'Experience', 610), paragraph(4, 'First role with several accomplishments.', 560, 200)]),
    page(1, [paragraph(5, 'Second role continues the experience section.', 730, 80), paragraph(6, 'Education', 570), paragraph(7, 'Example degree.', 530)]),
  ];
  const { sections } = analyzeCvSections(pages);
  assert.equal(sections.length, 3);
  const experience = sections[1];
  assert.equal(experience.fragments.length, 2);
  assert.deepEqual(experience.fragments.map((f) => f.paragraphIds), [[3, 4], [5]]);
  const plan = planSectionReorder(pages, experience.id, sections[0].id);
  assert.equal(plan.order[0], experience.id);
  assert.ok(plan.moves.some((move) => move.sectionId === experience.id && move.fromPage === 0));
  // The continuation already occupies its correct destination position, so
  // retaining it in place does not require an artificial native no-op move.
  assert.ok(plan.moves.some((move) => move.sectionId === sections[0].id && move.fromPage === 0 && move.toPage === 1));
});

test('repeated continuation headings remain part of one logical section and page numbers stay fixed', () => {
  const pages = [
    page(0, [paragraph(1, 'Experience', 730), paragraph(2, 'First role.', 680), paragraph(3, 'Page 1 of 2', 25, 12)]),
    page(1, [paragraph(4, 'Experience', 730), paragraph(5, 'Second role.', 680), paragraph(6, 'Education', 600), paragraph(7, 'A degree.', 560), paragraph(8, 'Page 2 of 2', 25, 12)]),
  ];
  const { sections } = analyzeCvSections(pages);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].fragments.length, 2);
  assert.deepEqual(sections[0].fragments[1].paragraphIds, [4, 5]);
  assert.equal(sections.some((s) => s.fragments.some((f) => f.paragraphIds.includes(3) || f.paragraphIds.includes(8))), false);
});

test('ambiguous columns and an object crossing section boundaries fail closed', () => {
  const columns = [page(0, [paragraph(1, 'Skills', 720, 18, 40, 180), paragraph(2, 'JavaScript.', 680, 18, 40, 180), paragraph(3, 'Experience', 720, 18, 300, 250), paragraph(4, 'Engineering role.', 680, 18, 300, 250)])];
  const columnSections = analyzeCvSections(columns).sections;
  assert.ok(columnSections.every((section) => !section.movable));
  assert.throws(() => planSectionReorder(columns, columnSections[0].id, null), /column|ambiguous/i);

  const crossing = singlePage();
  crossing[0].objects.push({ index: 99, handle: 999, type: 2, box: { x: 40, top: 610, w: 530, h: 110 } });
  const sections = analyzeCvSections(crossing).sections;
  assert.equal(sections[1].movable, false);
  assert.equal(sections[2].movable, false);
  assert.throws(() => planSectionReorder(crossing, sections[1].id, sections[0].id), /cross|shared|boundar/i);
});

test('unknown object bounds and section links cannot be silently left behind', () => {
  const unknown = singlePage();
  unknown[0].objects.push({ index: 99, handle: 999, type: 5, box: null });
  assert.ok(analyzeCvSections(unknown).sections.every((section) => !section.movable));
  const linked = singlePage();
  linked[0].annotations = [{ box: { x: 50, top: 680, w: 200, h: 20 } }];
  const sections = analyzeCvSections(linked).sections;
  assert.equal(sections[0].movable, false);
  assert.throws(() => planSectionReorder(linked, sections[0].id, sections[2].id), /link|annotation/i);
});

test('whole-page background stays fixed while section background travels', () => {
  const pages = singlePage();
  pages[0].objects = [underlay({ x: 0, y: 0, w: 612, h: 792 }), ...pages[0].objects.map((object) => ({ ...object, index: object.index + 1 }))];
  const { sections } = analyzeCvSections(pages);
  assert.ok(sections.every((section) => section.movable));
  assert.ok(sections.every((section) => section.fragments.every((fragment) => !fragment.objectIndices.includes(0))));
  assert.ok(sections[1].fragments[0].objectIndices.includes(12));
});

test('generated white content-area underlay stays fixed while real CV sections can move', () => {
  const p = page(0, [
    paragraph(1, 'Fictional Candidate', 780), paragraph(2, 'Summary', 720), paragraph(3, 'Builds reliable software.', 680),
    paragraph(4, 'Skills', 600), paragraph(5, 'Engineering and mentoring.', 560),
  ]);
  p.width = 594.96; p.height = 841.92;
  const background = underlay({ x: 43.5, y: 43.17, w: 509.25, h: 755.25 });
  p.objects = [background, ...p.objects.map((object) => ({ ...object, index: object.index + 1 }))];
  assert.equal(isPageUnderlay(background, p), true);
  assert.equal(isPageUnderlay({ ...background, fillColor: { r: 10, g: 90, b: 180, a: 0 } }, p), true);
  const sections = analyzeCvSections([p]).sections;
  assert.ok(sections.every((section) => section.movable));
  const plan = planSectionReorder([p], sections[1].id, sections[0].id);
  assert.ok(plan.moves.every((move) => !move.objectIndices.includes(0)));
});

test('large meaningful artwork and unproved rectangles are never treated as page underlays', () => {
  const p = singlePage()[0];
  const background = underlay({ x: 0, y: 0, w: 612, h: 792 });
  p.objects = [background, ...p.objects.map((object) => ({ ...object, index: object.index + 1 }))];
  const cases = [
    { fillColor: { r: 40, g: 80, b: 160, a: 255 } }, { pathStyle: { fill: true, stroke: true } },
    { type: 3 }, { isRect: undefined }, { index: 50 }, { isRect: false }, { segmentCount: 7 },
    { box: { x: 100, y: 0, w: 512, h: 792 } },
  ];
  for (const change of cases) {
    const object = { ...background, ...change };
    assert.equal(isPageUnderlay(object, p), false, JSON.stringify(change));
    const analysis = analyzeCvSections([{ ...p, objects: [object, ...p.objects.slice(1)] }]);
    assert.ok(analysis.sections.some((section) => !section.movable));
  }
  assert.equal(isPageUnderlay({ ...background, box: { x: 40, top: 635, w: 530, h: 90 } }, p), false, 'A white section background is still owned by its section');
  assert.equal(isPageUnderlay(background, { ...p, objects: [] }), false, 'Missing paint-order evidence fails closed');
});

test('section artwork below its last paragraph travels, but a footer rule stays fixed', () => {
  const pages = singlePage();
  pages[0].objects.push({ index: 99, handle: 999, type: 3, box: { x: 50, top: 240, w: 150, h: 60 } });
  pages[0].objects.push({ index: 100, handle: 1000, type: 2, box: { x: 50, top: 30, w: 480, h: 1 } });
  const { sections } = analyzeCvSections(pages);
  const education = sections.at(-1);
  assert.ok(education.movable);
  assert.ok(education.fragments[0].objectIndices.includes(99));
  assert.ok(!education.fragments[0].objectIndices.includes(100));
  const plan = planSectionReorder(pages, education.id, sections[0].id);
  assert.ok(plan.moves.find((move) => move.sectionId === education.id).objectIndices.includes(99));
});

test('objects outside the page and artwork-only continuation pages cannot be silently omitted', () => {
  const clipped = singlePage();
  clipped[0].objects.push({ index: 99, handle: 999, type: 2, box: { x: -10, top: 635, w: 590, h: 90 } });
  const clippedSections = analyzeCvSections(clipped).sections;
  assert.equal(clippedSections[1].movable, false);
  assert.throws(() => planSectionReorder(clipped, clippedSections[1].id, clippedSections[0].id), /outside|page|bound/i);

  const pages = [
    page(0, [paragraph(1, 'Experience', 730), paragraph(2, 'First role.', 680)]),
    page(1, [], [{ type: 3, box: { x: 50, top: 700, w: 450, h: 600 } }]),
    page(2, [paragraph(3, 'Another role.', 730), paragraph(4, 'Education', 600), paragraph(5, 'Degree.', 560)]),
  ];
  const { sections } = analyzeCvSections(pages);
  assert.equal(sections[0].movable, false);
  assert.match(sections[0].reasons.join(' '), /artwork|paragraph|continuation/i);
  assert.throws(() => planSectionReorder(pages, sections[0].id, null), /artwork|paragraph|continuation/i);
});

test('oversized sections and transfers that cannot fit existing pages are refused whole', () => {
  const pages = [
    page(0, [paragraph(1, 'Skills', 730), paragraph(2, 'Skills text.', 700, 100), paragraph(3, 'Experience', 560), paragraph(4, 'A tall role block.', 530, 500)]),
    page(1, [paragraph(5, 'Continued role block.', 730, 600), paragraph(6, 'Education', 90), paragraph(7, 'Degree.', 60, 18)]),
  ];
  const { sections } = analyzeCvSections(pages);
  assert.throws(() => planSectionReorder(pages, sections[2].id, sections[0].id), /fit|space|split|page/i);
});

test('native object bounds in bottom-up coordinates and zero-size text glyphs remain supported', () => {
  const pages = singlePage();
  pages[0].objects = pages[0].objects.map((object) => ({ ...object, box: { x: object.box.x, y: object.box.top - object.box.h, w: object.box.w, h: object.box.h } }));
  pages[0].objects.push({ index: 99, handle: 999, type: 1, box: { x: 80, y: 568, w: 0, h: 0 } });
  const { sections } = analyzeCvSections(pages);
  assert.ok(sections[1].fragments[0].objectIndices.includes(99));
  assert.doesNotThrow(() => planSectionReorder(pages, sections[1].id, sections[0].id));
});

test('actual Bento models group native text and divider objects from a fictional PDF', async () => {
  const content = [
    '0.2 0.4 0.8 RG 45 732 m 560 732 l S',
    'BT /F1 16 Tf 50 770 Td (Fictional Candidate) Tj ET',
    'BT /F1 14 Tf 50 710 Td (Summary) Tj ET',
    'BT /F1 12 Tf 50 665 Td (Builds reliable software.) Tj ET',
    'BT /F1 14 Tf 50 600 Td (Skills) Tj ET',
    'BT /F1 12 Tf 50 555 Td (Engineering and mentoring.) Tj ET',
    'BT /F1 14 Tf 50 480 Td (Experience) Tj ET',
    'BT /F1 12 Tf 50 435 Td (Engineering Manager - Example Co) Tj ET',
    'BT /F1 12 Tf 50 400 Td (Led a software team.) Tj ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let source = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source)); source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const engine = await PdfEngine.create();
  try {
    engine.open(new Uint8Array(Buffer.from(source)));
    const paragraphs = engine.buildModel();
    const native = Array.from({ length: engine.objectCount() }, (_, index) => {
      const object = engine.objectAt(index);
      return { ...object, box: engine.objectBounds(object.handle) };
    });
    for (const paragraph of paragraphs) {
      const handles = new Set(engine.paragraphObjects(paragraph.id));
      paragraph.objectIndices = native.filter((object) => handles.has(object.handle)).map((object) => object.index);
    }
    const pages = [{ pageIndex: 0, width: engine.pageWidth, height: engine.pageHeight, paragraphs, objects: native }];
    const { sections } = analyzeCvSections(pages);
    assert.deepEqual(sections.map((section) => section.title), ['Summary', 'Skills', 'Experience']);
    assert.ok(sections.every((section) => section.movable), JSON.stringify(sections.map((section) => section.reasons)));
    assert.ok(sections[0].fragments[0].objectIndices.includes(native.find((object) => object.type === 2).index));
    const plan = planSectionReorder(pages, sections[1].id, sections[0].id);
    assert.equal(plan.moves.length, 2);
    assert.ok(plan.moves.every((move) => move.objectIndices.length > 1));
  } finally { engine.close(); }
});
