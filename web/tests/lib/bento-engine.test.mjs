import assert from 'node:assert/strict';
import test from 'node:test';
import { PdfEngine } from '../../public/vendor/bentopdf/core.js';
import { replacementRuns, paragraphText, assertReplacementFits } from '../../public/pdf-editor/model.mjs';

export function syntheticPdf() {
  const stream = 'BT /F1 14 Tf 50 740 Td (Original profile sentence.) Tj 0 -70 Td (Untouched experience sentence.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body));
}

test('BentoPDF changes existing PDF text and round-trips selectable text and pixels', async () => {
  const engine = await PdfEngine.create();
  try {
    engine.open(syntheticPdf());
    const paragraphs = engine.buildModel();
    const original = paragraphs.find((paragraph) => paragraphText(paragraph).includes('Original profile'));
    assert.ok(original?.editable);
    const runs = replacementRuns(original, 'Updated profile sentence.');
    const preview = engine.previewParagraph(original.id, runs, original.format);
    assertReplacementFits(original, preview, paragraphs, engine.pageWidth, engine.pageHeight);
    assert.ok(engine.editStep('Update selected paragraph', () => engine.commitParagraph(original.id, runs, original.format)));
    const saved = await engine.saveSpliced();
    assert.equal(new TextDecoder().decode(saved.slice(0, 5)), '%PDF-');
    engine.open(saved);
    const text = engine.buildModel().map(paragraphText).join('\n');
    assert.match(text, /Updated profile sentence\./);
    assert.match(text, /Untouched experience sentence\./);
    assert.doesNotMatch(text, /Original profile sentence\./);
    const image = engine.renderPage(1);
    assert.equal(image.width, 612);
    assert.equal(image.height, 792);
    assert.ok(image.data.some((channel) => channel < 200), 'Saved PDF has actual visible ink');
  } finally {
    engine.close();
  }
});

test('Rejects replacement geometry that would overlap another paragraph or leave the page', () => {
  const original = { id: 1, box: { x: 50, top: 740, w: 200, h: 20 } };
  const other = { id: 2, box: { x: 50, top: 690, w: 200, h: 20 } };
  assert.throws(() => assertReplacementFits(original, { x: 50, top: 740, width: 200, height: 70 }, [original, other], 612, 792), /overlap/i);
  assert.throws(() => assertReplacementFits(original, { x: 50, top: 740, width: 200, height: 750 }, [original], 612, 792), /page/i);
});

