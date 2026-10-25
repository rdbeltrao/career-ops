// tests/linkedin-apply.test.mjs — the employer's application URL behind a
// LinkedIn "Apply on company website" button.
//
// The markup below mirrors what the signed-in crawl profile saw on 2026-10-25
// (tracking tokens replaced): the search-results pane renders the button with
// no href, and the direct posting page renders it as a link through LinkedIn's
// safety/go redirect with the employer URL in its `url` parameter. Signed-out
// pages carry no URL at all, which is why this reads the signed-in page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPLY_STORE_FILE,
  applyKindFromHtml,
  applyStorePath,
  linkedInRedirectTarget,
  loadApplyStore,
  lookupApply,
  offsiteApplyUrlFromHtml,
  recordApply,
} from '../lib/linkedin-apply.mjs';

const ASHBY = 'https://jobs.ashbyhq.com/secfix/2b0656e4-0827-4e29-a84b-795d2aa14edb/application?utm_source=linkedinpaid';

const DIRECT_PAGE = `
<div class="top-card">
  <a aria-label="Apply on company website" class="l4jlhg l4jlhf"
     href="https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fjobs%2Eashbyhq%2Ecom%2Fsecfix%2F2b0656e4-0827-4e29-a84b-795d2aa14edb%2Fapplication%3Futm_source%3Dlinkedinpaid&amp;urlhash=AAAA&amp;mt=TOKEN&amp;isSdui=true">Apply</a>
  <a href="https://www.linkedin.com/jobs/search-results/?currentJobId=1&amp;keywords=x">Similar job</a>
</div>`;

const PANE_OFFSITE = `
<div class="jobs-apply-button--top-card">
  <button role="link" aria-label="Apply to Senior Engineering Manager, Product Engineering on company website" id="jobs-apply-button-id" class="jobs-apply-button artdeco-button">Apply</button>
</div>`;

const PANE_EASY = `
<div class="jobs-apply-button--top-card">
  <button aria-label="Easy Apply to Staff Engineer at Acme" id="jobs-apply-button-id" class="jobs-apply-button artdeco-button">Easy Apply</button>
</div>`;

test('linkedInRedirectTarget: decodes the employer URL from each LinkedIn redirect shape', () => {
  assert.equal(linkedInRedirectTarget('https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fjobs%2Eashbyhq%2Ecom%2Fsecfix%2F2b0656e4-0827-4e29-a84b-795d2aa14edb%2Fapplication%3Futm_source%3Dlinkedinpaid&urlhash=J48d'), ASHBY);
  assert.equal(linkedInRedirectTarget('https://www.linkedin.com/redir/redirect/?url=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F1'), 'https://boards.greenhouse.io/acme/jobs/1');
  assert.equal(linkedInRedirectTarget('https://de.linkedin.com/jobs/view/externalApply/4001?url=https%3A%2F%2Fjobs.lever.co%2Facme%2F1&urlHash=x'), 'https://jobs.lever.co/acme/1');
  assert.equal(linkedInRedirectTarget('https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fjobs.ashbyhq.com%2Fx&amp;urlhash=1'), 'https://jobs.ashbyhq.com/x', 'an HTML-escaped ampersand still parses');
});

test('linkedInRedirectTarget: refuses anything that is not a LinkedIn redirect to an http(s) employer page', () => {
  for (const href of [
    '',
    'not a url',
    'https://evil.example/safety/go/?url=https%3A%2F%2Fjobs.lever.co%2Fx', // not LinkedIn
    'https://linkedin.com.evil.example/safety/go/?url=https%3A%2F%2Fjobs.lever.co%2Fx',
    'https://www.linkedin.com/safety/go/?url=javascript%3Aalert(1)',
    'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fwww.linkedin.com%2Fjobs%2Fview%2F1', // back to LinkedIn
    'https://www.linkedin.com/safety/go/', // no url
    'https://www.linkedin.com/jobs/view/4001', // not a redirect
  ]) {
    assert.equal(linkedInRedirectTarget(href), null, href);
  }
});

test('offsiteApplyUrlFromHtml: reads the apply link of the direct posting page, not other links', () => {
  assert.equal(offsiteApplyUrlFromHtml(DIRECT_PAGE), ASHBY);
  assert.equal(offsiteApplyUrlFromHtml(PANE_OFFSITE), null, 'the search pane has a button and no URL');
  assert.equal(offsiteApplyUrlFromHtml(''), null);
});

test('applyKindFromHtml: offsite, Easy Apply, or unknown', () => {
  assert.equal(applyKindFromHtml(PANE_OFFSITE), 'offsite');
  assert.equal(applyKindFromHtml(DIRECT_PAGE), 'offsite');
  assert.equal(applyKindFromHtml(PANE_EASY), 'easy-apply');
  assert.equal(applyKindFromHtml('<div>No longer accepting applications</div>'), '');
});

test('store: records board link, LinkedIn id and employer URL, and looks them up by any posting URL', () => {
  const root = mkdtempSync(join(tmpdir(), 'linkedin-apply-'));
  assert.deepEqual(loadApplyStore(root), {});
  assert.equal(applyStorePath(root), join(root, APPLY_STORE_FILE));

  recordApply(root, { id: '4480683016', applyUrl: ASHBY, kind: 'offsite', checkedAt: '2026-10-25' });
  recordApply(root, { id: '4001', applyUrl: '', kind: 'easy-apply', checkedAt: '2026-10-25' });

  const stored = JSON.parse(readFileSync(applyStorePath(root), 'utf8'));
  assert.deepEqual(stored['4480683016'], {
    linkedinUrl: 'https://www.linkedin.com/jobs/view/4480683016/',
    applyUrl: ASHBY,
    kind: 'offsite',
    checkedAt: '2026-10-25',
  });

  for (const url of [
    'https://www.linkedin.com/jobs/view/4480683016/',
    'https://de.linkedin.com/jobs/view/senior-engineering-manager-product-engineering-at-secfix-4480683016',
    'https://www.linkedin.com/jobs/search/?currentJobId=4480683016',
  ]) {
    assert.equal(lookupApply(root, url)?.applyUrl, ASHBY, url);
    assert.equal(lookupApply(root, url)?.id, '4480683016');
  }
  assert.equal(lookupApply(root, 'https://www.linkedin.com/jobs/view/4001')?.kind, 'easy-apply');
  assert.equal(lookupApply(root, 'https://jobs.lever.co/acme/1'), null, 'not a LinkedIn posting');
  assert.equal(lookupApply(root, 'https://www.linkedin.com/jobs/view/999'), null, 'never seen');
});

test('store: a later check never erases a known employer URL, and a bad URL is not stored', () => {
  const root = mkdtempSync(join(tmpdir(), 'linkedin-apply-'));
  recordApply(root, { id: '7', applyUrl: ASHBY, kind: 'offsite', checkedAt: '2026-10-01' });
  recordApply(root, { id: '7', applyUrl: '', kind: 'offsite', checkedAt: '2026-10-25' });
  assert.equal(loadApplyStore(root)['7'].applyUrl, ASHBY);
  assert.equal(loadApplyStore(root)['7'].checkedAt, '2026-10-25');

  recordApply(root, { id: '8', applyUrl: 'javascript:alert(1)', kind: 'offsite', checkedAt: '2026-10-25' });
  assert.equal(loadApplyStore(root)['8'].applyUrl, '');
  assert.throws(() => recordApply(root, { id: '../x', applyUrl: ASHBY, kind: 'offsite' }), /id/);
});
