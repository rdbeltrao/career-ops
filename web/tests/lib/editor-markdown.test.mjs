import assert from 'node:assert/strict';
import { test } from 'node:test';
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical';
import { $removeSlashQuery, analyzeMarkdown, EDITOR_NODES, EDITOR_TRANSFORMERS, roundTripMarkdown, safeLinkUrl } from '../../src/lib/editor-markdown.mjs';

test('slash cleanup uses the live range after a stale typeahead split without deleting preceding prose', () => {
  for (let split = 1; split < '/heading'.length; split++) {
    const editor = createEditor({ onError: (error) => { throw error; } });
    editor.update(() => {
      const paragraph = $createParagraphNode();
      const before = $createTextNode(`Keep this ${'/heading'.slice(0, split)}`);
      const suffix = $createTextNode('/heading'.slice(split));
      paragraph.append(before, suffix);
      $getRoot().append(paragraph);
      suffix.selectEnd();
      assert.equal($removeSlashQuery(), true, `stale split ${split}`);
      assert.equal(paragraph.getTextContent(), 'Keep this ', `stale split ${split}`);
    }, { discrete: true });
  }
});

test('slash cleanup leaves ordinary prose and URL paths untouched', () => {
  for (const text of ['Keep this', 'https://example.com/heading', 'path/heading']) {
    const editor = createEditor({ onError: (error) => { throw error; } });
    editor.update(() => {
      const node = $createTextNode(text);
      const paragraph = $createParagraphNode().append(node);
      $getRoot().append(paragraph); node.selectEnd();
      assert.equal($removeSlashQuery(), false);
      assert.equal(paragraph.getTextContent(), text);
    }, { discrete: true });
  }
});

