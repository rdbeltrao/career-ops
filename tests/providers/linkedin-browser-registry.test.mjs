// tests/providers/linkedin-browser-registry.test.mjs — the fork-local provider
// routes only when providers.local/linkedin-browser.mjs exists, and the scan
// wiring around it: loadLocalProviders() in providers/_registry.mjs, the
// `skipped` resolve result, the sequential-last target order and the JD store
// write in scan.mjs.
//
// Run: node --test tests/providers/linkedin-browser-registry.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCAL_PROVIDERS_DIRNAME, LOCAL_PROVIDER_IDS, loadLocalProviders, loadProviders, resolveProvider,
} from '../../providers/_registry.mjs';
import { orderTargetsForSequentialProviders, storeOfferJds } from '../../scan.mjs';
import { readJdForUrl } from '../../lib/jd-store.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PROVIDERS_DIR = join(ROOT, 'providers');
const LOCAL_DIR = join(ROOT, LOCAL_PROVIDERS_DIRNAME);

/** Run `fn` with console.error captured; returns the captured lines. */
async function capturingWarnings(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.error = real;
  }
  return lines;
}

const ENTRY = { name: 'em-germany-7d', provider: 'linkedin-browser', search_url: 'https://www.linkedin.com/jobs/search/?keywords=x' };

test('the shipped providers/ set does not contain linkedin-browser', async () => {
  const providers = await loadProviders(PROVIDERS_DIR);
  assert.ok(providers.size > 0);
  assert.ok(!providers.has('linkedin-browser'), 'upstream refuses LinkedIn scraping; the module lives in providers.local/');
  assert.ok(!existsSync(join(PROVIDERS_DIR, 'linkedin-browser.mjs')));
});

test('with the module missing, provider: linkedin-browser resolves to a skip, not an error and not a crash', async () => {
  const providers = await loadProviders(PROVIDERS_DIR);
  const resolved = resolveProvider(ENTRY, providers);
  assert.ok(resolved && !resolved.provider && !resolved.error, JSON.stringify(resolved));
  assert.match(resolved.skipped, /providers\.local\/linkedin-browser\.mjs is not installed/);
  assert.ok(LOCAL_PROVIDER_IDS.has('linkedin-browser'));
  // Any other unknown id keeps the unknown-provider error.
  assert.deepEqual(resolveProvider({ name: 'x', provider: 'greenhous' }, providers), { error: 'unknown provider: greenhous' });
});

test('loadLocalProviders on a directory that does not exist changes nothing and prints nothing', async () => {
  const providers = await loadProviders(PROVIDERS_DIR);
  const before = providers.size;
  const warnings = await capturingWarnings(async () => {
    const same = await loadLocalProviders(join(tmpdir(), 'no-such-providers.local'), providers);
    assert.equal(same, providers);
  });
  assert.equal(providers.size, before);
  assert.deepEqual(warnings, []);
});

test('with providers.local/ on disk the provider routes through provider: linkedin-browser', async () => {
  assert.ok(existsSync(join(LOCAL_DIR, 'linkedin-browser.mjs')), 'the fork ships the module');
  const providers = await loadProviders(PROVIDERS_DIR);
  const warnings = await capturingWarnings(() => loadLocalProviders(LOCAL_DIR, providers));
  assert.deepEqual(warnings, []);
  const resolved = resolveProvider(ENTRY, providers);
  assert.equal(resolved.provider?.id, 'linkedin-browser');
  assert.equal(resolved.provider.sequential, true);
  assert.equal(typeof resolved.provider.fetch, 'function');
});

test('an entry without provider: never routes to linkedin-browser (no detect)', async () => {
  const providers = await loadProviders(PROVIDERS_DIR);
  await loadLocalProviders(LOCAL_DIR, providers);
  const { provider: _omit, ...implicit } = ENTRY;
  const resolved = resolveProvider(implicit, providers);
  assert.notEqual(resolved?.provider?.id, 'linkedin-browser');
});

test('a local module that collides with a shipped id is skipped with a warning; a broken module warns and never throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'providers.local-'));
  writeFileSync(join(dir, 'ashby.mjs'), 'export default { id: "ashby", fetch: async () => [] };\n');
  writeFileSync(join(dir, 'broken.mjs'), 'export default { id: "broken" ' /* no fetch, no closing brace */);
  writeFileSync(join(dir, 'extra.mjs'), 'export default { id: "extra", fetch: async () => [] };\n');
  const providers = await loadProviders(PROVIDERS_DIR);
  const shippedAshby = providers.get('ashby');
  const warnings = await capturingWarnings(() => loadLocalProviders(dir, providers));
  assert.equal(providers.get('ashby'), shippedAshby, 'the shipped provider stays');
  assert.ok(warnings.some((w) => w.includes('ashby') && w.includes('keeping the shipped one')), warnings.join('\n'));
  assert.ok(warnings.some((w) => w.includes('broken.mjs')), warnings.join('\n'));
  assert.equal(providers.get('extra')?.id, 'extra');
});

