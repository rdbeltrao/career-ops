import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { looksLikeApplicationForm } from '../../src/lib/apply/form-policy.mjs';

const categories = ['Functional', 'Analytics', 'Performance', 'Advertisement'];
const cookieFields = categories.map((category, i) => ({ id: `co${i}`, label: `Enable ${category}`, type: 'checkbox', required: false }));
const form = (fields) => ({ title: 'Careers | Ashby', url: 'https://jobs.ashbyhq.com/fixture', fields });

test('four optional cookie categories are not an application form', () => {
  assert.equal(looksLikeApplicationForm(form(cookieFields)), false);
  assert.equal(looksLikeApplicationForm(form([...cookieFields, ...cookieFields, ...cookieFields])), false);
});

test('application fields still qualify with data-processing consent', () => {
  assert.equal(looksLikeApplicationForm(form([
    { type: 'email', label: 'Email', required: true },
    { type: 'checkbox', label: 'I consent to processing my application data', required: true },
  ])), true);
  assert.equal(looksLikeApplicationForm(form([{ type: 'file', label: 'Resume', required: true }])), true);
});

test('empty forms and job-board filters still do not qualify', () => {
  assert.equal(looksLikeApplicationForm(form([])), false);
  assert.equal(looksLikeApplicationForm(form(['Search', 'Department', 'Location', 'Category'].map((label) => ({ type: 'select', label, required: true })))), false);
});

// Local DOM fixtures only. No employer navigation, workers, or submissions.
test('cookie filtering and frame selection against real DOM', { skip: !process.env.APPLY_FORM_BROWSER_TEST, timeout: 60_000 }, async (t) => {
  // Node strips TypeScript; resolve the session module's Next aliases/extensions.
  const src = fileURLToPath(new URL('../../src/', import.meta.url));
  register(`data:text/javascript,${encodeURIComponent(`
    import { existsSync } from 'node:fs';
    import { pathToFileURL, fileURLToPath } from 'node:url';
    import path from 'node:path';
    export async function resolve(specifier, context, nextResolve) {
      const base = specifier.startsWith('@/') ? path.join(${JSON.stringify(src)}, specifier.slice(2))
        : specifier.startsWith('.') ? fileURLToPath(new URL(specifier, context.parentURL)) : null;
      if (base) for (const ext of ['', '.ts', '.mjs', '.js']) {
        if (existsSync(base + ext)) return { url: pathToFileURL(base + ext).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
  `)}`, import.meta.url);
  const { chromium } = await import('playwright-core');
  const { extractForm } = await import('../../src/lib/apply/extract.ts');
  const { captureCandidates } = await import('../../src/lib/apply/agent-interpret.ts');
  const { pickFormFrame } = await import('../../src/lib/apply/session.ts');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const toggles = categories.map((category, i) => `<label for="category-${i}">Enable ${category}</label><input id="category-${i}" type="checkbox" aria-label="Enable ${category}" ${i === 0 ? 'checked' : ''}>`).join('');
  const application = '<form><label>Email<input type="email" required></label><label>I consent to processing my application data<input id="data-consent" type="checkbox" required></label><label>Resume<input type="file" style="display:none"></label></form>';

  await t.test('visible and hidden cookie dialogs produce no fields or fill handles', async () => {
    for (const hidden of [false, true]) {
      await page.setContent(`<div role="dialog" aria-label="Cookie settings" ${hidden ? 'style="display:none"' : ''}>${toggles}</div>`);
      const extracted = await extractForm(page.mainFrame());
      assert.deepEqual(extracted.fields, []);
      assert.deepEqual(await captureCandidates(page.mainFrame()), [], 'AI must never receive cookie controls');
      assert.equal(await page.locator('[data-co-field]').count(), 0);
      assert.equal(await page.locator('input:checked').count(), 1, 'consent choices must not change');
    }
  });

  await t.test('unnamed cookie category controls are excluded by label', async () => {
    await page.setContent(toggles);
    assert.deepEqual((await extractForm(page.mainFrame())).fields, []);
    assert.deepEqual(await captureCandidates(page.mainFrame()), []);
  });

  await t.test('real application survives a mounted hidden cookie manager', async () => {
    await page.setContent(`${application}<div id="onetrust-pc-sdk" hidden>${toggles}<input type="radio" name="tracking" value="yes"></div>`);
    const extracted = await extractForm(page.mainFrame());
    assert.deepEqual(extracted.fields.map((f) => f.label), ['Email', 'I consent to processing my application data']);
    assert.equal(await page.locator('#data-consent[data-co-field]').count(), 1, 'candidate data consent must remain fillable');
    assert.equal(await page.locator('#onetrust-pc-sdk [data-co-field]').count(), 0);
    assert.equal((await captureCandidates(page.mainFrame())).length, 2);
  });

  await t.test('cookie manager iframe does not win over the application', async () => {
    await page.setContent(`${application}<iframe></iframe>`);
    const cookieFrame = page.frames().find((f) => f !== page.mainFrame());
    await cookieFrame.setContent(`<div id="cookie-preferences">${toggles}</div>`);
    const picked = await pickFormFrame(page);
    assert.ok(picked.frame === page.mainFrame(), 'application in the main frame must win');
    assert.equal(picked.form.fields[0].label, 'Email');
  });

  await t.test('embedded application beats a larger job-board filter panel', async () => {
    await page.setContent(`<form>${['Search', 'Department', 'Location', 'Category', 'Office'].map((label) => `<label>${label}<input id="${label.toLowerCase()}-filter" required></label>`).join('')}</form><iframe></iframe>`);
    const applicationFrame = page.frames().find((f) => f !== page.mainFrame());
    await applicationFrame.setContent(application);
    const picked = await pickFormFrame(page);
    assert.ok(picked.frame === applicationFrame, 'embedded application must beat job-board filters');
    assert.equal(picked.form.fields[0].label, 'Email');
  });

  await t.test('radio grouping cannot pull cookie controls back into an application', async () => {
    await page.setContent('<fieldset><legend>Authorized to work?</legend><label><input type="radio" name="shared" value="Yes">Yes</label><label><input type="radio" name="shared" value="No">No</label></fieldset><div class="cookie-consent"><input type="radio" name="shared" value="Tracking"></div>');
    const extracted = await extractForm(page.mainFrame());
    assert.deepEqual(extracted.fields[0].options, ['Yes', 'No']);
    assert.equal(await page.locator('.cookie-consent [data-co-field]').count(), 0);
  });

  await t.test('re-extraction clears stale cookie handles without permanently excluding moved fields', async () => {
    await page.setContent('<div id="cookie-settings"><input id="choice" type="checkbox" data-co-field="co0" data-co-cand="0"></div>');
    assert.deepEqual((await extractForm(page.mainFrame())).fields, []);
    assert.equal(await page.locator('[data-co-field], [data-co-cand]').count(), 0);
    await page.locator('#choice').evaluate((el) => {
      document.body.append(el);
      el.setAttribute('aria-label', 'I consent to processing my application data');
    });
    assert.equal((await extractForm(page.mainFrame())).fields.length, 1);
  });

  await t.test('mentioning cookies in an application question does not exclude it', async () => {
    await page.setContent('<label for="cookie-experience">Describe your experience with cookie security</label><textarea id="cookie-experience"></textarea>');
    assert.equal((await extractForm(page.mainFrame())).fields.length, 1);
    assert.equal((await captureCandidates(page.mainFrame())).length, 1);
  });
});
