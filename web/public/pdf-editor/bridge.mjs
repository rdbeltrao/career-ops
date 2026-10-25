// SPDX-License-Identifier: AGPL-3.0-only
import { PdfEngine } from '../vendor/bentopdf/core.js';
import { paragraphText, replacementRuns, assertReplacementFits } from './model.mjs';

// EVIDENCE: Messages must match both origin and sender, then validate their payload.
// https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage#security_concerns
const channel = 'career-ops-pdf-editor';
const session = new URLSearchParams(location.search).get('session');
const parentOrigin = location.origin;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const status = document.getElementById('status');
const pages = document.getElementById('pages');
let engine;
let loaded = false;
let selection = null;
let paragraphsByPage = [];
let undo = [];
let redo = [];
let revision = 0;
let commandQueue = Promise.resolve();

function send(type, payload = {}, requestId) {
  parent.postMessage({ channel, session, type, ...payload, ...(requestId ? { requestId } : {}) }, parentOrigin);
}

function showStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function selectedParagraph() {
  if (!selection) return null;
  return paragraphsByPage[selection.pageIndex]?.[selection.index] ?? null;
}

function notifySelection(requestId) {
  const paragraph = selectedParagraph();
  send('selection', {
    paragraphId: paragraph ? `${selection.pageIndex}:${selection.index}` : '',
    pageIndex: selection?.pageIndex ?? 0,
    text: paragraph ? paragraphText(paragraph) : '',
    revision,
  }, requestId);
}

function select(paragraphId, requestId) {
  const match = typeof paragraphId === 'string' && /^(\d+):(\d+)$/.exec(paragraphId);
  if (!match) throw new Error('Select a paragraph in the PDF first.');
  const pageIndex = Number(match[1]);
  const index = Number(match[2]);
  const paragraph = paragraphsByPage[pageIndex]?.[index];
  if (!paragraph?.editable || paragraph.invisible || paragraph.vertical || Math.abs(paragraph.rotation ?? 0) > 0.01) {
    throw new Error('This text block cannot be edited in the visual editor.');
  }
  selection = { pageIndex, index };
  for (const button of pages.querySelectorAll('.paragraph')) {
    button.setAttribute('aria-pressed', String(button.dataset.paragraphId === paragraphId));
  }
  notifySelection(requestId);
}

