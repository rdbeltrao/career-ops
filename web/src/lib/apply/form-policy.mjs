/**
 * Runs in the page, before either extractor. Cookie managers often keep their
 * checkbox inputs mounted even when the preferences dialog is hidden. Exclude
 * those controls without clicking anything or changing consent choices.
 * Keep this function self-contained: Playwright serializes it into the frame.
 */
export function markCookieControls() {
  for (const el of document.querySelectorAll('[data-co-cookie]')) el.removeAttribute('data-co-cookie');
  const roots = [
    '#onetrust-banner-sdk', '#onetrust-pc-sdk', '#CybotCookiebotDialog',
    '#CybotCookiebotDialogDetail', '#truste-consent-track', '#truste-consent-content',
    '.qc-cmp2-container', '#usercentrics-root', '#usercentrics-cmp-ui', '#didomi-host',
    '[id*="cookie" i]:not(body):not(html)', '[class*="cookie" i]:not(body):not(html)',
    '[data-testid*="cookie" i]', '[id*="consent-manager" i]', '[class*="consent-manager" i]',
  ].join(', ');
  const controls = document.querySelectorAll('input, textarea, select, [role="combobox"], [role="radiogroup"], [contenteditable="true"]');
  for (const el of controls) {
    const dialog = el.closest('[role="dialog"], [role="alertdialog"], dialog');
    const title = dialog && [
      dialog.getAttribute('aria-label'),
      ...(dialog.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent),
      dialog.querySelector('h1, h2, h3, [role="heading"]')?.textContent,
    ].filter(Boolean).join(' ');
    const toggle = /^(checkbox|radio)$/i.test(el.getAttribute('type') || '');
    const label = ([
      el.getAttribute('aria-label'),
      el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent,
      el.closest('label')?.textContent,
    ].find((s) => s?.trim()) || '').replace(/\s+/g, ' ').trim();
    // Some ATSs render these exact category labels outside any named CMP root.
    const category = toggle && /^(?:enable|allow)\s+(?:functional|analytics|performance|advertisement|advertising)(?:\s+cookies?)?$/i.test(label);
    if (!el.parentElement?.closest(roots) && !/\bcookies?\b/i.test(title || '') && !category) continue;
    el.setAttribute('data-co-cookie', 'true');
    el.removeAttribute('data-co-field');
    el.removeAttribute('data-co-option');
    el.removeAttribute('data-co-cand');
  }
}

/** Application signals must beat search/filter widgets and optional toggles. */
export function looksLikeApplicationForm(form) {
  const fs = form.fields;
  if (fs.length === 0) return false;
  const lab = (f) => (f.label || '').toLowerCase();
  const hasFile = fs.some((f) => f.type === 'file');
  const hasEmail = fs.some((f) => f.type === 'email' || /e-?mail/.test(lab(f)));
  const hasAppish = fs.some((f) => /first name|last name|full name|resume|résumé|\bcv\b|cover letter|phone|linkedin|github|why |portfolio|sponsorship|relocat/.test(lab(f)));
  if (hasFile || hasEmail || hasAppish) return true;
  const allSearch = fs.every(
    (f) => /search|buscar|filtr|keyword|palabra|department|departa|office|oficina|location|ubicaci|remote|category|categor/.test(lab(f)) || /filter|search|keyword/.test((f.nativeId || '').toLowerCase()),
  );
  if (allSearch) return false;
  // A cookie category panel with four optional toggles used to pass solely
  // because the old sparse-form cutoff was three fields.
  if (fs.every((f) => ['checkbox', 'radio'].includes(f.type)) && fs.every((f) => !f.required)) return false;
  if (fs.length <= 3 && fs.every((f) => !f.required)) return false;
  return true;
}
