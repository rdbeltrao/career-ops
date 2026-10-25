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
  await page.waitForFunction(() => window.messages.some((message) => ['ready','error'].includes(message.type)));
  const initialization = await page.evaluate(() => window.messages.find((message) => ['ready','error'].includes(message.type)));
  assert.equal(initialization.type, 'ready', initialization.message);
  const load = await page.evaluate(async (bytes) => command('load', { bytes: new Uint8Array(bytes).buffer, filename: 'fixture.pdf' }), Array.from(syntheticPdf()));
  assert.equal(load.type, 'loaded');
  const emptyUndo=await page.evaluate(()=>command('undo'));
  assert.deepEqual({type:emptyUndo.type,revision:emptyUndo.revision,canUndo:emptyUndo.canUndo,canRedo:emptyUndo.canRedo},{type:'history-state',revision:0,canUndo:false,canRedo:false});
  assert.equal(await page.evaluate(()=>messages.filter(message=>message.type==='changed').length),0,'An empty Undo is not a PDF mutation');
  assert.deepEqual(await page.evaluate(async()=>Array.from(new Uint8Array((await command('export')).bytes))),Array.from(syntheticPdf()),'An empty Undo keeps PDF bytes unchanged');

  await page.frameLocator('iframe').getByRole('button', { name: 'Edit paragraph: Original profile sentence.', exact: true }).click();
  await page.frameLocator('iframe').getByRole('textbox', { name: 'Edit paragraph on page', exact: true }).waitFor({ timeout: 1500 });
  await page.waitForFunction(() => window.messages.some((message) => message.type === 'selection'));
  const selected = await page.evaluate(() => window.messages.filter((message) => message.type === 'selection').at(-1));
  assert.equal(selected.text, 'Original profile sentence.');
  const stale = await page.evaluate((paragraphId) => command('replace', { paragraphId, expectedText: 'stale', text: 'Bad replacement.' }), selected.paragraphId);
  assert.equal(stale.type, 'error');
  assert.match(stale.message, /changed/);
  async function failNextChangedSnapshot() {
    await page.frames().find((frame) => frame.url().includes('/pdf-editor/')).evaluate(async () => {
      const { PdfEngine } = await import('/vendor/bentopdf/core.js');
      const {careerNative}=await import('/vendor/bentopdf/app.js');
      const original = PdfEngine.prototype.saveSpliced;
      let calls = 0;
      PdfEngine.prototype.saveSpliced = async function (...args) {
        if (this===careerNative.engine && ++calls === 2) {
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
  assert.match(await page.frameLocator('iframe').getByRole('textbox', { name: 'Edit paragraph on page' }).innerText(), /Original profile sentence/, 'Failed post-edit snapshot restores the previous PDF');
  assert.equal(await selectionCount(), beforeFailureSelectionCount, 'Failed replacement must not erase the host text draft with a selection event');
  assert.equal(await page.frameLocator('iframe').getByRole('textbox', { name: 'Edit paragraph on page' }).count(), 1, 'Failed replacement keeps the inline editor');
  const replaced = await page.evaluate(async (paragraphId) => {
    const reply = await command('replace', { paragraphId, expectedText: 'Original profile sentence.', text: 'Updated profile sentence.' });
    return { ...reply, bytes: Array.from(new Uint8Array(reply.bytes)) };
  }, selected.paragraphId);
  assert.equal(replaced.type, 'changed', replaced.message);
  assert.equal(replaced.canUndo, true);
  assert.ok(replaced.bytes.length > 0, 'Mutation reply carries a durable PDF snapshot before resolving');
  await page.frameLocator('iframe').getByRole('button', { name: 'Edit paragraph: Updated profile sentence.', exact: true }).waitFor();
  const overflow = await page.evaluate((paragraphId) => command('replace', { paragraphId, expectedText: 'Updated profile sentence.', text: 'Longer text '.repeat(1500) }), selected.paragraphId);
  assert.equal(overflow.type, 'error');
  assert.match(overflow.message, /12,000|12000|characters/);
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
    assert.equal(await page.frameLocator('iframe').getByRole('button', { name: 'Edit paragraph: Updated profile sentence.', exact: true }).count(), 1);
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
    assert.match(await page.frameLocator('iframe').getByRole('textbox', { name: 'Edit paragraph on page' }).innerText(), /Original profile sentence/);
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
    await page.frameLocator('iframe').getByRole('button', { name: 'Next page', exact: true }).click();
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
    await editorFrame.waitForFunction(() => [...document.querySelectorAll('#pageWrap')].every((page) => {
      const rect = page.getBoundingClientRect();
      return rect.left >= 0 && rect.width <= document.documentElement.clientWidth && rect.right <= document.documentElement.clientWidth;
    }));
    assert.equal(await selectionCount(), beforeResizeSelectionCount, 'Resizing must not reset the host text draft');
    assert.match(await page.frameLocator('iframe').getByRole('textbox', { name: 'Edit paragraph on page' }).innerText(), /Second page résumé sentence/, 'Responsive redraw retains the inline editor');
    const afterResize = await page.evaluate(async () => Array.from(new Uint8Array((await command('export')).bytes)));
    engine.open(new Uint8Array(afterResize));
    engine.loadPage(1);
    assert.match(engine.buildModel().map(paragraphText).join('\n'), /Second page résumé sentence/);
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.evaluate(async (bytes) => command('load', { bytes: new Uint8Array(bytes).buffer, filename: 'typing.pdf' }), Array.from(syntheticPdf()));
    const iframe = page.frameLocator('iframe');
    await iframe.getByRole('button', { name: 'Edit paragraph: Original profile sentence.', exact: true }).click({ position: { x: 2, y: 8 } });
    const inline = iframe.getByRole('textbox', { name: 'Edit paragraph on page' });
    await inline.waitFor();
    await page.keyboard.insertText('New ');
    await page.waitForFunction(() => window.messages.some(message => message.type === 'draft' && message.text.startsWith('New Original')));
    await inline.press('End');
    await inline.press('Enter');
    await page.waitForFunction(() => window.messages.filter(message => message.type === 'draft').at(-1)?.text.includes('\n'));
    const breakDraft = await page.evaluate(() => window.messages.filter(message => message.type === 'draft').at(-1));
    assert.ok(breakDraft.inlineState.runs.length, 'Programmatic Enter produces a rich, recoverable draft');
    const typedBytes = await page.evaluate(async () => Array.from(new Uint8Array((await command('export')).bytes)));
    engine.open(new Uint8Array(typedBytes));
    assert.match(engine.buildModel().map(paragraphText).join('\n'), /New\s+Original profile sentence/);

    // A real caret insertion in a multi-page CV must keep the editing viewport stable.
    const typingProducer=await browser.newPage();
    const typingSummary='Detailed profile covering practical engineering, reliable services and thoughtful leadership. '.repeat(4).trim();
    await typingProducer.setContent(`<style>@page{size:letter;margin:50px}body{font:14px Arial;background:white}h1{font-size:28px}h2{font-size:20px}p{line-height:1.45}.next{break-before:page}</style><h1>Fictional Candidate</h1><h2>Professional Summary</h2><p>${typingSummary}</p><h2>Work Experience</h2><p>Delivered software for growing teams.</p><h2 class="next">Education</h2><p>Computer science degree.</p>`);
    const typingPdf=await typingProducer.pdf({preferCSSPageSize:true,printBackground:true});await typingProducer.close();
    await page.evaluate(()=>document.querySelector('iframe').style.height='650px');
    await page.evaluate(async bytes=>command('load',{bytes:new Uint8Array(bytes).buffer,filename:'middle-caret.pdf'}),Array.from(typingPdf));
    await iframe.getByRole('button',{name:/Edit paragraph: Detailed profile/}).click({position:{x:95,y:8}});
    const middleInline=iframe.getByRole('textbox',{name:'Edit paragraph on page'});await middleInline.waitFor();
    const middlePoint=await middleInline.evaluate(ed=>{const walker=document.createTreeWalker(ed,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){const at=node.textContent.indexOf(',');if(at>=0){const range=document.createRange();range.setStart(node,at+1);range.collapse(true);const rect=range.getBoundingClientRect();return {x:rect.x+1,y:rect.y+rect.height/2};}}throw new Error('Expected a visible comma in the summary');});
    const iframeBounds=await page.locator('iframe').boundingBox();await page.mouse.click(iframeBounds.x+middlePoint.x,iframeBounds.y+middlePoint.y);

    const headerPixels=await editorFrame.evaluate(()=>{const canvas=document.getElementById('page');return Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,Math.floor(canvas.height*.1)).data);});
    const beforeTyping=await editorFrame.evaluate(()=>{const stage=document.getElementById('stage'),selection=getSelection(),range=selection.getRangeAt(0),caret=range.getBoundingClientRect(),ed=document.querySelector('[contenteditable="true"]'),prefix=document.createRange();prefix.selectNodeContents(ed);prefix.setEnd(selection.anchorNode,selection.anchorOffset);return {scroll:stage.scrollTop,caret:{x:caret.x,y:caret.y},offset:prefix.toString().length,text:ed.textContent};});
    await page.keyboard.insertText('a');
    await editorFrame.waitForFunction(()=>document.body.classList.contains('live-reflow'));
    await editorFrame.waitForTimeout(400);
    const afterTyping=await editorFrame.evaluate(()=>{const stage=document.getElementById('stage'),range=getSelection().getRangeAt(0),caret=range.getBoundingClientRect();return {scroll:stage.scrollTop,caret:{x:caret.x,y:caret.y},text:document.querySelector('[contenteditable="true"]').textContent};});
    const rasterChecks=await editorFrame.evaluate(before=>{const canvases=[...document.querySelectorAll('.career-reflow-page canvas')];const pixels=canvas=>canvas.getContext('2d').getImageData(0,0,canvas.width,Math.floor(canvas.height*.1)).data;const first=pixels(canvases[0]),last=pixels(canvases.at(-1));return {firstMatchesOriginal:first.length===before.length&&first.every((value,index)=>value===before[index]),pagesDiffer:first.length!==last.length||first.some((value,index)=>value!==last[index])};},headerPixels);
    assert.equal(rasterChecks.pagesDiffer,true,'Each preview page must retain its own raster, not repeat the last PDF page');
    assert.equal(rasterChecks.firstMatchesOriginal,true,'Typing in Summary keeps the unchanged first-page header aligned with its caret');
    assert.ok(Math.abs(afterTyping.scroll-beforeTyping.scroll)<3,`Middle typing keeps scroll position: ${JSON.stringify({before:beforeTyping,after:afterTyping})}`);
    assert.ok(Math.abs(afterTyping.caret.y-beforeTyping.caret.y)<20,'Caret remains on the same visible line after pagination');
    assert.ok(beforeTyping.offset>0&&beforeTyping.offset<beforeTyping.text.length,'The click placed the caret inside the paragraph');
    assert.equal(afterTyping.text,beforeTyping.text.slice(0,beforeTyping.offset)+'a'+beforeTyping.text.slice(beforeTyping.offset),'Typing inserts exactly one character at the clicked position');
    await editorFrame.evaluate(()=>{window.beforeTypingCanvas=document.querySelector('.career-reflow-page canvas');});
    await page.keyboard.insertText('b');
    await editorFrame.waitForFunction(()=>document.querySelector('.career-reflow-page canvas')!==window.beforeTypingCanvas);
    const secondTyping=await editorFrame.evaluate(()=>({scroll:document.getElementById('stage').scrollTop,text:document.querySelector('[contenteditable="true"]').textContent,caretY:getSelection().getRangeAt(0).getBoundingClientRect().y}));
    assert.equal(secondTyping.text,beforeTyping.text.slice(0,beforeTyping.offset)+'ab'+beforeTyping.text.slice(beforeTyping.offset),'Typing after the first preview keeps the same logical caret');
    assert.ok(Math.abs(secondTyping.scroll-beforeTyping.scroll)<3&&Math.abs(secondTyping.caretY-beforeTyping.caret.y)<20,'A later preview preserves the visible editing position');
    await page.evaluate(()=>command('export'));
    await page.evaluate(()=>document.querySelector('iframe').style.height='900px');
    await page.evaluate(async bytes=>command('load',{bytes:new Uint8Array(bytes).buffer,filename:'later-caret.pdf'}),Array.from(typingPdf));
    await page.evaluate(()=>command('page',{pageIndex:1}));
    await iframe.getByRole('button',{name:'Edit paragraph: Computer science degree.',exact:true}).click({position:{x:45,y:8}});
    const laterBefore=await editorFrame.evaluate(()=>getSelection().getRangeAt(0).getBoundingClientRect().y);
    await page.keyboard.insertText('a');await editorFrame.waitForFunction(()=>document.body.classList.contains('live-reflow'));
    const laterAfter=await editorFrame.evaluate(()=>getSelection().getRangeAt(0).getBoundingClientRect().y);
    assert.ok(Math.abs(laterAfter-laterBefore)<20,`Editing page2 must not move its caret offscreen: ${laterBefore} → ${laterAfter}`);
    await editorFrame.evaluate(()=>{window.beforeTypingCanvas=document.querySelector('.career-reflow-page canvas');});
    await editorFrame.evaluate(()=>{window.caretFrames=[];window.caretTraceDone=false;const until=performance.now()+450;const sample=()=>{const selection=getSelection();if(selection?.rangeCount)window.caretFrames.push(selection.getRangeAt(0).getBoundingClientRect().y);if(performance.now()<until)requestAnimationFrame(sample);else window.caretTraceDone=true;};requestAnimationFrame(sample);});
    await page.keyboard.insertText('b');await editorFrame.waitForFunction(()=>document.querySelector('.career-reflow-page canvas')!==window.beforeTypingCanvas);
    await editorFrame.waitForFunction(()=>window.caretTraceDone);
    const caretFrames=await editorFrame.evaluate(()=>window.caretFrames);
    assert.ok(caretFrames.length>5&&caretFrames.every(y=>Math.abs(y-laterBefore)<20),`Every frame must keep the later-page caret visible: ${JSON.stringify(caretFrames)}`);
    const laterSecond=await editorFrame.evaluate(()=>getSelection().getRangeAt(0).getBoundingClientRect().y);
    assert.ok(Math.abs(laterSecond-laterBefore)<20,'Typing after the later-page preview preserves the visible caret');
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition',{text:'é',selectionStart:1,selectionEnd:1});
    await editorFrame.evaluate(()=>{window.composingNode=getSelection().focusNode;window.composingCanvas=document.querySelector('.career-reflow-page canvas');});
    await editorFrame.waitForTimeout(350);
    const duringComposition=await editorFrame.evaluate(async()=>{const {careerNative}=await import('/vendor/bentopdf/app.js');return {composing:careerNative.state.editing.composing,nodeRetained:window.composingNode.isConnected,canvasRetained:document.querySelector('.career-reflow-page canvas')===window.composingCanvas};});
    assert.deepEqual(duringComposition,{composing:true,nodeRetained:true,canvasRetained:true},'A real IME composition keeps its browser-owned buffer while pagination waits');
    await cdp.send('Input.insertText',{text:'é'});await cdp.detach();
    await editorFrame.waitForFunction(()=>document.querySelector('.career-reflow-page canvas')!==window.composingCanvas);
    const committedComposition=await editorFrame.evaluate(async()=>{const {careerNative}=await import('/vendor/bentopdf/app.js');return {composing:careerNative.state.editing.composing,text:careerNative.draft().runs.map(run=>run.text).join('')};});
    assert.equal(committedComposition.composing,false);assert.equal((committedComposition.text.match(/é/g)??[]).length,1,'IME commit retains exactly one composed character');

    await page.evaluate(()=>command('export'));


    // Preview is real on-page ink but does not alter exported bytes or mutation history.
    await page.evaluate(async (bytes) => command('load', { bytes: new Uint8Array(bytes).buffer, filename: 'preview.pdf' }), Array.from(syntheticPdf()));
    const beforePreviewChanges = await page.evaluate(() => window.messages.filter(message => message.type === 'changed').length);
    const proposal = { paragraphId: '0:0', expectedText: 'Original profile sentence.', text: 'Clear profile sentence.' };
    assert.equal((await page.evaluate(target => command('preview-many', { targets: [target] }), proposal)).type, 'previewed');
    await iframe.getByRole('region', { name: 'AI rewrite preview', exact: true }).waitFor();
    await iframe.getByRole('img',{name:/PDF page 1 of/}).click({position:{x:10,y:10}});
    assert.equal(await iframe.getByRole('region', { name:'AI rewrite preview',exact:true }).count(),1,'Clicking the page cannot erase an active proposal');
    const previewBytes = await page.evaluate(async () => Array.from(new Uint8Array((await command('export')).bytes)));
    assert.deepEqual(previewBytes, Array.from(syntheticPdf()));
    assert.equal(await page.evaluate(() => window.messages.filter(message => message.type === 'changed').length), beforePreviewChanges);
    assert.equal((await page.evaluate(() => command('clear-preview'))).type, 'previewed');
    assert.equal(await iframe.getByRole('region', { name: 'AI rewrite preview', exact: true }).count(), 0);
    await editorFrame.evaluate(async()=>{
      const {PdfEngine}=await import('/vendor/bentopdf/core.js');const original=PdfEngine.prototype.renderPage;
      PdfEngine.prototype.renderPage=function(...args){PdfEngine.prototype.renderPage=original;throw new Error('Injected preview failure');};
    });
    const failedPreview=await page.evaluate(target=>command('preview-many',{targets:[target]}),proposal);
    assert.equal(failedPreview.type,'error');assert.equal(failedPreview.message,'Injected preview failure');
    assert.equal(await iframe.locator('.career-ai-preview').count(),0);
    assert.equal(await editorFrame.locator('body.ai-preview').count(),0,'Failed rendering exits preview mode');
    const failedBatch = await page.evaluate(target => command('replace-many', { targets: [target, { paragraphId:'0:1',expectedText:'Untouched experience sentence.',text:'Overflow '.repeat(1500) }] }), proposal);
    assert.equal(failedBatch.type, 'error');
    assert.deepEqual(await page.evaluate(async () => Array.from(new Uint8Array((await command('export')).bytes))), Array.from(syntheticPdf()), 'A failed later paragraph restores the whole batch');
    assert.equal((await page.evaluate(target => command('replace-many', { targets:[target,{paragraphId:'0:1',expectedText:'Untouched experience sentence.',text:'Revised experience sentence.'}] }), proposal)).type, 'changed');
    engine.open(new Uint8Array(await page.evaluate(async () => Array.from(new Uint8Array((await command('export')).bytes)))));
    assert.match(engine.buildModel().map(paragraphText).join('\n'), /Clear profile sentence/);
    assert.match(engine.buildModel().map(paragraphText).join('\n'), /Revised experience sentence/);

    await page.evaluate(async bytes=>command('load',{bytes:new Uint8Array(bytes).buffer,filename:'style.pdf'}),Array.from(syntheticPdf()));
    await iframe.getByRole('button',{name:'Edit paragraph: Original profile sentence.',exact:true}).click();
    const inlineState=await editorFrame.evaluate(async()=>{
      const {careerNative}=await import('/vendor/bentopdf/app.js');const draft=careerNative.draft();
      return {runs:draft.runs.map(run=>({...run,bold:2})),format:draft.format};
    });
    const styleDraft=await page.evaluate(inlineState=>command('restore-draft',{paragraphId:'0:0',expectedText:'Original profile sentence.',text:'Original profile sentence.',inlineState}),inlineState);
    assert.equal(styleDraft.type,'draft');assert.equal(styleDraft.modified,true);
    engine.open(new Uint8Array(await page.evaluate(async()=>Array.from(new Uint8Array((await command('export')).bytes)))));
    assert.ok(engine.buildModel().find(paragraph=>paragraphText(paragraph)==='Original profile sentence.').runs.some(run=>run.bold),'Style-only recovered draft is committed');

    // Keystrokes arriving during Save must be included instead of discarded.
    await page.evaluate(async bytes=>command('load',{bytes:new Uint8Array(bytes).buffer,filename:'save-race.pdf'}),Array.from(syntheticPdf()));
    await iframe.getByRole('button',{name:'Edit paragraph: Original profile sentence.',exact:true}).click();
    await iframe.getByRole('textbox',{name:'Edit paragraph on page'}).fill('First accepted draft.');
    await editorFrame.evaluate(async()=>{
      const {PdfEngine}=await import('/vendor/bentopdf/core.js');const original=PdfEngine.create;
      PdfEngine.create=async function(...args){PdfEngine.create=original;await new Promise(resolve=>{window.releaseScratch=resolve;});return original.apply(this,args);};
    });
    await page.evaluate(()=>{window.raceExport=command('export');});
    await editorFrame.waitForFunction(()=>typeof window.releaseScratch==='function');
    await iframe.getByRole('textbox',{name:'Edit paragraph on page'}).fill('Second draft typed while Save was working.');
    await editorFrame.evaluate(()=>window.releaseScratch());
    const raceReply=await page.evaluate(async()=>{const reply=await window.raceExport;return {...reply,bytes:Array.from(new Uint8Array(reply.bytes))};});
    assert.equal(raceReply.type,'exported',raceReply.message);
    engine.open(new Uint8Array(raceReply.bytes));assert.match(engine.buildModel().map(paragraphText).join(' '),/Second draft typed while Save was working/);

    const sectionProducer = await browser.newPage();
    await sectionProducer.setContent('<style>@page{size:letter;margin:50px}body{font:14px Arial}h2{font-size:20px;margin:0 0 14px}p{margin:0 0 42px}.next{break-before:page}hr{border:0;background:#0066dd;height:3px;margin:0 0 12px}</style><h2>Professional Summary</h2><p>Experienced product leader.</p><h2>Work Experience</h2><p>Delivered reliable services.</p><h2 class="next">Education</h2><hr><p>Computer science degree.</p>'+ '<div style="break-before:page;height:1px"></div>'.repeat(5));
    const sectionPdf = await sectionProducer.pdf({ preferCSSPageSize:true,printBackground:true });
    await sectionProducer.close();
    await page.evaluate(async bytes => command('load',{bytes:new Uint8Array(bytes).buffer,filename:'sections.pdf'}),Array.from(sectionPdf));
    await iframe.getByRole('button',{name:'Next page',exact:true}).click();
    const sectionHandle=iframe.getByRole('button',{name:'Select section: Education',exact:true});
    await sectionHandle.click();
    await page.waitForFunction(()=>window.messages.some(message=>message.type==='section-selection'&&message.title==='Education'));
    const wholeSection=await page.evaluate(()=>window.messages.filter(message=>message.type==='section-selection').at(-1));
    assert.ok(wholeSection.targets.some(target=>target.text==='Computer science degree.'),JSON.stringify(wholeSection));
    const beforeDrag=await page.evaluate(()=>({changes:window.messages.filter(m=>m.type==='changed').length,errors:window.messages.filter(m=>m.type==='error').length}));
    const start=await sectionHandle.boundingBox();
    await page.mouse.move(start.x+start.width/2,start.y+start.height/2);await page.mouse.down();
    await page.mouse.move(start.x+start.width/2+15,start.y+start.height/2+5,{steps:8});
    const target=iframe.getByRole('button',{name:'Drop section before work experience',exact:true});
    await target.waitFor({state:'visible'});
    const destination=await target.boundingBox();
    await page.mouse.move(destination.x+destination.width/2,destination.y+destination.height/2,{steps:15});await page.mouse.up();
    await page.waitForFunction(before=>window.messages.filter(m=>m.type==='changed').length>before.changes||window.messages.filter(m=>m.type==='error').length>before.errors,beforeDrag);
    const dragResult=await page.evaluate(()=>window.messages.filter(m=>['changed','error'].includes(m.type)).at(-1));
    assert.equal(dragResult.type,'changed',dragResult.message);
    const movedBytes=await page.evaluate(async()=>Array.from(new Uint8Array((await command('export')).bytes)));
    engine.open(new Uint8Array(movedBytes));
    assert.equal(engine.pageCount,7,'Reorder remains correct after the six-page native cache evicts early handles');
    const movedText=engine.buildModel().map(paragraphText).join('\n');
    assert.match(movedText,/Computer science degree/);assert.match(movedText,/Delivered reliable services/);
    const bluePixels=image=>Array.from({length:image.data.length/4},(_,i)=>i*4).filter(i=>image.data[i]<60&&image.data[i+1]>60&&image.data[i+1]<150&&image.data[i+2]>160).length;
    assert.ok(bluePixels(engine.renderPage(1))>500,'Section decoration transfers to destination page');
    engine.loadPage(1);
    assert.doesNotMatch(engine.buildModel().map(paragraphText).join('\n'),/Education|Computer science/);
    assert.equal(bluePixels(engine.renderPage(1)),0,'Source page loses the transferred decoration');
    const historyChanges=await page.evaluate(()=>messages.filter(message=>message.type==='changed').length);
    await iframe.locator('#career-undo').click();
    await page.waitForFunction(count=>messages.filter(message=>message.type==='changed').length>count,historyChanges);
    const undoneSection=await page.evaluate(async()=>Array.from(new Uint8Array((await command('export')).bytes)));
    const duplicateUndo=await page.evaluate(()=>command('undo'));
    assert.equal(duplicateUndo.type,'history-state');assert.equal(duplicateUndo.canUndo,false);assert.equal(duplicateUndo.canRedo,true);
    assert.equal(await page.evaluate(()=>messages.filter(message=>message.type==='changed').length),historyChanges+1,'One toolbar Undo creates exactly one restored PDF; duplicate Undo is harmless');
    assert.deepEqual(await page.evaluate(async()=>Array.from(new Uint8Array((await command('export')).bytes))),undoneSection,'Duplicate Undo does not alter the restored section');
    engine.open(new Uint8Array(undoneSection));
    assert.doesNotMatch(engine.buildModel().map(paragraphText).join('\n'),/Computer science/);
    engine.loadPage(1);assert.match(engine.buildModel().map(paragraphText).join('\n'),/Computer science/);
    assert.ok(bluePixels(engine.renderPage(1))>500,'Undo restores both section text and decoration');
    await iframe.locator('#career-redo').click();
    await page.waitForFunction(count=>messages.filter(message=>message.type==='changed').length===count+2,historyChanges);
    engine.open(new Uint8Array(await page.evaluate(async()=>Array.from(new Uint8Array((await command('export')).bytes)))));
    assert.match(engine.buildModel().map(paragraphText).join(' '),/Computer science/,'Redo restores the moved section again');
    assert.ok(bluePixels(engine.renderPage(1))>500,'Redo restores its decoration on the destination page');
  } finally { engine.close(); }
  assert.deepEqual(errors, []);
  assert.ok(requests.every((url) => url.startsWith(origin)), 'No document, font or editor request leaves localhost');
});