function render() {
  const nodes = [];
  paragraphsByPage = [];
  let editableCount = 0;
  const width = Math.min(760, Math.max(240, document.documentElement.clientWidth - 36));
  for (let pageIndex = 0; pageIndex < engine.pageCount; pageIndex++) {
    engine.loadPage(pageIndex);
    const paragraphs = engine.buildModel();
    paragraphsByPage.push(paragraphs);
    const scale = width / engine.pageWidth;
    const image = engine.renderPage(scale * Math.min(devicePixelRatio || 1, 1.5));
    const page = document.createElement('section');
    page.className = 'page';
    page.setAttribute('aria-label', `Page ${pageIndex + 1}`);
    page.style.width = `${engine.pageWidth * scale}px`;
    page.style.height = `${engine.pageHeight * scale}px`;
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.setAttribute('aria-label', `PDF page ${pageIndex + 1}`);
    canvas.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    page.append(canvas);
    for (const [index, paragraph] of paragraphs.entries()) {
      if (!paragraph.editable || paragraph.invisible || paragraph.vertical || Math.abs(paragraph.rotation ?? 0) > 0.01 || !paragraphText(paragraph).trim()) continue;
      editableCount++;
      const id = `${pageIndex}:${index}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'paragraph';
      button.dataset.paragraphId = id;
      button.setAttribute('aria-label', `Edit paragraph: ${paragraphText(paragraph)}`);
      button.setAttribute('aria-pressed', String(selection?.pageIndex === pageIndex && selection?.index === index));
      button.title = paragraphText(paragraph);
      button.style.left = `${paragraph.box.x * scale}px`;
      button.style.top = `${(engine.pageHeight - paragraph.box.top) * scale}px`;
      button.style.width = `${Math.max(6, paragraph.box.w * scale)}px`;
      button.style.height = `${Math.max(12, paragraph.box.h * scale)}px`;
      button.addEventListener('click', () => select(id));
      page.append(button);
    }
    const label = document.createElement('span');
    label.className = 'page-label';
    label.textContent = `Page ${pageIndex + 1} of ${engine.pageCount}`;
    page.append(label);
    nodes.push(page);
  }
  pages.replaceChildren(...nodes);
  showStatus(editableCount ? 'Select a paragraph to edit its existing PDF text.' : 'No editable paragraphs found. Scanned or rotated text needs the classic editor or its original source.');
}

async function snapshot() {
  const bytes = await engine.saveSpliced();
  if (!bytes) throw new Error('Could not prepare the PDF for editing.');
  return bytes;
}

function pushHistory(stack, bytes) {
  stack.push(bytes);
  while (stack.length > 10 || (stack.length > 1 && stack.reduce((sum, entry) => sum + entry.byteLength, 0) > MAX_HISTORY_BYTES)) stack.shift();
}

function changed(requestId) {
  revision++;
  send('changed', { revision, canUndo: undo.length > 0, canRedo: redo.length > 0 }, requestId);
}

async function handle(message) {
  const { type, requestId } = message;
  if (type === 'load') {
    if (!(message.bytes instanceof ArrayBuffer) || message.bytes.byteLength === 0 || message.bytes.byteLength > MAX_BYTES) throw new Error('Choose a PDF smaller than 20 MB.');
    loaded = false;
    selection = null;
    engine.open(new Uint8Array(message.bytes));
    if (!engine.pageCount || engine.pageCount > 20) {
      engine.close();
      throw new Error('Visual editing supports PDFs with 1 to 20 pages.');
    }
    if (engine.documentInfo()?.signatures > 0) {
      engine.close();
      throw new Error('Signed PDFs cannot be edited here because editing invalidates their signature.');
    }
    undo = [];
    redo = [];
    revision = 0;
    loaded = true;
    render();
    send('loaded', { pageCount: engine.pageCount, warnings: ['Visual edits keep the PDF page layout. Changes that overlap other paragraphs or leave the page are blocked. Use Classic CV Studio for longer sections and automatic pagination.'] }, requestId);
    return;
  }
  if (!loaded) throw new Error('Load a PDF before editing.');
  if (type === 'select') {
    select(message.paragraphId, requestId);
  } else if (type === 'replace') {
    const match = typeof message.paragraphId === 'string' && /^(\d+):(\d+)$/.exec(message.paragraphId);
    if (!match || typeof message.expectedText !== 'string') throw new Error('Select a paragraph before replacing text.');
    const pageIndex = Number(match[1]);
    const index = Number(match[2]);
    const displayed = paragraphsByPage[pageIndex]?.[index];
    if (!displayed || paragraphText(displayed) !== message.expectedText) throw new Error('This paragraph changed. Select it again before applying the rewrite.');
    engine.loadPage(pageIndex);
    const paragraphs = engine.buildModel();
    // Engine IDs are session handles and change when buildModel reloads a page.
    // Resolve the displayed block by both text and position, never a stale handle.
    const matches = paragraphs.filter((candidate) => paragraphText(candidate) === message.expectedText &&
      Math.abs(candidate.box.x - displayed.box.x) < 0.5 && Math.abs(candidate.box.top - displayed.box.top) < 0.5);
    const paragraph = matches.length === 1 ? matches[0] : null;
    if (!paragraph?.editable || paragraphText(paragraph) !== message.expectedText) throw new Error('This paragraph changed. Select it again before applying the rewrite.');
    const id = paragraph.id;
    const runs = replacementRuns(paragraph, message.text);
    if (message.text === message.expectedText) {
      selection = { pageIndex, index };
      changed(requestId);
      notifySelection();
      return;
    }
    const preview = engine.previewParagraph(id, runs, paragraph.format);
    assertReplacementFits(paragraph, preview, paragraphs, engine.pageWidth, engine.pageHeight);
    const previous = await snapshot();
    const result = engine.editStep('Update paragraph', () => engine.commitParagraph(id, runs, paragraph.format));
    if (!result) throw new Error('Could not apply this text change.');
    pushHistory(undo, previous);
    redo = [];
    selection = { pageIndex, index };
    render();
    changed(requestId);
    notifySelection();
  } else if (type === 'export') {
    const bytes = await snapshot();
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    send('exported', { bytes: buffer, revision }, requestId);
  } else if (type === 'undo' || type === 'redo') {
    const from = type === 'undo' ? undo : redo;
    const to = type === 'undo' ? redo : undo;
    if (!from.length) throw new Error(`Nothing to ${type}.`);
    const current = await snapshot();
    engine.open(from.at(-1));
    from.pop();
    pushHistory(to, current);
    selection = null;
    render();
    changed(requestId);
    notifySelection();
  }
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (event.source !== parent || event.origin !== parentOrigin || !message || message.channel !== channel || message.session !== session) return;
  if (!['load', 'replace', 'export', 'select', 'undo', 'redo'].includes(message.type) || typeof message.requestId !== 'string' || message.requestId.length > 100) return;
  commandQueue = commandQueue.then(() => handle(message)).catch((error) => {
    const messageText = error instanceof Error ? error.message : 'The PDF editor could not complete that change.';
    showStatus(messageText, true);
    send('error', { message: messageText }, message.requestId);
  });
});

async function initialize() {
  if (!session || !/^[\w-]{8,100}$/.test(session) || parent === window) throw new Error('Open this editor from career-ops Documents.');
  // Font files are bundled locally. PDF text and font data never go to a third-party host.
  await Promise.all([['Regular', '00'], ['Bold', '10'], ['Italic', '01'], ['BoldItalic', '11']].map(async ([style, key]) => {
    const response = await fetch(`../vendor/bentopdf/fonts/NotoSans-${style}.ttf`);
    if (!response.ok) throw new Error('Could not load the local PDF fonts.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    PdfEngine.localFonts.set(`Noto Sans|${key}`, bytes);
    PdfEngine.fallbackFonts.set(`Noto Sans|${key}`, bytes);
  }));
  engine = await PdfEngine.create();
  showStatus('Waiting for your PDF…');
  send('ready');
}

initialize().catch((error) => {
  showStatus(error.message, true);
  send('error', { message: error.message });
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (loaded) commandQueue = commandQueue.then(render).catch((error) => send('error', { message: error.message }));
  }, 150);
});
