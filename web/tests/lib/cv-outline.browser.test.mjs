// Run against a loopback app. Workspace reads and writes use fictional in-memory
// documents; no request may write the user's actual files.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseSections } from '../../src/lib/career-workspace.mjs';

const target = process.env.CAREER_WORKSPACE_TEST_URL;
const cv = '# Alex Example\n\n## Summary\n\nBuilds reliable software.\n\n## Experience\n\n### Example Labs\n\nWork record.\n\n## Skills\n\nTypeScript.\n';

async function fixture(run) {
  const url = new URL(target);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const writes = [], errors = [], reads = [];
  let current = { id: 'cv', title: 'CV draft', kind: 'local', group: 'Documents', exists: true, workspaceId: 'fictional-cv-outline', content: cv, revision: 'initial', sections: parseSections(cv) };
  const sources = [
    { id: 'source-root', title: 'Career records', kind: 'source', parentDocumentId: null, order: 0, content: '# Body heading\n\nSource record.', sections: [], usage: 'facts', exists: true, revision: 'source', workspaceId: 'fictional-cv-outline' },
    { id: 'source-work', title: 'Work records', kind: 'source', parentDocumentId: 'source-root', order: 1, content: 'Fictional work.', sections: [], usage: 'facts', exists: true, revision: 'source', workspaceId: 'fictional-cv-outline' },
  ];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/workspace*', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const mutation = request.postDataJSON();
      writes.push(mutation);
      assert.equal(mutation.document, 'cv');
      assert.equal(mutation.section, null);
      current = { ...current, content: mutation.content, sections: parseSections(mutation.content), revision: `saved-${writes.length}` };
      return route.fulfill({ json: { ...current, selectedSection: null } });
    }
    const document = new URL(request.url()).searchParams.get('document');
    reads.push(document);
    return route.fulfill({ json: document ? document === 'cv' ? current : sources.find(({ id }) => id === document) : { documents: [...sources, current], sourceRootDocumentId: 'source-root', sourceError: null } });
  });
  try { await run({ page, origin: url.origin, writes, reads, read: () => current }); assert.deepEqual(errors, []); }
  finally { await browser.close(); }
}

test('CV sections jump within one full draft, including unsaved edits and mobile navigation', { skip: !target, timeout: 90_000 }, async () => fixture(async ({ page, origin, writes, reads, read }) => {
  await page.goto(`${origin}/cv`);
  const editor = page.getByRole('textbox', { name: 'Page content', exact: true });
  await editor.waitFor();
  const outline = page.locator('#workspace-sidebar').getByRole('navigation', { name: 'Document sections' });
  await outline.getByRole('button', { name: 'Experience', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Experience');
  assert.match(await editor.innerText(), /Summary[\s\S]*Experience[\s\S]*Skills/);
  assert.equal(await page.getByRole('heading', { name: 'CV draft', level: 1, exact: true }).count(), 1);
  assert.equal(await page.getByRole('navigation', { name: 'Workspace pages' }).count(), 0);
  assert.equal(await outline.locator('[aria-current="page"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: /^(Rename page|Move page up|Move page down)$/ }).count(), 0);
  assert.equal(writes.length, 0);
  assert.equal(reads.filter((id) => id === 'cv').length, 1, 'section jumps never reload the document');
  if (process.env.CAREER_WORKSPACE_ARTIFACT_DIR) {
    await mkdir(process.env.CAREER_WORKSPACE_ARTIFACT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.CAREER_WORKSPACE_ARTIFACT_DIR, 'cv-outline-desktop.png'), fullPage: true });
  }

  await page.getByRole('button', { name: 'Source', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown source', exact: true });
  const draft = cv + '\n## Languages\n\nEnglish.\n';
  await source.fill(draft);
  await outline.getByRole('button', { name: 'Languages', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Markdown source');
  assert.equal(await source.evaluate((element) => element.selectionStart), draft.indexOf('## Languages'));
  assert.equal(await source.inputValue(), draft);
  assert.equal(await page.getByRole('dialog', { name: 'Unsaved changes' }).count(), 0);
  assert.equal(writes.length, 0);
  await page.getByRole('button', { name: 'Rich text', exact: true }).click();
  await editor.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Show sections', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Document section navigation' });
  await drawer.getByRole('textbox', { name: 'Search sections' }).fill('Example Labs');
  if (process.env.CAREER_WORKSPACE_ARTIFACT_DIR) await page.screenshot({ path: path.join(process.env.CAREER_WORKSPACE_ARTIFACT_DIR, 'cv-outline-mobile.png'), fullPage: true });
  await drawer.getByRole('button', { name: 'Example Labs', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#workspace-pages-drawer').open && document.activeElement?.textContent === 'Example Labs');
  assert.match(await editor.innerText(), /Summary[\s\S]*English/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status', { name: 'Document save status' }).filter({ hasText: 'Saved.' }).waitFor();
  assert.equal(read().content, draft);
  assert.equal(writes.length, 1);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/context`);
  const pages = page.getByRole('navigation', { name: 'Workspace pages' });
  await pages.getByRole('button', { name: 'Work records', exact: true }).click();
  await page.getByRole('heading', { name: 'Work records', exact: true, level: 1 }).waitFor();
  assert.equal(await pages.getByRole('button', { name: 'Body heading', exact: true }).count(), 0, 'source page headings never become child pages');
}));
