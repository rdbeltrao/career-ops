// Opt-in, disposable loopback fixture only. No Notion or real career data writes.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const target = process.env.CAREER_WORKSPACE_TEST_URL;
const rootId = `source-${'1'.repeat(32)}`;
const historyId = `source-${'2'.repeat(32)}`;
const employerId = `source-${'3'.repeat(32)}`;
const proofId = `source-${'4'.repeat(32)}`;
const marker = 'Fictional source-page browser fixture.';

test('source workspace preserves real page ancestry and separates application files', { skip: !target, timeout: 180_000 }, async () => {
  const url = new URL(target);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  const origin = url.origin;
  async function read(document) {
    const response = await fetch(`${origin}/api/workspace?document=${document}`);
    assert.equal(response.status, 200);
    return response.json();
  }
  const root = await read(rootId);
  assert.ok(root.content.includes(marker), 'only mutate the fictional source fixture');
  const employer = await read(employerId);
  const reset = await fetch(`${origin}/api/workspace`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ document: employerId, revision: employer.revision, action: 'replace', content: 'Fictional employer record.\n\nBuilt **example software**.\n' }),
  });
  assert.equal(reset.status, 200, 'reset fictional employer before repeated browser runs');
  const beforeHistory = await read(historyId);
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const writes = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/workspace') writes.push(request.postDataJSON()); });
  function navigation() { return page.getByRole('navigation', { name: 'Workspace pages' }); }
  async function select(title) {
    await navigation().getByRole('button', { name: title, exact: true }).click();
    await page.waitForFunction((title) => document.querySelector('section[aria-label="Page editor"] h1')?.textContent === title, title);
  }
  async function saved() {
    await page.getByRole('status', { name: 'Page save status' }).filter({ hasText: /Saved\.|Page (created|renamed|moved)\./ }).waitFor();
  }
  async function shot(name) {
    if (!process.env.CAREER_WORKSPACE_ARTIFACT_DIR) return;
    await mkdir(process.env.CAREER_WORKSPACE_ARTIFACT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.CAREER_WORKSPACE_ARTIFACT_DIR, `${name}.png`), fullPage: true });
  }
  try {
    await page.goto(`${origin}/context`);
    await page.getByRole('heading', { name: 'Example job applications', exact: true, level: 1 }).waitFor();
    assert.equal(writes.length, 0);
    assert.equal(await navigation().getByRole('button', { name: 'CV draft', exact: true }).count(), 0);
    assert.equal(await navigation().getByRole('button', { name: 'Career context', exact: true }).count(), 0, 'landing headings never become pages');
    assert.ok((await page.locator('#workspace-sidebar').boundingBox()).width >= 300, 'source navigation has room');
    assert.equal((await page.getByRole('complementary', { name: 'App sidebar' }).boundingBox()).width, 240, 'main navigation remains fully visible');
    assert.equal(await page.getByRole('button', { name: /Expand app navigation|Collapse app navigation|Reload from disk/ }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: /Child pages|Pages in this section/i }).count(), 0, 'no duplicate page navigation below the editor');
    await select('Career History');
    await select('Example Labs');
    const breadcrumbs = page.getByRole('navigation', { name: 'Page breadcrumbs' });
    assert.match(await breadcrumbs.innerText(), /Example job applications[\s\S]*Career History[\s\S]*Example Labs/);
    assert.equal(await page.getByRole('link', { name: 'Open in Notion', exact: true }).count(), 0);
    assert.equal(await page.locator('a[href*="notion.so"], a[href*="notion.com"], a[href*="notion.site"]').count(), 0);
    const editor = page.getByRole('textbox', { name: 'Page content', exact: true });
    await editor.fill('Fictional employer record. Edited locally.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await saved();
    assert.match((await read(employerId)).content, /Edited locally/);
    assert.equal((await read(historyId)).content, beforeHistory.content, 'editing a page does not rewrite its parent');
    await page.goto(`${origin}/context?document=${employerId}`);
    await page.getByRole('heading', { name: 'Example Labs', exact: true, level: 1 }).waitFor();
    assert.match(await editor.innerText(), /Edited locally/);
    await shot('source-workspace-desktop');

    await select('Career History');
    await page.getByRole('button', { name: 'New child page', exact: true }).click();
    await page.getByRole('textbox', { name: 'Page title', exact: true }).fill('Research record');
    await page.getByRole('button', { name: 'Create page', exact: true }).click();
    await page.getByRole('heading', { name: 'Research record', exact: true, level: 1 }).waitFor();
    await page.getByRole('button', { name: 'Rename page', exact: true }).click();
    await page.getByRole('textbox', { name: 'Page title', exact: true }).fill('Research notes');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.getByRole('heading', { name: 'Research notes', exact: true, level: 1 }).waitFor();
    await page.getByRole('button', { name: 'Move page up', exact: true }).click();
    await saved();
    const index = await fetch(`${origin}/api/workspace`).then((response) => response.json());
    const created = index.documents.find((document) => document.title === 'Research notes');
    assert.equal(created.parentDocumentId, historyId);
    assert.equal(created.kind, 'source');

    await page.goto(`${origin}/context?document=${proofId}`);
    await page.getByRole('heading', { name: 'Approved achievements', exact: true, level: 1 }).waitFor();
    await page.getByRole('article', { name: 'Formatted page' }).waitFor();
    assert.equal(await page.getByRole('table').count(), 1);
    assert.equal(await page.getByRole('textbox', { name: 'Markdown source', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'App files', exact: true }).click();
    await select('CV draft');
    assert.match(await page.getByRole('region', { name: 'Page editor' }).innerText(), /output|working r[eé]sum[eé]/i);

    await page.goto(`${origin}/context`);
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.getByRole('button', { name: 'Show pages', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Workspace page navigation' });
    await drawer.waitFor();
    await drawer.getByRole('button', { name: 'App files', exact: true }).click();
    await drawer.getByRole('button', { name: 'App files', exact: true }).filter({ hasText: 'App files' }).waitFor();
    await page.waitForFunction(() => document.querySelector('section[aria-label="Page editor"] h1')?.textContent === 'Application profile');
    assert.equal(await drawer.isVisible(), true, 'switching to App files keeps navigation open');
    await drawer.getByRole('button', { name: 'Source pages', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('section[aria-label="Page editor"] h1')?.textContent === 'Example job applications');
    assert.equal(await drawer.isVisible(), true, 'switching to Source pages keeps navigation open');
    await select('Career History');
    assert.equal(await drawer.isVisible(), true, 'selecting a page keeps navigation open');
    await select('Career History');
    assert.equal(await drawer.isVisible(), true, 'selecting the active page keeps navigation open');
    await drawer.getByRole('button', { name: 'Hide pages', exact: true }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await shot('source-workspace-narrow');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Show pages', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search pages', exact: true }).fill('Example Labs');
    await select('Example Labs');
    assert.equal(await drawer.isVisible(), true, 'mobile page navigation stays open');
    await drawer.getByRole('button', { name: 'Hide pages', exact: true }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await shot('source-workspace-mobile');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a missing source body does not hide healthy sibling pages', { skip: !target, timeout: 60_000 }, async () => {
  const url = new URL(target);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  const origin = url.origin;
  const catalog = await fetch(`${origin}/api/workspace`).then((response) => response.json());
  assert.ok(catalog.documents.some((document) => document.id === rootId));
  const problem = { error: 'The fictional employer page is unavailable.', code: 'missing_source_page' };
  catalog.sourceError = problem;
  catalog.documents = catalog.documents.map((document) => document.id === employerId ? { ...document, ...problem } : document);
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.route('**/api/workspace', (route) => route.fulfill({ json: catalog }));
    await page.goto(`${origin}/context`);
    await page.getByRole('alert').filter({ hasText: problem.error }).waitFor();
    await page.getByRole('navigation', { name: 'Workspace pages' }).getByRole('button', { name: 'Approved achievements', exact: true }).click();
    await page.getByRole('heading', { name: 'Approved achievements', exact: true, level: 1 }).waitFor();
    await page.getByRole('table').waitFor();
  } finally { await browser.close(); }
});