test('headings, evidence labels, numbers and source URLs round-trip without semantic loss', () => {
  const markdown = '# Profile\n\n**Strong**: 45% over 2026; _Needs confirmation_.\n\n[Source](https://example.com/report?q=1#metrics) and `Node.js`.\n';
  assert.equal(analyzeMarkdown(markdown).safe, true);
  const result = roundTripMarkdown(markdown);
  assert.match(result, /45% over 2026/);
  assert.match(result, /https:\/\/example.com\/report\?q=1#metrics/);
  assert.match(result, /Needs confirmation/);
});

test('nested lists, ordered numbering, quotes and fenced code preserve their meaning', () => {
  const markdown = '3. Delivery\n   - Team outcome\n     - Personal action\n\n> [!NOTE]\n> Needs confirmation\n\n```js\nconst text = "# not a heading";\n```\n';
  assert.equal(analyzeMarkdown(markdown).safe, true);
  assert.match(roundTripMarkdown(markdown), /3\. Delivery/);
  assert.match(roundTripMarkdown(markdown), /\[!NOTE\]/);
});

test('empty text and ordinary paragraphs support rich editing', () => {
  for (const markdown of ['', '\n', 'A source-backed statement.', 'First paragraph.\n\nSecond paragraph.']) {
    assert.equal(analyzeMarkdown(markdown).safe, true, JSON.stringify(markdown));
  }
});

test('ordinary achievement sections with thematic breaks remain safely editable', () => {
  for (const divider of ['---', '***', '___', '- - -']) {
    const markdown = `# Approved achievements\n\n## EX01 — Delivery\n\n- **Confirmed:** 45% improvement.\n- [Evidence](https://example.com/source?q=1#proof)\n\n${divider}\n\n## EX02 — Team\n\nA source-backed statement.\n`;
    assert.equal(analyzeMarkdown(markdown).safe, true, divider);
    assert.match(roundTripMarkdown(markdown), /45% improvement/);
    assert.match(roundTripMarkdown(markdown), /https:\/\/example.com\/source\?q=1#proof/);
  }
});

test('a thematic-break shortcut cannot discard a following formatted text node', () => {
  const editor = createEditor({ nodes: EDITOR_NODES, onError: (error) => { throw error; } });
  editor.update(() => {
    const marker = $createTextNode('--- ');
    const evidence = $createTextNode('Keep this 45% claim').toggleFormat('bold');
    const paragraph = $createParagraphNode().append(marker, evidence);
    $getRoot().append(paragraph);
    // Lexical matches the first text node and supplies the remaining siblings.
    // A block-only shortcut must decline when any of those contain content.
    const result = EDITOR_TRANSFORMERS[0].replace(paragraph, [evidence], ['--- '], false);
    assert.equal(result, false);
    assert.equal($getRoot().getTextContent(), '--- Keep this 45% claim');
    assert.ok(evidence.hasFormat('bold'));
  }, { discrete: true });
});

test('unsupported Markdown keeps exact source and explains fallback', () => {
  for (const markdown of [
    '| Claim | Source |\n| --- | --- |\n| 45% | report |\n',
    '<details><summary>Original</summary>Private notes</details>\n',
    '<!-- source: original -->\nA fact.\n',
    '![Proof](https://example.com/proof.png)\n',
    '[Evidence][source]\n\n[source]: https://example.com/original\n',
    'Term\n: Definition\n',
    '---\ntitle: Source\n---\n',
    '- [x] Reviewed\n',
    'A footnote[^1].\n\n[^1]: Source\n',
    'A &amp; B\n',
    '    indented code\n',
    '~~~js\nconst value = 1;\n~~~\n',
    '<https://example.com/source>\n',
  ]) {
    const result = analyzeMarkdown(markdown);
    assert.equal(result.safe, false, JSON.stringify(markdown));
    assert.equal(result.source, markdown);
    assert.ok(result.reason.length > 0);
  }
});

test('semantic guard refuses a conversion that changes escaped literal formatting or hard breaks', () => {
  for (const markdown of ['Literal \\*not italic\\*.\n', 'A hard break.  \nSecond line.\n']) {
    const result = analyzeMarkdown(markdown);
    // Supported is only acceptable when conversion is proven equivalent.
    if (result.safe) assert.ok(result.equivalent);
    else assert.equal(result.source, markdown);
  }
});

test('source checks do not confuse fenced examples with document syntax', () => {
  const markdown = '```md\n| A | B |\n| --- | --- |\n<!-- sample -->\n- [x] sample\n```\n';
  assert.equal(analyzeMarkdown(markdown).safe, true);
});

test('links accept web, email, fragments and relative references, rejecting executable protocols', () => {
  for (const url of ['https://example.com', 'http://localhost:3000/context', 'mailto:person@example.com', '#source', '/context']) {
    assert.equal(safeLinkUrl(url), true, url);
  }
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', ' vbscript:test', '//evil.test', 'java\nscript:alert(1)']) {
    assert.equal(safeLinkUrl(url), false, url);
  }
});

test('unsupported pages open formatted and source remains an explicit lossless view', { skip: !process.env.EDITOR_MARKDOWN_TEST_URL, timeout: 90_000 }, async () => {
  const target = new URL(process.env.EDITOR_MARKDOWN_TEST_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const content = '# Evidence summary\r\n\r\n| Claim | Source |\r\n| --- | --- |\r\n| **45%** | [Original](https://example.com/evidence?q=7) |\r\n\r\n---\r\n\r\nA hard break.  \r\nSecond line.\r\n';
  const doc = { id: 'context', title: 'Career context', group: 'Context', description: 'Fictional formatted fallback', exists: true, content, revision: 'fixture', sections: [] };
  const writes = [];
  await page.route('**/api/workspace**', (route) => {
    if (route.request().method() !== 'GET') {
      writes.push(route.request().postDataJSON());
      return route.fulfill({ json: { ...doc, content: writes.at(-1).content, revision: 'saved', selectedSection: null } });
    }
    return route.fulfill({ json: new URL(route.request().url()).searchParams.has('document') ? doc : { documents: [doc] } });
  });
  try {
    await page.goto(`${target.origin}/context?document=context`);
    // The workspace Save control mounts before its lazy editor chunk finishes.
    await page.locator('[aria-label="Formatted page"], textarea[aria-label="Markdown source"]').first().waitFor();
    const preview = page.getByRole('article', { name: 'Formatted page', exact: true });
    assert.equal(await preview.count(), 1, 'unsupported Markdown defaults to a formatted page');
    assert.equal(await page.getByRole('textbox', { name: 'Markdown source', exact: true }).count(), 0);
    assert.equal(await preview.getByRole('heading', { name: 'Evidence summary' }).count(), 1);
    assert.equal(await preview.getByRole('table').count(), 1);
    assert.equal(await preview.locator('hr').count(), 1);
    assert.equal(await preview.locator('br').count(), 1);
    assert.equal(await preview.getByRole('link', { name: 'Original' }).getAttribute('href'), 'https://example.com/evidence?q=7');
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    const source = page.getByRole('textbox', { name: 'Markdown source', exact: true });
    // HTML textarea values normalise CRLF, but toggling must never publish that
    // browser normalisation or write a replacement document.
    assert.equal(await source.inputValue(), content.replace(/\r\n/g, '\n'));
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    assert.equal(await preview.getByRole('table').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    assert.equal(writes.length, 0);
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    const edited = `${content.replace(/\r\n/g, '\n')}\nAdded source note.\n`;
    await source.fill(edited);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    assert.match(await preview.innerText(), /Added source note\./);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await preview.waitFor();
    assert.equal(writes.at(-1).content, edited, 'formatted view saves the exact edited source');
  } finally { await browser.close(); }
});

test('page navigation shows ordinary proof points and hides source-only comments', { skip: !process.env.EDITOR_MARKDOWN_TEST_URL, timeout: 90_000 }, async () => {
  const target = new URL(process.env.EDITOR_MARKDOWN_TEST_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const content of [
      '# Approved achievements\n\n## EX01 — Delivery\n\n- **Confirmed:** 45% improvement.\n- [Evidence](https://example.com/proof)\n\n---\n',
      '<!-- Internal fixture guidance: do not show this note. -->\n\n# Career context\n\n**Confirmed:** 45% improvement.\n\n[Evidence](https://example.com/proof)\n\n<script>window.__unsafePreview=true</script>\n\n[Unsafe](javascript:alert(1))\n',
    ]) {
      const page = await browser.newPage();
      const doc = { id: 'context', title: 'Career context', group: 'Context', description: 'Fictional readable page', exists: true, content, revision: 'fixture', sections: [] };
      await page.route('**/api/workspace**', (route) => {
        assert.equal(route.request().method(), 'GET', 'opening and switching views never writes');
        return route.fulfill({ json: new URL(route.request().url()).searchParams.has('document') ? doc : { documents: [doc] } });
      });
      await page.goto(`${target.origin}/context?document=context`);
      await page.getByRole('button', { name: 'Source', exact: true }).waitFor();
      const body = content.startsWith('#') ? page.getByRole('textbox', { name: 'Page content', exact: true }) : page.getByRole('article', { name: 'Formatted page', exact: true });
      assert.equal(await body.count(), 1);
      assert.match(await body.innerText(), /Confirmed: 45% improvement\./);
      assert.doesNotMatch(await body.innerText(), /Internal fixture guidance|window\.__unsafePreview|\*\*Confirmed/);
      assert.equal(await body.getByRole('link', { name: 'Evidence' }).getAttribute('href'), 'https://example.com/proof');
      if (content.startsWith('#')) assert.equal(await body.locator('hr').count(), 1);
      else assert.equal(await body.getByRole('link', { name: 'Unsafe' }).count(), 0);
      assert.equal(await page.evaluate(() => window.__unsafePreview), undefined);
      await page.getByRole('button', { name: 'Source', exact: true }).click();
      assert.equal(await page.getByRole('textbox', { name: 'Markdown source', exact: true }).inputValue(), content);
      assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('rich editor controls preserve source and neutralise pasted unsafe links', { skip: !process.env.EDITOR_MARKDOWN_TEST_URL, timeout: 90_000 }, async () => {
  const target = new URL(process.env.EDITOR_MARKDOWN_TEST_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const content = 'First paragraph.\n\nSecond paragraph.\n';
  const doc = { id: 'context', title: 'Career context', group: 'Context', description: 'Fictional editor test', exists: true, content, revision: 'fixture', sections: [] };
  const writes = [];
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  // Every workspace read/write is mocked: this test cannot change server files.
  await page.route('**/api/workspace**', (route) => {
    if (route.request().method() !== 'GET') {
      writes.push(route.request().postDataJSON());
      return route.fulfill({ json: { ...doc, content: writes.at(-1).content, revision: 'saved', selectedSection: null } });
    }
    return route.fulfill({ json: new URL(route.request().url()).searchParams.has('document') ? doc : { documents: [doc] } });
  });
  try {
    await page.goto(`${target.origin}/context?document=context`);
    const editor = page.getByRole('textbox', { name: 'Page content', exact: true });
    await editor.waitFor();
    assert.equal(writes.length, 0);
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);

    await editor.fill('A confirmed statement.');
    await page.keyboard.press('ControlOrMeta+A');
    await page.getByRole('button', { name: 'Bold', exact: true }).click();
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    const source = page.getByRole('textbox', { name: 'Markdown source', exact: true });
    assert.match(await source.inputValue(), /\*\*A confirmed statement\.\*\*/);
    // Reset formatting before the independent link scenario. A contenteditable
    // fill may legitimately inherit the selection's previous bold format.
    await source.fill('Source record');
    await page.getByRole('button', { name: 'Rich text', exact: true }).click();

    await editor.fill('Source record');
    await page.keyboard.press('ControlOrMeta+A');
    await page.getByRole('button', { name: 'Add or edit link', exact: true }).click();
    await page.getByRole('textbox', { name: 'Link URL', exact: true }).fill('https://example.com/evidence?q=7');
    await page.getByRole('button', { name: 'Apply link', exact: true }).click();
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    assert.match(await source.inputValue(), /\[Source record\]\(https:\/\/example.com\/evidence\?q=7\)/);
    await page.getByRole('button', { name: 'Rich text', exact: true }).click();

    await editor.fill('');
    await editor.pressSequentially('/heading');
    await page.getByRole('listbox', { name: 'Insert block' }).waitFor();
    await page.keyboard.press('Enter');
    await page.keyboard.type('New heading');
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    assert.match(await source.inputValue(), /^# New heading/);

    await source.fill('Keep this');
    await page.getByRole('button', { name: 'Rich text', exact: true }).click();
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await editor.pressSequentially(' /heading');
    await page.getByRole('listbox', { name: 'Insert block' }).getByRole('option').filter({ hasText: 'Heading 2' }).click();
    await page.keyboard.type('with a mouse selection');
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    assert.match(await source.inputValue(), /^## Keep this with a mouse selection/);
    assert.doesNotMatch(await source.inputValue(), /\/head/);

    await source.fill('First paragraph.\n\nSecond paragraph.');
    await page.getByRole('button', { name: 'Rich text', exact: true }).click();
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.getByRole('button', { name: 'Move block up', exact: true }).click();
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    assert.ok((await source.inputValue()).startsWith('Second paragraph.'));

    await source.fill('**Keep this 45% claim**\n');
    await page.getByRole('button', { name: 'Rich text', exact: true }).click();
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.getByRole('button', { name: 'Bold', exact: true }).click();
    await editor.pressSequentially('--- ');
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    assert.match(await source.inputValue(), /\*\*Keep this 45% claim\*\*/, 'a divider shortcut preserves following formatted evidence');

    await source.fill('Safe text.');
    await page.getByRole('button', { name: 'Rich text', exact: true }).click();
    await editor.focus();
    await editor.evaluate((element) => {
      const data = new DataTransfer();
      data.setData('text/html', '<a href="javascript:window.__unsafeEditorLink=true">Untrusted source</a>');
      data.setData('text/plain', 'Untrusted source');
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    const hrefs = await editor.locator('a').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    assert.ok(hrefs.every((href) => !/^\s*(javascript|data|vbscript):/i.test(href ?? '')));
    assert.equal(await page.evaluate(() => window.__unsafeEditorLink), undefined);
    assert.deepEqual(pageErrors, []);
  } finally { await browser.close(); }
});

test('an open link form cannot mutate the editor while a save is pending', { skip: !process.env.EDITOR_MARKDOWN_TEST_URL, timeout: 90_000 }, async () => {
  const target = new URL(process.env.EDITOR_MARKDOWN_TEST_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const doc = { id: 'context', title: 'Career context', group: 'Context', description: 'Fictional editor test', exists: true, content: '[Source record](https://example.com/original)\n', revision: 'fixture', sections: [] };
  let releaseSave;
  let receivedSave;
  let payload;
  const delayedSave = new Promise((resolve) => { releaseSave = resolve; });
  const requestReceived = new Promise((resolve) => { receivedSave = resolve; });
  await page.route('**/api/workspace**', async (route) => {
    if (route.request().method() !== 'GET') {
      payload = route.request().postDataJSON();
      receivedSave();
      await delayedSave;
      return route.fulfill({ json: { ...doc, content: payload.content, revision: 'saved', selectedSection: null } });
    }
    return route.fulfill({ json: new URL(route.request().url()).searchParams.has('document') ? doc : { documents: [doc] } });
  });
  try {
    await page.goto(`${target.origin}/context?document=context`);
    const editor = page.getByRole('textbox', { name: 'Page content', exact: true });
    await editor.waitFor();
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.getByRole('button', { name: 'Bold', exact: true }).click();
    await page.getByRole('button', { name: 'Add or edit link', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Link URL', exact: true });
    await input.fill('https://example.com/unsaved-change');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await requestReceived;
    assert.equal(await input.isDisabled(), true, 'link URL is disabled during save');
    const apply = page.getByRole('button', { name: 'Apply link', exact: true });
    const remove = page.getByRole('button', { name: 'Remove link', exact: true });
    assert.equal(await apply.isDisabled(), true, 'applying a link is disabled during save');
    assert.equal(await remove.isDisabled(), true, 'removing a link is disabled during save');
    const before = await editor.innerHTML();
    // Submit can also arrive through Enter or a queued event, so disabling the
    // button alone is not a sufficient mutation guard.
    await page.getByRole('form', { name: 'Edit link', exact: true }).dispatchEvent('submit');
    await remove.dispatchEvent('click');
    assert.equal(await editor.innerHTML(), before, 'pending save freezes link mutations');
    assert.match(payload.content, /https:\/\/example.com\/original/);
    assert.doesNotMatch(payload.content, /unsaved-change/);
    releaseSave();
    await page.getByRole('button', { name: 'Save', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    const source = await page.getByRole('textbox', { name: 'Markdown source', exact: true }).inputValue();
    assert.equal(source, payload.content, 'saved document exactly matches the submitted draft');
  } finally { releaseSave(); await browser.close(); }
});
