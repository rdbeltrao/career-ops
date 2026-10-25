// Opt-in against a disposable fixture server; never run against real career data.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const target = process.env.YAML_CONFIG_TEST_URL;
const marker = '# Fictional YAML editor browser fixture.';

test('Config edits YAML, protects drafts, and rejects invalid or stale saves', { skip: !target, timeout: 180_000 }, async () => {
  const url = new URL(target);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  const origin = url.origin;
  async function read(id) {
    const response = await fetch(`${origin}/api/config-files?file=${id}`);
    assert.equal(response.status, 200);
    return response.json();
  }
  async function write(file, content) {
    const response = await fetch(`${origin}/api/config-files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ file: file.id, revision: file.revision, content }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  const original = await read('portals');
  assert.ok(original.content.startsWith(marker), 'only mutate the fictional browser fixture');
  assert.ok((await read('profile')).content.startsWith(marker));
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const opened = [];
  const writes = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.pathname !== '/api/config-files') return;
    if (request.method() === 'GET' && requestUrl.searchParams.has('file')) opened.push(requestUrl.searchParams.get('file'));
    if (request.method() === 'POST') writes.push(request.postDataJSON());
  });
  const editor = page.getByRole('textbox', { name: 'YAML content', exact: true });
  const selector = page.getByRole('combobox', { name: 'Configuration file', exact: true });
  const save = page.getByRole('button', { name: 'Save YAML', exact: true });
  async function select(id) {
    await selector.selectOption(id);
    await page.waitForFunction((id) => document.querySelector('#yaml-file-select')?.value === id && !document.querySelector('#yaml-file-select')?.disabled, id);
    await editor.waitFor();
  }
  async function saved() { await page.getByRole('status', { name: 'YAML save status' }).filter({ hasText: /^Saved\./ }).waitFor(); }
  try {
    await page.goto(`${origin}/config#yaml-portals`);
    await editor.waitFor();
    assert.equal(await editor.inputValue(), original.content);
    assert.deepEqual(opened, ['portals'], 'opening Config does not preload other YAML files');
    assert.equal(writes.length, 0, 'viewing never saves');
    assert.equal(await save.isDisabled(), true);
    const section = page.getByRole('region', { name: 'YAML configuration files', exact: true });
    assert.ok((await section.innerText()).includes(original.path));
    assert.ok((await section.boundingBox()).y < 150, 'deep link scrolls to YAML files');

    await editor.fill('title_filter: [');
    await save.click();
    await page.getByRole('alert').filter({ hasText: 'Invalid YAML' }).waitFor();
    assert.equal((await read('portals')).content, original.content);
    assert.equal(await editor.inputValue(), 'title_filter: [', 'failed save keeps draft');

    const edited = `${marker}\ntitle_filter:\n  positive: [Fictional Browser Engineer]\nlocation_filter:\n  allow: [Remote]\n`;
    await editor.fill(edited);
    await save.click();
    await saved();
    assert.equal((await read('portals')).content, edited);
    await page.reload();
    await editor.waitFor();
    assert.equal(await editor.inputValue(), edited);

    await editor.fill(`${edited}# Unsaved browser draft\n`);
    page.once('dialog', (dialog) => dialog.dismiss());
    await selector.selectOption('profile');
    assert.equal(await selector.inputValue(), 'portals');
    assert.match(await editor.inputValue(), /Unsaved browser draft/);
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('complementary', { name: 'App sidebar' }).getByRole('link', { name: 'Portals', exact: true }).click();
    assert.equal(new URL(page.url()).pathname, '/config');

    const outside = await write(await read('portals'), `${edited}# External edit\n`);
    await save.click();
    await page.getByRole('alert').filter({ hasText: 'changed elsewhere' }).waitFor();
    assert.match(await editor.inputValue(), /Unsaved browser draft/);
    assert.equal((await read('portals')).content, outside.content);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Reload file', exact: true }).click();
    await page.waitForFunction((content) => document.querySelector('#yaml-content')?.value === content, outside.content);

    for (const id of ['profile', 'jev-criteria', 'notion-map', 'plugins']) {
      const expected = await read(id);
      await select(id);
      assert.equal(await editor.inputValue(), expected.content);
    }
    const pluginFile = await read('plugins');
    if (!pluginFile.exists) await page.getByText('This file does not exist yet. Saving will create it.').waitFor();
    await editor.fill('plugins: []\n');
    if (!(await save.isDisabled())) { await save.click(); await saved(); }
    assert.equal((await read('plugins')).exists, true);

    await page.goto(`${origin}/config#yaml-profile`);
    await page.waitForFunction(() => document.querySelector('#yaml-file-select')?.value === 'profile' && !document.querySelector('#yaml-file-select')?.disabled);
    await editor.waitFor();
    assert.equal(await selector.inputValue(), 'profile', 'direct links select the requested file');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#yaml-files').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'editor fits a mobile viewport');
    if (process.env.YAML_CONFIG_ARTIFACT_DIR) {
      await mkdir(process.env.YAML_CONFIG_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.YAML_CONFIG_ARTIFACT_DIR, 'config-yaml-mobile.png'), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: path.join(process.env.YAML_CONFIG_ARTIFACT_DIR, 'config-yaml-desktop.png'), fullPage: true });
    }
    assert.deepEqual(errors, []);
  } finally {
    await write(await read('portals'), original.content);
    await browser.close();
  }
});