test('BentoPDF iframe loads local assets, selects, rewrites, exports and undoes real PDF text', {
  skip: process.env.BENTO_BROWSER_TEST !== '1',
  timeout: 90_000,
}, async (t) => {
  const { createServer } = await import('node:http');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { chromium } = await import('playwright-core');
  const publicRoot = fileURLToPath(new URL('../../public/', import.meta.url));
  const session = 'bento-test-session';
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<iframe title="Editor" src="/pdf-editor/index.html?session=${session}" style="width:900px;height:900px"></iframe><script>
        window.messages=[];window.addEventListener('message',e=>window.messages.push(e.data));
        window.command=(type,payload={})=>new Promise((resolve,reject)=>{
          const requestId=crypto.randomUUID();const timeout=setTimeout(()=>reject(new Error('Editor reply timed out: '+type)),15000);
          const listener=e=>{if(e.data.requestId===requestId){clearTimeout(timeout);window.removeEventListener('message',listener);resolve(e.data)}};
          window.addEventListener('message',listener);document.querySelector('iframe').contentWindow.postMessage({channel:'career-ops-pdf-editor',session:'${session}',type,requestId,...payload},location.origin);
        });
      </script>`);
      return;
    }
    try {
      const file = path.resolve(publicRoot, '.' + pathname);
      if (!file.startsWith(publicRoot)) throw new Error('Outside fixture root');
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.ttf': 'font/ttf' }[path.extname(file)] ?? 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.end(await fs.readFile(file));
    } catch { res.statusCode = 404; res.end('not found'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const requests = [];
  const errors = [];
  page.on('request', (req) => requests.push(req.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.waitForFunction(() => window.messages.some((message) => message.type === 'ready'));
  const load = await page.evaluate(async (bytes) => command('load', { bytes: new Uint8Array(bytes).buffer, filename: 'fixture.pdf' }), Array.from(syntheticPdf()));
  assert.equal(load.type, 'loaded');
  await page.frameLocator('iframe').getByRole('button', { name: 'Edit paragraph: Original profile sentence.', exact: true }).click();
  await page.waitForFunction(() => window.messages.some((message) => message.type === 'selection'));
  const selected = await page.evaluate(() => window.messages.filter((message) => message.type === 'selection').at(-1));
  assert.equal(selected.text, 'Original profile sentence.');
  const stale = await page.evaluate((paragraphId) => command('replace', { paragraphId, expectedText: 'stale', text: 'Bad replacement.' }), selected.paragraphId);
  assert.equal(stale.type, 'error');
  assert.match(stale.message, /changed/);
  async function failNextChangedSnapshot() {
    await page.frames().find((frame) => frame.url().includes('/pdf-editor/')).evaluate(async () => {
      const { PdfEngine } = await import('/vendor/bentopdf/core.js');
      const original = PdfEngine.prototype.saveSpliced;
      let calls = 0;
      PdfEngine.prototype.saveSpliced = async function (...args) {
        if (++calls === 2) {
          PdfEngine.prototype.saveSpliced = original;
          throw new Error('Injected snapshot failure');
        }
        return original.apply(this, args);
      };
    });
  }
  const selectionCount = () => page.evaluate(() => window.messages.filter((message) => message.type === 'selection').length);
  const beforeFailureSelectionCount = await selectionCount();
  await failNextChangedSnapshot();
  const failedSnapshot = await page.evaluate((paragraphId) => command('replace', { paragraphId, expectedText: 'Original profile sentence.', text: 'Unrecoverable edit sentence.' }), selected.paragraphId);
  assert.equal(failedSnapshot.type, 'error');
  assert.equal(failedSnapshot.message, 'Injected snapshot failure');
  assert.equal(await page.frameLocator('iframe').getByRole('button', { name: 'Edit paragraph: Original profile sentence.', exact: true }).count(), 1, 'Failed post-edit snapshot restores the previous PDF');
  assert.equal(await selectionCount(), beforeFailureSelectionCount, 'Failed replacement must not erase the host text draft with a selection event');
  assert.equal(await page.frameLocator('iframe').getByRole('button', { name: 'Edit paragraph: Original profile sentence.', exact: true, pressed: true }).count(), 1, 'Failed replacement keeps the visual selection');
  const replaced = await page.evaluate(async (paragraphId) => {
    const reply = await command('replace', { paragraphId, expectedText: 'Original profile sentence.', text: 'Updated profile sentence.' });
    return { ...reply, bytes: Array.from(new Uint8Array(reply.bytes)) };
  }, selected.paragraphId);
  assert.equal(replaced.type, 'changed', replaced.message);
  assert.equal(replaced.canUndo, true);
  assert.ok(replaced.bytes.length > 0, 'Mutation reply carries a durable PDF snapshot before resolving');
  await page.waitForFunction(() => window.messages.filter((message) => message.type === 'selection').at(-1)?.text === 'Updated profile sentence.');
  const overflow = await page.evaluate((paragraphId) => command('replace', { paragraphId, expectedText: 'Updated profile sentence.', text: 'Longer text '.repeat(500) }), selected.paragraphId);
  assert.equal(overflow.type, 'error');
  assert.match(overflow.message, /page|overlap/);
  const exported = await page.evaluate(async () => Array.from(new Uint8Array((await command('export')).bytes)));
  const engine = await PdfEngine.create();
  try {
    engine.open(new Uint8Array(replaced.bytes));
    assert.match(engine.buildModel().map(paragraphText).join('\n'), /Updated profile sentence/);
    engine.open(new Uint8Array(exported));
    const text = engine.buildModel().map(paragraphText).join('\n');
    assert.match(text, /Updated profile sentence/);
    assert.doesNotMatch(text, /Original profile sentence/);
    assert.match(text, /Untouched experience sentence/);
    const beforeUndoFailureSelectionCount = await selectionCount();
    await failNextChangedSnapshot();
    assert.equal((await page.evaluate(() => command('undo'))).type, 'error');
    assert.equal(await selectionCount(), beforeUndoFailureSelectionCount, 'Failed undo must not erase the host draft');
    assert.equal(await page.frameLocator('iframe').getByRole('button', { name: 'Edit paragraph: Updated profile sentence.', exact: true, pressed: true }).count(), 1);
    const failedUndoBytes = await page.evaluate(async () => Array.from(new Uint8Array((await command('export')).bytes)));
    engine.open(new Uint8Array(failedUndoBytes));
    assert.match(engine.buildModel().map(paragraphText).join('\n'), /Updated profile sentence/);
    const undoReply = await page.evaluate(async () => {
      const reply = await command('undo');
      return { ...reply, bytes: Array.from(new Uint8Array(reply.bytes)) };
    });
    assert.equal(undoReply.type, 'changed');
    engine.open(new Uint8Array(undoReply.bytes));
    assert.match(engine.buildModel().map(paragraphText).join('\n'), /Original profile sentence/);
    const undone = await page.evaluate(async () => Array.from(new Uint8Array((await command('export')).bytes)));
    engine.open(new Uint8Array(undone));
    assert.match(engine.buildModel().map(paragraphText).join('\n'), /Original profile sentence/);
    await page.frameLocator('iframe').getByRole('button', { name: 'Edit paragraph: Original profile sentence.', exact: true }).click();
    await page.waitForFunction(() => window.messages.filter((message) => message.type === 'selection').at(-1)?.text === 'Original profile sentence.');
    const beforeRedoFailureSelectionCount = await selectionCount();
    await failNextChangedSnapshot();
    assert.equal((await page.evaluate(() => command('redo'))).type, 'error');
    assert.equal(await selectionCount(), beforeRedoFailureSelectionCount, 'Failed redo must not erase the host draft');
    assert.equal(await page.frameLocator('iframe').getByRole('button', { name: 'Edit paragraph: Original profile sentence.', exact: true, pressed: true }).count(), 1);
    const failedRedoBytes = await page.evaluate(async () => Array.from(new Uint8Array((await command('export')).bytes)));
    engine.open(new Uint8Array(failedRedoBytes));
    assert.match(engine.buildModel().map(paragraphText).join('\n'), /Original profile sentence/);
    assert.equal((await page.evaluate(() => command('redo'))).type, 'changed');
    assert.equal(await page.frameLocator('iframe').getByRole('button', { name: 'Edit paragraph: Updated profile sentence.', exact: true }).count(), 1);

    // Chromium-generated PDFs use embedded subset fonts, like career-ops exports.
    const producer = await browser.newPage();
    await producer.setContent('<style>@page {size:letter;margin:50px}body{font:14px Arial}p{margin:0 0 70px}.next{break-before:page}</style><p>First page original sentence.</p><p class="next">Second page original sentence.</p>');
    const twoPages = await producer.pdf({ preferCSSPageSize: true });
    await producer.close();
    const secondLoad = await page.evaluate(async (bytes) => command('load', { bytes: new Uint8Array(bytes).buffer, filename: 'two-pages.pdf' }), Array.from(twoPages));
    assert.equal(secondLoad.pageCount, 2);
    await page.frameLocator('iframe').getByRole('button', { name: 'Edit paragraph: Second page original sentence.', exact: true }).click();
    await page.waitForFunction(() => window.messages.filter((message) => message.type === 'selection').at(-1)?.text === 'Second page original sentence.');
    const secondSelection = await page.evaluate(() => window.messages.filter((message) => message.type === 'selection').at(-1));
    const secondEdit = await page.evaluate((paragraphId) => command('replace', { paragraphId, expectedText: 'Second page original sentence.', text: 'Second page résumé sentence.' }), secondSelection.paragraphId);
    assert.equal(secondEdit.type, 'changed', secondEdit.message);
    const finalBytes = await page.evaluate(async () => Array.from(new Uint8Array((await command('export')).bytes)));
    engine.open(new Uint8Array(finalBytes));
    assert.equal(engine.pageCount, 2);
    assert.match(engine.buildModel().map(paragraphText).join('\n'), /First page original sentence/);
    engine.loadPage(1);
    const finalText = engine.buildModel().map(paragraphText).join('\n');
    assert.match(finalText, /Second page résumé sentence/);
    assert.doesNotMatch(finalText, /Second page original sentence/);
    await page.frameLocator('iframe').getByRole('button', { name: 'Edit paragraph: Second page résumé sentence.', exact: true }).click();
    await page.waitForFunction(() => window.messages.filter((message) => message.type === 'selection').at(-1)?.text === 'Second page résumé sentence.');
    const beforeResizeSelectionCount = await selectionCount();
    await page.evaluate(() => { document.querySelector('iframe').style.maxWidth = '100%'; });
    await page.setViewportSize({ width: 390, height: 844 });
    const editorFrame = page.frames().find((frame) => frame.url().includes('/pdf-editor/'));
    await editorFrame.waitForFunction(() => [...document.querySelectorAll('.page')].every((page) => {
      const rect = page.getBoundingClientRect();
      return rect.left >= 0 && rect.width <= document.documentElement.clientWidth - 28 && rect.right <= document.documentElement.clientWidth;
    }));
    assert.equal(await selectionCount(), beforeResizeSelectionCount, 'Resizing must not reset the host text draft');
    assert.equal(await page.frameLocator('iframe').getByRole('button', { name: 'Edit paragraph: Second page résumé sentence.', exact: true, pressed: true }).count(), 1, 'Responsive redraw retains the selected paragraph');
    const afterResize = await page.evaluate(async () => Array.from(new Uint8Array((await command('export')).bytes)));
    engine.open(new Uint8Array(afterResize));
    engine.loadPage(1);
    assert.match(engine.buildModel().map(paragraphText).join('\n'), /Second page résumé sentence/);
  } finally { engine.close(); }
  assert.deepEqual(errors, []);
  assert.ok(requests.every((url) => url.startsWith(origin)), 'No document, font or editor request leaves localhost');
});
