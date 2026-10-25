import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decoratedSummary } from '../fixtures/decorated-cv.mjs';

const url = process.env.PDF_STABILITY_TEST_URL;
const root = process.env.PDF_STABILITY_TEST_ROOT;
const enabled = !!url && !!root;

async function openEditor(t) {
  const origin = new URL(url);
  assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname));
  const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(root));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.equal(fs.readFileSync(path.join(root, '.decorated-pdf-fixture'), 'utf8').trim(), 'fictional-only');
  const file = path.join(root, 'output/cv-fixture-alpha.pdf'), bytes = fs.readFileSync(file);
  t.after(() => assert.ok(fs.readFileSync(file).equals(bytes), 'Interactions leave the saved fixture unchanged'));
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    window.pdfEvents = [];
    window.addEventListener('message', event => {
      if (event.data?.channel !== 'career-ops-pdf-editor') return;
      const { type, revision, canUndo, canRedo, message } = event.data;
      window.pdfEvents.push({ type, revision, canUndo, canRedo, message });
    });
  });
  t.after(async () => {
    const label = t.name.includes('one character') ? 'typing' : t.name.startsWith('typing on') ? 'later-page' : 'drag';
    await page.screenshot({ path: path.join(root, `${label}-final.png`) });
    const alerts = (await page.getByRole('alert').allTextContents()).filter(text => text.trim());
    if (alerts.length || errors.length) console.error(JSON.stringify({ alerts, errors, events: await page.evaluate(() => window.pdfEvents) }));
    await browser.close();
  });
  await page.goto(`${origin.origin}/pipeline/11/cv-visual`);
  const frame = page.frameLocator('iframe[title="Editable PDF pages"]');
  await frame.getByRole('button', { name: `Edit paragraph: ${decoratedSummary}`, exact: true }).waitFor();
  const inline = () => frame.getByRole('textbox', { name: 'Edit paragraph on page', exact: true });
  return { page, frame, inline, errors };
}

async function caretState(inline) {
  return inline.evaluate(element => {
    const selection = getSelection();
    if (!selection?.rangeCount) return null;
    const caret = selection.getRangeAt(0), before = caret.cloneRange();
    before.selectNodeContents(element); before.setEnd(caret.startContainer, caret.startOffset);
    const rect = caret.getBoundingClientRect();
    return { offset: before.toString().length, x: rect.x, y: rect.y, stageScroll: document.getElementById('stage').scrollTop };
  });
}

async function headerPixels(canvas) {
  return canvas.evaluate(element => {
    const image = element.getContext('2d').getImageData(0, 0, element.width, Math.round(element.height * 0.12));
    let hash = 2166136261;
    for (const value of image.data) hash = Math.imul(hash ^ value, 16777619) >>> 0;
    return { width: image.width, height: image.height, hash };
  });
}

async function traceNextInput(inline) {
  await inline.evaluate(element => {
    window.pdfCaretTrace = new Promise(resolve => {
      const samples = [], until = performance.now() + 500;
      const sample = () => {
        const selection = getSelection();
        if (selection?.rangeCount && element.contains(selection.anchorNode)) samples.push(selection.getRangeAt(0).getBoundingClientRect().y);
        if (performance.now() < until) requestAnimationFrame(sample); else resolve(samples);
      };
      requestAnimationFrame(sample);
    });
  });
}

async function assertInputFrames(inline, baseline) {
  const samples = await inline.evaluate(() => window.pdfCaretTrace);
  assert.ok(samples.length > 1, 'Samples native input and the debounced preview');
  assert.ok(samples.every(y => Math.abs(y - baseline) < 6), `Caret remains anchored throughout input frames: ${JSON.stringify(samples)}`);
}

async function wordSize(inline, word) {
  return inline.evaluate((element, word) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), nodes = []; let node;
    while ((node = walker.nextNode())) nodes.push(node);
    const text = nodes.map(node => node.textContent).join(''), start = text.indexOf(word);
    if (start < 0) throw new Error('Styled fixture word not found');
    const point = offset => { for (const node of nodes) { if (offset <= node.length) return [node, offset]; offset -= node.length; } };
    const range = document.createRange(); range.setStart(...point(start)); range.setEnd(...point(start + word.length));
    const box = range.getBoundingClientRect(); return { width: box.width, height: box.height };
  }, word);
}

