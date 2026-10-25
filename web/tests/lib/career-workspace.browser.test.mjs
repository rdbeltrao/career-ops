// Run with CAREER_WORKSPACE_TEST_URL against a loopback app using disposable data.
// The fixture must contain the fictional headings below. No application is sent.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const target = process.env.CAREER_WORKSPACE_TEST_URL;
const fixtureMarker = 'Fictional career-workspace browser fixture.';
const contextFixture = `# Career record\n\n${fixtureMarker}\n\n## Profile, Skills & Credentials\n\nBuilds reliable software with **TypeScript**.\n\n## Career History\n\nEmployer records.\n\n### Example Labs\n\nLed a team of 4 engineers.\n\n- Improved onboarding.\n- Kept source [record](https://example.com/evidence).\n\n### Example Studio\n\nNeeds confirmation: delivery metric.\n\n## Professional Examples\n\nExamples belong to their sources.\n`;

test('legacy Context fallback edits canonical sections, guards drafts, and supports mobile', {
  skip: !target,
  timeout: 180_000,
}, async () => {
  const url = new URL(target);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  const origin = url.origin;
  const indexResponse = await fetch(`${origin}/api/workspace`);
  assert.equal(indexResponse.status, 200, 'workspace endpoint exists');
  const { documents } = await indexResponse.json();
  let initial = await fetch(`${origin}/api/workspace?document=context`).then((r) => r.json());
  assert.ok(initial.content.includes(fixtureMarker), 'refuse to mutate anything except the disposable browser fixture');
  const reset = await fetch(`${origin}/api/workspace`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ document: 'context', revision: initial.revision, action: 'replace', content: contextFixture }),
  });
  assert.equal(reset.status, 200);
  initial = await reset.json();
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  // Exercise fallback without deleting or modifying the fixture's page library.
  await page.route('**/api/workspace', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const catalog = await response.json();
    await route.fulfill({ json: { ...catalog, documents: catalog.documents.filter((document) => document.kind !== 'source'), sourceRootDocumentId: null, sourceError: null } });
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const writes = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/workspace') writes.push(req.postDataJSON());
  });
  async function read(id = 'context') {
    return fetch(`${origin}/api/workspace?document=${id}`).then((r) => r.json());
  }
  async function saved() {
    await page.getByRole('button', { name: 'Save', exact: true }).waitFor();
    await page.waitForFunction(() => {
      const save = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save');
      return save?.disabled;
    });
  }
  async function select(title, waitForPage = true) {
    const nav = page.getByRole('navigation', { name: 'Workspace pages' });
    await nav.getByRole('button', { name: title, exact: true }).first().click();
    if (waitForPage) await page.waitForFunction((title) => document.querySelector('section[aria-label="Page editor"] h1')?.textContent === title, title);
  }
  async function shot(name) {
    if (!process.env.CAREER_WORKSPACE_ARTIFACT_DIR) return;
    await mkdir(process.env.CAREER_WORKSPACE_ARTIFACT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.CAREER_WORKSPACE_ARTIFACT_DIR, `${name}.png`), fullPage: true });
  }
  try {
    await page.goto(`${origin}/context?document=context`);
    await page.getByRole('navigation', { name: 'Workspace pages' }).waitFor();
    await page.getByRole('button', { name: 'Save', exact: true }).waitFor();
    assert.equal(writes.length, 0, 'opening does not write');
    assert.equal(await page.getByRole('button', { name: /^(Source pages|App files)$/ }).count(), 0);
    assert.equal(await page.getByRole('navigation', { name: 'Workspace pages' }).getByRole('button', { name: 'CV draft', exact: true }).count(), 0, 'CV is separate from fallback Context');
    await select('Profile, Skills & Credentials');
    const editor = page.getByRole('textbox', { name: 'Page content', exact: true });
    await editor.fill('Builds reliable software with TypeScript. Reviewed 7 projects.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await saved();
    const edited = await read();
    assert.match(edited.content, /Reviewed 7 projects/);
    assert.equal(edited.content.slice(edited.content.indexOf('## Career History')), initial.content.slice(initial.content.indexOf('## Career History')), 'unrelated sections unchanged');
    await page.reload();
    await select('Profile, Skills & Credentials');
    await editor.waitFor();
    assert.match(await editor.innerText(), /Reviewed 7 projects/);
    await shot('context-desktop');

    await select('Career History');
    await page.getByRole('button', { name: 'New child page', exact: true }).click();
    await page.getByRole('textbox', { name: 'Page title', exact: true }).fill('Example Research');
    await page.getByRole('button', { name: 'Create page', exact: true }).click();
    await editor.waitFor();
    await editor.fill('Source: https://example.com/research. Needs confirmation.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await saved();
    await page.getByRole('button', { name: 'Rename page', exact: true }).click();
    await page.getByRole('textbox', { name: 'Page title', exact: true }).fill('Research record');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.getByRole('button', { name: 'Move page up', exact: true }).click();
    await saved();
    const organized = await read();
    assert.ok(organized.content.indexOf('### Research record') < organized.content.indexOf('### Example Studio'));
    assert.match(organized.content, /Needs confirmation/);

    await editor.fill('Unsaved local draft.');
    const cvTitle = documents.find((d) => d.id === 'cv').title;
    await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: cvTitle, exact: true }).click();
    await page.getByRole('dialog', { name: 'Unsaved changes' }).waitFor();
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    assert.match(await editor.innerText(), /Unsaved local draft/);

    const current = await read();
    const outside = await fetch(`${origin}/api/workspace`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ document: 'context', revision: current.revision, action: 'replace', content: current.content + '\nExternal update preserved.\n' }),
    });
    assert.equal(outside.status, 200);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /changed elsewhere/ }).waitFor();
    assert.match(await editor.innerText(), /Unsaved local draft/);
    assert.match((await read()).content, /External update preserved/);
    await page.getByRole('button', { name: 'Open saved version', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();

    const achievements = documents.find((d) => d.id === 'achievements').title;
    await select(achievements);
    await page.getByRole('article', { name: 'Formatted page' }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Markdown source', exact: true }).count(), 0, 'complex pages open formatted');
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    const source = page.getByRole('textbox', { name: 'Markdown source', exact: true });
    await source.waitFor();
    const originalTable = await source.inputValue();
    assert.match(originalTable, /\| Claim \| Source \|/);
    await source.fill(originalTable + '\nReviewed source table.\n');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await saved();
    assert.ok((await read('achievements')).content.startsWith(originalTable), 'unsupported table remains byte-identical');

    await page.goto(`${origin}/cv`);
    await editor.waitFor();
    assert.match(await editor.innerText(), /Alex Example/, 'legacy CV route uses shared editor');

    await page.locator('aside nav').getByRole('link', { name: 'Context', exact: true }).last().click();
    await page.waitForURL(`${origin}/context`);
    await select(documents.find((d) => d.id === 'context').title);
    await select('Profile, Skills & Credentials');
    await editor.fill('Recover this draft after browser navigation.');
    await page.getByRole('status', { name: 'Page save status' }).filter({ hasText: 'Unsaved changes' }).waitFor();
    const writesBeforeHistory = writes.length;
    await page.goBack();
    await page.waitForURL(`${origin}/cv`);
    await page.goForward();
    await page.waitForURL(`${origin}/context`);
    await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
    assert.match(await editor.innerText(), /Recover this draft/);
    assert.equal(writes.length, writesBeforeHistory, 'history recovery never writes the source file');
    page.once('dialog', (dialog) => dialog.accept());
    await page.reload();
    await page.getByRole('button', { name: 'Restore draft', exact: true }).waitFor();
    const latest = await read();
    const changedWhileAway = await fetch(`${origin}/api/workspace`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ document: 'context', revision: latest.revision, action: 'replace', content: latest.content + '\nRevision after draft recovery.\n' }),
    });
    assert.equal(changedWhileAway.status, 200);
    await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
    assert.match(await editor.innerText(), /Recover this draft/);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /changed elsewhere/ }).waitFor();
    assert.match((await read()).content, /Revision after draft recovery/);
    await page.getByRole('button', { name: 'Open saved version', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await saved();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Show pages', exact: true }).click();
    const search = page.getByRole('textbox', { name: 'Search pages', exact: true });
    await search.fill('Example Labs');
    await select('Example Labs');
    await page.getByRole('button', { name: 'Hide pages', exact: true }).click();
    await editor.waitFor();
    assert.match(await editor.innerText(), /4 engineers/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'mobile fits viewport');
    await shot('context-mobile');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
