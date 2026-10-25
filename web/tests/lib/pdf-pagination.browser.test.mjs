import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PdfEngine } from '../../public/vendor/bentopdf/core.js';
import { paragraphText, readParagraphs } from '../../public/pdf-editor/model.mjs';

const url = process.env.PDF_PAGINATION_TEST_URL;
const root = process.env.PDF_PAGINATION_TEST_ROOT;
const normalize = text => text.replace(/\s+/g, ' ').trim();

async function openFixture(t) {
  const origin = new URL(url);
  assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname));
  const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(root));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.equal(fs.readFileSync(path.join(root, '.pagination-pdf-fixture'), 'utf8').trim(), 'fictional-only');
  const file = path.join(root, 'output/cv-fixture-alpha.pdf');
  const original = fs.readFileSync(file);
  t.after(() => fs.writeFileSync(file, original));
  const engine = await PdfEngine.create();
  t.after(() => engine.close());
  const inspect = () => {
    engine.open(new Uint8Array(fs.readFileSync(file)));
    return Array.from({ length: engine.pageCount }, (_, pageIndex) => {
      engine.loadPage(pageIndex);
      return { width: engine.pageWidth, height: engine.pageHeight,
        paragraphs: readParagraphs(engine).map(p => ({ text: paragraphText(p), box: p.box })) };
    });
  };
  assert.equal(inspect().length, 1);
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  page.on('console', message => { if (message.type() === 'error') console.log(`Browser error: ${message.text()}`); });
  await page.addInitScript(() => window.addEventListener('message', event => {
    if (event.data?.channel === 'career-ops-pdf-editor' && event.data.type === 'error') console.error(`PDF editor: ${event.data.message}`);
  }));
  await page.goto(`${origin.origin}/documents`);
  await page.getByRole('link', { name: /Classic editor/ }).waitFor();
  await page.goto(`${origin.origin}/pipeline/11/cv-visual`);
  const frame = page.frameLocator('iframe[title="Editable PDF pages"]');
  const paragraph = text => frame.getByRole('button', { name: `Edit paragraph: ${text}`, exact: true });
  const inline = () => frame.getByRole('textbox', { name: 'Edit paragraph on page', exact: true });
  return { file, original, inspect, page, frame, paragraph, inline, errors };
}

test('visual CV grows pages, reflows following sections, and retains typing and recovery', { skip: !url || !root, timeout: 120_000 }, async t => {
  const { file, original, inspect, page, frame, paragraph, inline, errors } = await openFixture(t);
  await paragraph('Engineering leader building reliable products.').click();
  const expanded = Array.from({ length: 90 }, (_, i) => `Fictional example ${String(i + 1).padStart(3, '0')} describes engineering work with reliable products.`).join(' ');
  await inline().fill(expanded);
  // The page count must change while the live editing buffer is still open.
  await frame.locator('#career-page').filter({ hasText: /of [2-9]\d*/ }).waitFor();
  assert.equal(await inline().isVisible(), true);
  await frame.getByRole('img', { name: /^PDF page 2 of/ }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'pagination-live-page-2.png') });
  await inline().press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await inline().pressSequentially(' Final sentence after automatic pagination.');
  const finalText = `${expanded} Final sentence after automatic pagination.`;
  assert.ok(normalize(await inline().innerText()) === finalText, 'Typing after pagination appends at the requested caret position');
  assert.equal(fs.readFileSync(file).equals(original), true, 'Live reflow does not save the candidate PDF');
  await page.goBack();
  await page.getByRole('heading', { name: 'Documents', exact: true }).waitFor();
  await page.goForward();
  await page.getByText('Recovered your unsaved changes from this device.').waitFor();
  assert.ok(normalize(await inline().innerText()) === finalText, 'Typing after pagination appends at the requested caret position');
  await page.getByRole('button', { name: 'Save PDF', exact: true }).click();
  await page.getByText('PDF saved. The previous version is available below.').waitFor();
  const saved = inspect();
  fs.copyFileSync(file, path.join(root, 'paginated-result.pdf'));
  assert.ok(saved.length > 1);
  const savedText = normalize(saved.flatMap(p => p.paragraphs.map(p => p.text)).join(' '));
  for (let i = 1; i <= 90; i++) assert.equal(savedText.split(`Fictional example ${String(i).padStart(3, '0')}`).length - 1, 1);
  assert.ok(savedText.includes('Final sentence after automatic pagination.'));
  assert.ok(savedText.includes('Work Experience'));
  assert.ok(savedText.includes('Fictional education entry for a browser test.'));
  assert.ok(savedText.indexOf('Final sentence after automatic pagination.') < savedText.indexOf('Work Experience'));
  for (const sheet of saved) for (const p of sheet.paragraphs) {
    assert.ok(p.box.top <= sheet.height - 35 && p.box.top - p.box.h >= 35, 'Paragraph keeps the CV top and bottom margins');
    assert.ok(p.box.x >= 35 && p.box.x + p.box.w <= sheet.width - 35, 'Paragraph keeps the CV left and right margins');
  }
  await page.screenshot({ path: path.join(root, 'paginated-cv.png'), fullPage: true });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await frame.locator('#career-page').filter({ hasText: 'of 1' }).waitFor();
  await paragraph('Engineering leader building reliable products.').waitFor();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await frame.locator('#career-page').filter({ hasText: /of [2-9]\d*/ }).waitFor();
  assert.deepEqual(errors, []);
});