test('one character at a clicked middle caret keeps the page, scroll and caret stable', { skip: !enabled, timeout: 90_000 }, async t => {
  const { page, frame, inline, errors } = await openEditor(t);
  const originalHeader = await headerPixels(frame.locator('#page'));
  await frame.getByRole('button', { name: `Edit paragraph: ${decoratedSummary}`, exact: true }).click();
  const point = await inline().evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let node, offset = 'Hands-on,'.length;
    while ((node = walker.nextNode())) {
      if (offset <= node.length) { const range = document.createRange(); range.setStart(node, offset); range.collapse(true); const box = range.getBoundingClientRect(); return { x: box.x, y: box.y + box.height / 2 }; }
      offset -= node.length;
    }
    throw new Error('Fictional caret prefix not found');
  });
  const iframe = await page.locator('iframe[title="Editable PDF pages"]').boundingBox();
  await page.mouse.click(iframe.x + point.x, iframe.y + point.y);
  const before = await caretState(inline());
  assert.equal(before.offset, 'Hands-on,'.length);
  await inline().pressSequentially('a');
  await frame.locator('body.live-reflow').waitFor({ state: 'attached' });
  const previewHeader = await headerPixels(frame.locator('.career-reflow-page canvas').first());
  assert.deepEqual(previewHeader, originalHeader, 'The first live page still displays its original header pixels');
  assert.notDeepEqual(await headerPixels(frame.locator('.career-reflow-page canvas').last()), previewHeader, 'Preview pages have distinct pixels');
  const after = await caretState(inline());
  assert.equal(after.offset, before.offset + 1);
  assert.ok(Math.abs(after.stageScroll - before.stageScroll) < 4, `Typing must not jump the page: ${JSON.stringify({ before, after })}`);
  assert.ok(Math.abs(after.y - before.y) < 4, 'Caret stays beside the edited word');
  assert.ok((await inline().innerText()).startsWith('Hands-on,a thoughtful'));
  await page.screenshot({ path: path.join(root, 'middle-caret-after-one-character.png') });
  // The next native input must retain the mapped layout rather than reverting
  // its editable lines to unpaginated coordinates before the debounce completes.
  await traceNextInput(inline());
  await inline().pressSequentially('b');
  await assertInputFrames(inline(), after.y);
  const next = await caretState(inline());
  assert.equal(next.offset, before.offset + 2);
  assert.ok(Math.abs(next.stageScroll - before.stageScroll) < 4);
  assert.ok(Math.abs(next.y - before.y) < 4);
  assert.ok((await inline().innerText()).startsWith('Hands-on,ab thoughtful'));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await frame.getByRole('button', { name: `Edit paragraph: ${decoratedSummary}`, exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').filter({ hasText: /\S/ }).count(), 0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await frame.getByRole('button', { name: `Edit paragraph: ${decoratedSummary.replace('Hands-on,', 'Hands-on,ab')}`, exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test('a decorated section drag can be undone and redone without stale errors', { skip: !enabled, timeout: 90_000 }, async t => {
  const { page, frame, errors } = await openEditor(t);
  const handle = frame.getByRole('button', { name: /^Select section: Core Competencies$/i });
  await handle.evaluate(element => element.scrollIntoView({ block: 'center' }));
  const start = await handle.boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 20, start.y + 10, { steps: 5 });
  const target = frame.getByRole('button', { name: 'Drop section before professional summary', exact: true });
  await target.waitFor();
  const drop = await target.boundingBox();
  await page.mouse.move(drop.x + drop.width / 2, drop.y + drop.height / 2, { steps: 12 });
  await page.mouse.up();
  await frame.getByText('Section moved. The PDF pages have adjusted automatically.', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'decorated-section-moved.png') });
  await page.route('**/api/documents/*', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fictional save failure.' }) }) : route.continue());
  await page.getByRole('button', { name: 'Save PDF', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Fictional save failure.' }).waitFor();
  // Successful actions inside the PDF must clear a resolved host error too.
  await frame.locator('#career-undo').click();
  await page.waitForFunction(() => window.pdfEvents.some(event => event.type === 'changed' && event.canRedo));
  assert.equal(await page.getByRole('alert').filter({ hasText: /\S/ }).count(), 0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.waitForFunction(() => window.pdfEvents.filter(event => event.type === 'changed').length >= 3);
  assert.equal(await page.getByRole('alert').filter({ hasText: /\S/ }).count(), 0);
  await frame.locator('#career-undo').click();
  await page.waitForFunction(() => window.pdfEvents.filter(event => event.type === 'changed').length >= 4);
  // A queued/keyboard duplicate at the history boundary is a harmless no-op.
  await frame.locator('#career-page').click();
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForFunction(() => window.pdfEvents.some(event => event.type === 'history-state'));
  assert.equal(await page.getByRole('alert').filter({ hasText: /\S/ }).count(), 0);
  assert.deepEqual(errors, []);
});

test('typing on a later page keeps the visible caret anchored through pagination', { skip: !enabled, timeout: 90_000 }, async t => {
  const { page, frame, inline, errors } = await openEditor(t);
  await frame.locator('#career-next').click();
  const company = frame.getByRole('button', { name: 'Edit paragraph: Fixture Beta', exact: true });
  await company.click();
  await inline().press('Home');
  await inline().press('ArrowRight');
  const before = await caretState(inline());
  await inline().pressSequentially('a');
  await frame.locator('body.live-reflow').waitFor({ state: 'attached' });
  const after = await caretState(inline());
  assert.equal(after.offset, before.offset + 1);
  assert.ok(Math.abs(after.y - before.y) < 4, `Later-page caret stays visible: ${JSON.stringify({ before, after })}`);
  await traceNextInput(inline());
  await inline().pressSequentially('b');
  await assertInputFrames(inline(), after.y);
  const next = await caretState(inline());
  assert.equal(next.offset, before.offset + 2);
  assert.ok(Math.abs(next.y - before.y) < 4);
  assert.deepEqual(errors, []);
});

test('styled source-font spans retain their geometry through successive live edits', { skip: !enabled, timeout: 90_000 }, async t => {
  const { frame, inline, errors } = await openEditor(t);
  await frame.getByRole('button', { name: /^Edit paragraph: Led engineering across web and mobile products/ }).click();
  const before = await wordSize(inline(), 'design teams');
  await inline().press('Home');
  await inline().press('ArrowRight');
  await inline().pressSequentially('a');
  await frame.locator('body.live-reflow').waitFor({ state: 'attached' });
  const caret = await caretState(inline());
  await traceNextInput(inline());
  await inline().pressSequentially('b');
  await assertInputFrames(inline(), caret.y);
  const after = await wordSize(inline(), 'design teams');
  assert.ok(Math.abs(after.width - before.width) < 1, `The styled source font retains its advance widths: ${JSON.stringify({ before, after })}`);
  assert.ok(Math.abs(after.height - before.height) < 1);
  assert.deepEqual(errors, []);
});