// ---- scan.mjs wiring

test('orderTargetsForSequentialProviders keeps parallel targets in order and puts sequential ones last, shuffled', () => {
  const seq = { id: 'linkedin-browser', sequential: true };
  const http = { id: 'greenhouse' };
  const targets = [
    { name: 'li-a', _provider: seq },
    { name: 'acme', _provider: http },
    { name: 'li-b', _provider: seq },
    { name: 'beta', _provider: http },
    { name: 'li-c', _provider: seq },
  ];
  // A deterministic "random" that always picks index 0: Fisher-Yates swaps
  // [a,b,c] to [c,b,a] at i=2, then to [b,c,a] at i=1.
  const ordered = orderTargetsForSequentialProviders(targets, () => 0);
  assert.deepEqual(ordered.map((t) => t.name), ['acme', 'beta', 'li-b', 'li-c', 'li-a']);
  assert.notEqual(ordered, targets, 'a new array');
  assert.deepEqual(targets.map((t) => t.name), ['li-a', 'acme', 'li-b', 'beta', 'li-c'], 'the input is untouched');
  // With no sequential provider the order is byte-identical.
  const plain = [{ name: 'a', _provider: http }, { name: 'b', _provider: http }];
  assert.deepEqual(orderTargetsForSequentialProviders(plain).map((t) => t.name), ['a', 'b']);
  // Real randomness still keeps every sequential target and keeps them last.
  const shuffled = orderTargetsForSequentialProviders(targets);
  assert.deepEqual(shuffled.slice(0, 2).map((t) => t.name), ['acme', 'beta']);
  assert.deepEqual(shuffled.slice(2).map((t) => t.name).sort(), ['li-a', 'li-b', 'li-c']);
});

test('storeOfferJds writes the jd of every offer that carries one into the data root and reports failures', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'scan-jd-store-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const jd = {
    url: 'https://www.linkedin.com/jobs/view/4477001122/',
    title: 'Engineering Manager Platform (m/f/d)',
    company: 'momox',
    location: 'Berlin, Germany',
    workplace: 'hybrid',
    seniority: 'Mid-Senior level',
    description: 'Lead the Platform team.',
    salary: '',
    posted_date: '2026-10-15',
    source: 'linkedin-browser',
    source_id: '4477001122',
    search_name: 'em-germany-7d',
  };
  const offers = [
    { url: jd.url, company: 'momox', title: jd.title, jd },
    { url: 'https://boards.greenhouse.io/x/jobs/1', company: 'Acme', title: 'EM' },
    { url: 'https://www.linkedin.com/jobs/view/1/', company: 'Bad', title: 'No url in jd', jd: { title: 'x', source: 'linkedin-browser', source_id: '1' } },
  ];
  const result = storeOfferJds(offers, { dataRoot, today: '2026-10-24' });
  assert.equal(result.written, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].company, 'Bad');
  assert.match(result.failures[0].error, /no url/);
  const stored = readJdForUrl(jd.url, { dataRoot });
  assert.equal(stored.description, 'Lead the Platform team.');
  assert.equal(stored.search_name, 'em-germany-7d');
  assert.equal(stored.first_seen, '2026-10-24');
  assert.ok(existsSync(join(dataRoot, 'jds', 'feeder', 'linkedin-browser-4477001122.json')));
  const index = readFileSync(join(dataRoot, 'data', 'jd-index.tsv'), 'utf-8');
  assert.ok(index.includes(`${jd.url}\tjds/feeder/linkedin-browser-4477001122.json\tlinkedin-browser\t4477001122\t2026-10-24`), index);
  // No offers with a jd: nothing written, nothing created.
  const empty = mkdtempSync(join(tmpdir(), 'scan-jd-store-empty-'));
  assert.deepEqual(storeOfferJds([offers[1]], { dataRoot: empty }), { written: 0, failures: [] });
  assert.ok(!existsSync(join(empty, 'jds')));
});

test('scan.mjs reads the fork-local wiring from the source it ships', () => {
  const src = readFileSync(join(ROOT, 'scan.mjs'), 'utf-8');
  assert.ok(src.includes("await loadLocalProviders(LOCAL_PROVIDERS_DIR, providers);"), 'local providers are merged after the shipped set');
  assert.ok(src.includes('targets = orderTargetsForSequentialProviders(targets);'), 'sequential targets go last');
  assert.ok(src.includes('storeOfferJds(verifiedOffers, { dataRoot: DATA_ROOT, today: date })'), 'JDs are stored before the pipeline row is written');
  assert.ok(/if \(resolved\.skipped\) \{[\s\S]*?skippedCount\+\+;[\s\S]*?continue;/.test(src), 'a skipped resolve counts as skipped, not as an error');
  assert.ok(/\n\s+dryRun,\n/.test(src), 'the provider ctx carries dryRun');
  assert.ok(src.includes('provider.sourceName ||'), 'a provider may name its own source label');
});