test('AI pagination previews reject cleanly and a moved long section keeps every paragraph', { skip: !url || !root, timeout: 120_000 }, async t => {
  const { file, original, inspect, page, frame, paragraph, errors } = await openFixture(t);
  const originalText = 'Engineering leader building reliable products.';
  const expanded = Array.from({ length: 65 }, () => originalText).join(' ');
  await paragraph(originalText).click();
  await page.evaluate(() => localStorage.setItem('career-ops:config', JSON.stringify({ cliId: 'codex' })));
  await page.route('**/api/documents/*/rewrite', route => {
    const body = route.request().postDataJSON();
    assert.equal(body.targets.length, 1);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ replacements: [{ paragraphId: body.targets[0].paragraphId, text: expanded }], warning: null }) });
  });
  await page.getByLabel('What should change?').fill('Expand the description using the existing facts.');
  await page.getByRole('button', { name: 'Preview with AI', exact: true }).click();
  await page.getByRole('button', { name: 'Reject', exact: true }).waitFor();
  await frame.locator('#career-page').filter({ hasText: /of [2-9]\d*/ }).waitFor();
  await frame.getByRole('img', { name: /^PDF page 2 of/ }).waitFor();
  assert.equal(fs.readFileSync(file).equals(original), true);
  await page.screenshot({ path: path.join(root, 'pagination-ai-preview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await frame.locator('#career-page').filter({ hasText: 'of 1' }).waitFor();
  assert.equal(await frame.getByRole('img', { name: /^PDF page 2 of/ }).count(), 0);
  await paragraph(originalText).waitFor();
  assert.equal(fs.readFileSync(file).equals(original), true);
  await page.getByRole('button', { name: 'Preview with AI', exact: true }).click();
  await page.getByRole('button', { name: 'Accept changes', exact: true }).click();
  await page.getByRole('button', { name: 'Save PDF', exact: true }).click();
  await page.getByText('PDF saved. The previous version is available below.').waitFor();
  const grown = inspect();
  assert.ok(grown.length > 1);
  assert.equal(normalize(grown.flatMap(p => p.paragraphs.map(p => p.text)).join(' ')).split(originalText).length - 1, 65);
  const handle = frame.getByRole('button', { name: 'Select section: Professional Summary', exact: true });
  await handle.scrollIntoViewIfNeeded();
  const start = await handle.boundingBox();
  assert.ok(start);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 20, start.y + start.height / 2 + 10, { steps: 5 });
  const destination = frame.getByRole('button', { name: 'Drop section at end', exact: true });
  await destination.waitFor({ state: 'visible' });
  const drop = await destination.boundingBox();
  assert.ok(drop);
  await page.mouse.move(drop.x + drop.width / 2, drop.y + drop.height / 2, { steps: 12 });
  await page.mouse.up();
  await frame.getByText(/Section moved/).waitFor();
  await page.getByRole('button', { name: 'Save PDF', exact: true }).click();
  await page.getByText('PDF saved. The previous version is available below.').waitFor();
  const moved = inspect();
  const text = normalize(moved.flatMap(p => p.paragraphs.map(p => p.text)).join(' '));
  assert.ok(text.indexOf('Education') < text.indexOf('Professional Summary'));
  assert.equal(text.split(originalText).length - 1, 65);
  assert.ok(text.includes('Lead engineering across web and mobile products, working with design teams to improve delivery and build reliable services.'));
  for (const sheet of moved) for (const p of sheet.paragraphs) {
    assert.ok(p.box.top <= sheet.height - 35 && p.box.top - p.box.h >= 35);
    assert.ok(p.box.x >= 35 && p.box.x + p.box.w <= sheet.width - 35);
  }
  // Generated-page lineage must survive a fresh editor load. Shortening all
  // continuation fragments should reclaim its now-empty trailing pages.
  await page.reload();
  await frame.locator('#career-page').filter({ hasText: /of [2-9]\d*/ }).waitFor();
  for (let i = 0; i < moved.length && !(await handle.count()); i++) await frame.locator('#career-next').click();
  await handle.click();
  await page.unroute('**/api/documents/*/rewrite');
  await page.route('**/api/documents/*/rewrite', route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ replacements: body.targets.map(target => ({ paragraphId: target.paragraphId, text: target.text === 'Professional Summary' ? target.text : originalText })), warning: null }) });
  });
  await page.getByLabel('What should change?').fill('Make this whole section much shorter.');
  await page.getByRole('button', { name: 'Preview with AI', exact: true }).click();
  await page.getByRole('button', { name: 'Accept changes', exact: true }).click();
  await frame.locator('#career-page').filter({ hasText: 'of 1' }).waitFor();
  await page.getByRole('button', { name: 'Save PDF', exact: true }).click();
  await page.getByText('PDF saved. The previous version is available below.').waitFor();
  assert.equal(inspect().length, 1);
  assert.deepEqual(errors, []);
});
