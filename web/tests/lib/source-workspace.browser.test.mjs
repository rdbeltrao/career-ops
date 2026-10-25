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

test('Context has one real page hierarchy with CV as a separate output', { skip: !target, timeout: 180_000 }, async () => {
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
  async function pageAction(name) {
    await page.getByRole('button', { name: 'Page actions', exact: true }).click();
    await page.getByRole('menu', { name: 'Page actions' }).getByRole('menuitem', { name, exact: true }).click();
  }
  async function choosePurpose(label) {
    await page.getByRole('button', { name: 'Change page purpose', exact: true }).click();
    await page.getByRole('menu', { name: 'How evaluations use this page' }).getByRole('menuitemradio', { name: new RegExp(`^${label}`) }).click();
  }
  const PURPOSE_LABEL = { facts: 'Career facts', reference: 'Reference material' };
  async function shot(name) {
    if (!process.env.CAREER_WORKSPACE_ARTIFACT_DIR) return;
    await mkdir(process.env.CAREER_WORKSPACE_ARTIFACT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.CAREER_WORKSPACE_ARTIFACT_DIR, `${name}.png`), fullPage: true });
  }
  try {
    await page.route(`**/api/workspace?document=${rootId}`, async (route) => {
      const response = await route.fetch();
      const document = await response.json();
      await route.fulfill({ json: { ...document, content: document.content + '\n\n## Body-only section\n\nThis is content inside the root page.\n' } });
    });
    await page.goto(`${origin}/context`);
    await page.getByRole('heading', { name: 'Example job applications', exact: true, level: 1 }).waitFor();
    await page.getByRole('region', { name: 'Page editor' }).getByRole('heading', { name: 'Body-only section', exact: true }).waitFor();
    assert.equal(writes.length, 0);
    assert.equal(await page.getByRole('button', { name: /^(Source pages|App files)$/ }).count(), 0, 'Context has no competing views');
    assert.match(await page.locator('main').innerText(), /Used for job matching and CV generation/);
    assert.doesNotMatch(await page.locator('main').innerText(), /Local copy|Local edits stay here|matching uses Application profile/);
    assert.equal(await navigation().getByRole('button', { name: 'CV draft', exact: true }).count(), 0);
    assert.equal(await navigation().getByRole('button', { name: 'Career context', exact: true }).count(), 0, 'landing headings never become pages');
    await navigation().getByRole('textbox', { name: 'Search pages' }).fill('Body-only section');
    await navigation().getByText('No pages match your search.', { exact: true }).waitFor();
    await navigation().getByRole('textbox', { name: 'Search pages' }).fill('');
    for (const staleDocument of ['context', 'profile', 'cv']) {
      await page.goto(`${origin}/context?document=${staleDocument}`);
      await page.getByRole('heading', { name: 'Example job applications', exact: true, level: 1 }).waitFor();
      assert.equal(await navigation().getByRole('button', { name: 'Application profile', exact: true }).count(), 0, 'stale local links cannot expose a second structure');
    }
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

    const purposeStatus = page.getByRole('region', { name: 'Page editor' }).locator('p', { hasText: /^(Career facts|Job preferences|Reference material|Unconfirmed notes) · / });
    const nextPurpose = (await read(employerId)).usage === 'facts' ? 'reference' : 'facts';
    await editor.fill('Fictional employer record. Draft kept while changing page purpose.');
    const writesBeforePurpose = writes.length;
    await choosePurpose(PURPOSE_LABEL[nextPurpose]);
    await page.getByRole('dialog', { name: 'Unsaved changes' }).waitFor();
    assert.equal(writes.length, writesBeforePurpose, 'changing purpose first guards an unsaved draft');
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    assert.match(await editor.innerText(), /Draft kept while changing page purpose/);
    await choosePurpose(PURPOSE_LABEL[nextPurpose]);
    await page.getByRole('button', { name: 'Save and continue', exact: true }).click();
    await page.getByRole('status', { name: 'Page save status' }).filter({ hasText: 'Page purpose updated.' }).waitFor();
    const purposeUpdated = await read(employerId);
    assert.equal(purposeUpdated.usage, nextPurpose);
    assert.match(purposeUpdated.content, /Draft kept while changing page purpose/);
    assert.equal(writes.slice(writesBeforePurpose).filter((write) => write.action === 'usage').length, 1, 'one confirmed purpose change makes one purpose mutation');
    await page.reload();
    await page.getByRole('heading', { name: 'Example Labs', exact: true, level: 1 }).waitFor();
    assert.match(await purposeStatus.innerText(), new RegExp(`^${PURPOSE_LABEL[nextPurpose]} · `), 'page purpose survives reload');

    const allPages = await navigation().getByRole('button', { name: /./ }).count();
    const factsFilter = navigation().getByRole('button', { name: /^Show only career facts/ });
    await factsFilter.click();
    assert.equal(await factsFilter.getAttribute('aria-pressed'), 'true');
    assert.ok(await navigation().getByRole('img', { name: 'Career facts' }).count() > 0, 'fact pages carry a marker');
    assert.ok(await navigation().getByRole('button', { name: /./ }).count() < allPages, 'the filter hides pages that are not career facts');
    await factsFilter.click();
    assert.equal(await navigation().getByRole('button', { name: /./ }).count(), allPages);

    await select('Career History');
    await pageAction('New child page');
    await page.getByRole('textbox', { name: 'Page title', exact: true }).fill('Research record');
    await page.getByRole('button', { name: 'Create page', exact: true }).click();
    await page.getByRole('heading', { name: 'Research record', exact: true, level: 1 }).waitFor();
    await pageAction('Rename page');
    await page.getByRole('textbox', { name: 'Page title', exact: true }).fill('Research notes');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.getByRole('heading', { name: 'Research notes', exact: true, level: 1 }).waitFor();
    await pageAction('Move page up');
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
    await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'CV draft', exact: true }).click();
    await page.waitForURL(`${origin}/cv`);
    await page.getByRole('heading', { name: 'CV draft', exact: true, level: 1 }).waitFor();
    await page.getByRole('status', { name: 'Document save status' }).filter({ hasText: 'All changes saved' }).waitFor();
    const cvOutline = page.getByRole('navigation', { name: 'Document sections' });
    await cvOutline.waitFor();
    assert.equal(await cvOutline.getByRole('button', { name: 'Example job applications', exact: true }).count(), 0, 'CV has only its own outline');
    assert.equal(await cvOutline.getByRole('button', { name: 'Application profile', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /^(Source pages|App files|New page|New child page)$/ }).count(), 0);
    assert.match(await page.getByRole('region', { name: 'Document editor' }).innerText(), /output|working r[eé]sum[eé]/i);

    await page.goto(`${origin}/context`);
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.getByRole('button', { name: 'Show pages', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Workspace page navigation' });
    await drawer.waitFor();
    await select('Career History');
    assert.equal(await drawer.isVisible(), true, 'selecting a page keeps navigation open');
    await select('Career History');
    assert.equal(await drawer.isVisible(), true, 'selecting the active page keeps navigation open');
    await select('Example Labs');
    assert.equal(await drawer.isVisible(), true, 'repeated page selection keeps navigation open');
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
    assert.ok(writes.every((write) => write.section === null), 'page operations never target Markdown sections');
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

test('an unreadable Context hierarchy never silently exposes legacy files', { skip: !target, timeout: 60_000 }, async () => {
  const url = new URL(target);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  const catalog = await fetch(`${url.origin}/api/workspace`).then((response) => response.json());
  const problem = 'The fictional Context hierarchy could not be read.';
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const requestedDocuments = [];
  page.on('request', (request) => {
    const address = new URL(request.url());
    if (address.pathname === '/api/workspace' && address.searchParams.has('document')) requestedDocuments.push(address.searchParams.get('document'));
  });
  try {
    await page.route('**/api/workspace', (route) => route.fulfill({ json: { ...catalog, documents: catalog.documents.filter((document) => document.kind !== 'source'), sourceRootDocumentId: null, sourceError: { error: problem, code: 'invalid_source_library' } } }));
    await page.goto(`${url.origin}/context?document=context`);
    await page.getByRole('alert').filter({ hasText: problem }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Application profile', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /^(Source pages|App files)$/ }).count(), 0);
    assert.deepEqual(requestedDocuments, [], 'no hidden fallback document is loaded after a hierarchy error');
  } finally { await browser.close(); }
});

test('already-internal Context links display page titles instead of raw source URLs', { skip: !target, timeout: 60_000 }, async () => {
  const url = new URL(target);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  const catalog = await fetch(`${url.origin}/api/workspace`).then((response) => response.json());
  assert.equal(catalog.documents.find((document) => document.id === employerId)?.title, 'Example Labs', 'use the fictional page library only');
  const rawUrl = `https://app.notion.com/p/${'3'.repeat(32)}`;
  const destination = `/context?document=${employerId}`;
  const rawContent = `[${rawUrl}](${destination})\n\n[Read this career note](${destination})\n`;
  let formatted = false;
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let writes = 0;
  page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/workspace') writes++; });
  try {
    await page.route(`**/api/workspace?document=${historyId}`, async (route) => {
      const response = await route.fetch();
      const document = await response.json();
      await route.fulfill({ json: { ...document, content: formatted ? `| Page |\n| --- |\n| [${rawUrl}](${destination}) |\n` : rawContent } });
    });
    await page.goto(`${url.origin}/context?document=${historyId}`);
    await page.getByRole('status', { name: 'Page save status' }).filter({ hasText: 'All changes saved' }).waitFor();
    const editor = page.getByRole('region', { name: 'Page editor' });
    await editor.getByRole('link', { name: 'Example Labs', exact: true }).waitFor();
    assert.equal(await editor.getByRole('link', { name: 'Example Labs', exact: true }).getAttribute('href'), destination);
    assert.equal(await editor.getByRole('link', { name: 'Read this career note', exact: true }).getAttribute('href'), destination);
    assert.doesNotMatch(await editor.innerText(), /https:\/\/app\.notion\.com/);
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Markdown source', exact: true }).inputValue(), rawContent, 'display labels do not change the exact Source draft');
    await page.getByRole('button', { name: 'Rich text', exact: true }).click();
    const editable = page.getByRole('textbox', { name: 'Page content', exact: true });
    await editable.click();
    await editable.press('ControlOrMeta+End');
    await editable.pressSequentially(' x');
    await page.getByRole('status', { name: 'Page save status' }).filter({ hasText: 'Unsaved changes' }).waitFor();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByRole('status', { name: 'Page save status' }).filter({ hasText: 'All changes saved' }).waitFor();
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Markdown source', exact: true }).inputValue(), rawContent, 'undo restores exact source rather than normalized display labels');
    formatted = true;
    await page.reload();
    await page.getByRole('article', { name: 'Formatted page' }).getByRole('link', { name: 'Example Labs', exact: true }).waitFor();
    assert.equal(writes, 0, 'display normalization never saves canonical content');
  } finally { await browser.close(); }
});
