import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jdFromDescribedOffer, storeOfferJds } from '../scan.mjs';

test('jdFromDescribedOffer builds a JD-store object from a described offer and nothing from a bare one', () => {
  const jd = jdFromDescribedOffer({ url: 'https://acme.jobs.personio.de/job/1', title: 'EM', company: 'Acme', location: 'Berlin', description: 'Lead the team.', source: 'personio', externalId: '1', postedAt: Date.UTC(2026, 9, 20) });
  assert.equal(jd.source, 'personio'); assert.equal(jd.source_id, '1'); assert.equal(jd.posted_date, '2026-10-20'); assert.equal(jd.description, 'Lead the team.');
  assert.equal(jdFromDescribedOffer({ url: 'https://x.test/j', title: 'EM', company: 'X' }), null, 'no description, nothing to store');
  const hashed = jdFromDescribedOffer({ url: 'https://x.test/j', description: 'text' });
  assert.match(hashed.source_id, /^[0-9a-f]{16}$/, 'an offer without an id gets a stable hash');
});

test('storeOfferJds writes described offers and still accepts an explicit jd object', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'co-jdstore-'));
  const offers = [
    { url: 'https://acme.jobs.personio.de/job/1', title: 'EM', company: 'Acme', description: 'Lead.', source: 'personio', externalId: '1' },
    { url: 'https://x.test/2', title: 'EM', company: 'X' },
    { url: 'https://www.linkedin.com/jobs/view/3/', jd: { url: 'https://www.linkedin.com/jobs/view/3/', title: 'EM', company: 'L', location: '', workplace: '', seniority: '', description: 'Lead.', posted_date: '', source: 'linkedin-browser', source_id: '3' } },
  ];
  const result = storeOfferJds(offers, { dataRoot, today: '2026-10-24' });
  assert.equal(result.written, 2); assert.deepEqual(result.failures, []);
  assert.ok(existsSync(join(dataRoot, 'jds', 'feeder', 'personio-1.json')));
  assert.match(readFileSync(join(dataRoot, 'data', 'jd-index.tsv'), 'utf-8'), /personio\.de\/job\/1/);
});
