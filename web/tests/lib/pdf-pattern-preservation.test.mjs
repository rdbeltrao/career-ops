import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PdfEngine } from '../../public/vendor/bentopdf/core.js';
import { graphicsTransformAt } from '../../public/vendor/bentopdf/shadingsurgery.js';
import { preparePdfForReflow, captureFlow, reflowDocument } from '../../public/pdf-editor/reflow.mjs';
import { paragraphText, readParagraphs } from '../../public/pdf-editor/model.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function header(engine) {
  engine.loadPage(0);
  const image = engine.renderPage(2);
  return hash(image.data.slice(0, image.width * Math.floor(image.height * .12) * 4));
}
function text(engine) {
  const parts = [];
  for (let index = 0; index < engine.pageCount; index++) {
    engine.loadPage(index); parts.push(readParagraphs(engine).map(paragraphText).join(' '));
  }
  return parts.join(' ').replace(/\s+/g, ' ');
}

test('pattern graphics transforms respect nested save/restore and ignore data tokens', () => {
  assert.deepEqual(graphicsTransformAt('2 0 0 -2 0 800 cm q 1 0 0 1 5 10 cm (q 8 0 0 8 0 0 cm) Tj [4 0 0 4 0 0 (cm)] TJ /q gs % 9 0 0 9 0 0 cm\n'), [2, 0, 0, -2, 10, 780]);
  assert.deepEqual(graphicsTransformAt('2 0 0 -2 0 800 cm q 1 0 0 1 5 10 cm Q'), [2, 0, 0, -2, 0, 800]);
});

test('pattern-looking text remains text and is never isolated as artwork', async () => {
  const content='BT /F1 14 Tf 50 740 Td (Sample q /P1 scn Q /Pattern text) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let source='%PDF-1.4\n';const offsets=[];
  for(const [index,object]of objects.entries()){offsets.push(source.length);source+=`${index+1} 0 obj\n${object}\nendobj\n`;}
  const xref=source.length;source+=`xref\n0 6\n0000000000 65535 f \n${offsets.map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes=new Uint8Array(Buffer.from(source));
  const prepared=await preparePdfForReflow(bytes);
  assert.deepEqual(prepared,bytes);
  const engine=await PdfEngine.create();
  try{engine.open(prepared);assert.equal(text(engine),'Sample q /P1 scn Q /Pattern text');}finally{engine.close();}
});

test('vector pattern protection preserves exact header pixels, editable text, and repeated edit idempotence', async () => {
  const bytes = new Uint8Array(await fs.readFile(new URL('../fixtures/pdf-decorated-cv.pdf', import.meta.url)));
  const engine = await PdfEngine.create();
  try {
    engine.open(bytes); const originalHeader = header(engine), originalText = text(engine);
    const protectedBytes = await preparePdfForReflow(bytes);
    engine.open(protectedBytes);
    assert.equal(header(engine), originalHeader, 'Protection itself must preserve the vector gradient exactly');
    assert.equal(text(engine), originalText, 'Text stays outside the protected Form and remains selectable once');
    assert.deepEqual(await preparePdfForReflow(protectedBytes), protectedBytes, 'Already protected bytes are unchanged');
    for (let iteration = 0; iteration < 2; iteration++) {
      const target = captureFlow(engine).blocks.find(block => block.text.startsWith('Hands-on, thoughtful'));
      const replacement = target.text.replace(iteration ? 'calr' : 'calm', iteration ? 'calm' : 'calr');
      const result = await reflowDocument(engine, { edits: [{ identity: { pageIndex: target.pageIndex, text: target.text, box: target.originalBox }, text: replacement }] });
      const prepared = await preparePdfForReflow(result.bytes);
      engine.open(prepared);
      assert.equal(header(engine), originalHeader, 'Native regeneration preserves the protected vector gradient');
      assert.equal(text(engine), originalText.replace(iteration ? 'calm' : 'calm', iteration ? 'calm' : 'calr'));
      assert.deepEqual(await preparePdfForReflow(prepared), prepared, 'Repeated edits do not nest or grow protected Forms');
    }
  } finally { engine.close(); }
});
