// tests/providers/linkedin-browser.test.mjs — providers.local/linkedin-browser.mjs,
// the fork-local LinkedIn provider, exercised through its pure exports against
// the markup saved from job-hunt (tests/fixtures/linkedin/). No network and
// no browser: the fetch() guards are tested up to the point a browser would open.
//
// Run: node --test tests/providers/linkedin-browser.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import provider, {
  CARD_SELECTORS,
  DEFAULT_MAX_PAGES,
  LoginRequiredError,
  SEEN_FILE,
  buildJob,
  canonicalCompanyUrl,
  canonicalJobUrl,
  filterUnseen,
  isLoginWall,
  isoDateToEpochMs,
  loadSeen,
  loadCachedJob,
  pagedUrl,
  parseCards,
  parseDetail,
  parseHtml,
  postedDateFromText,
  profileDir,
  requireSearchUrl,
  resolveMaxPages,
  resolveApplyLookups,
  saveSeen,
  saveCachedJob,
  seenStorePath,
  selectAll,
  selectOne,
  textOf,
  walkSearch,
  openDetail,
  postingApply,
  WrongPostingError,
} from '../../providers.local/linkedin-browser.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'linkedin');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf-8');

// Real markup was saved on 2026-10-16 at 18:30 local time; relative ages anchor here.
const NOW = new Date(2026, 9, 16, 18, 30);

function detailForCard(id) {
  const card = parseCards(fixture('list.html')).find((card) => card.id === id);
  return `<h1><a href="/jobs/view/${id}/">${card.title}</a></h1><div class="job-details-jobs-unified-top-card__company-name">${card.company}</div><div id="job-details">Lead engineers.</div>`;
}


function searchPage(html) {
  let url = 'https://www.linkedin.com/jobs/search/';
  const locator = { count: async () => 1, innerHTML: async () => html, first() { return this; } };
  return {
    url: () => url,
    goto: async (next) => { url = next; },
    waitForTimeout: async () => {},
    waitForSelector: async () => {},
    evaluate: async () => 0,
    locator: () => locator,
  };
}

test('interrupted search replays captured jobs and revisits legacy seen ids without losing postings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'linkedin-recover-'));
  const ids = parseCards(fixture('list.html')).map((card) => card.id);
  const seenPath = seenStorePath(root);
  saveSeen(new Set(ids), seenPath); // The old provider may have consumed all three.
  const options = { entry: { name: 'search', resolve_apply_url: false }, searchUrl: 'https://www.linkedin.com/jobs/search/', maxPages: 1, seenPath, dryRun: false, applyRoot: root };
  const detail = (id) => detailForCard(id);
  try {
    let pauses = 0;
    await assert.rejects(walkSearch(searchPage(fixture('list.html')), { ...options, readDetail: async (_page, id) => detail(id), pause: async () => { if (++pauses === 2) throw new Error('process interrupted'); } }), /process interrupted/);
    assert.ok(loadCachedJob(ids[0], root)?.description);

    const opened = [];
    const recovered = await walkSearch(searchPage(fixture('list.html')), { ...options, pause: async () => {}, readDetail: async (_page, id) => { opened.push(id); return detail(id); } });
    assert.deepEqual(recovered.map((job) => job.externalId), ids);
    assert.deepEqual(opened, ids.slice(1), 'first capture survives; uncached seen ids are not suppressed');
    assert.ok(recovered.every((job) => job.description));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('title gate skips expensive details while retaining rejected cards for core filter accounting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'linkedin-title-gate-'));
  try {
    const opened = [];
    const jobs = await walkSearch(searchPage(fixture('list.html')), {
      entry: { name: 'search', resolve_apply_url: false }, searchUrl: 'https://www.linkedin.com/jobs/search/', maxPages: 1, seenPath: seenStorePath(root), dryRun: true, applyRoot: root,
      titleWanted: (title) => title === 'Head of Engineering', pause: async () => {}, readDetail: async (_page, id) => { opened.push(id); return detailForCard(id); },
    });
    assert.equal(jobs.length, 3);
    assert.deepEqual(opened, ['4479999999']);
    assert.equal(jobs.filter((job) => job.description).length, 1);
    assert.equal(existsSync(join(root, 'data')), false, 'dry run writes neither cache nor seen ids');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid and stale crawl payloads are retried instead of trusted as seen', () => {
  const root = mkdtempSync(join(tmpdir(), 'linkedin-cache-'));
  try {
    const job = buildJob(parseCards(fixture('list.html'))[1], parseDetail(fixture('detail.html')), { name: 'search' });
    saveCachedJob(job, root);
    assert.equal(loadCachedJob(job.externalId, root).description, job.description);
    assert.equal(loadCachedJob(job.externalId, root, Date.now() + 8 * 86_400_000), null);
    writeFileSync(join(root, 'data', 'linkedin-crawl-cache', `${job.externalId}.json`), '{bad json');
    assert.equal(loadCachedJob(job.externalId, root), null);
    assert.equal(loadCachedJob('../outside', root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the four fixtures copied from job-hunt are present', () => {
  for (const name of ['list.html', 'list-real.html', 'detail.html', 'detail-real.html']) {
    assert.ok(existsSync(join(FIXTURES, name)), `${name} missing`);
  }
});

// ---- the minimal DOM the parsers run on

test('parseHtml builds elements with attributes and selectAll matches compound and descendant selectors', () => {
  const root = parseHtml('<div class="a b" id="x"><ul><li data-id="1"><a href="/jobs/view/42/?x=1"><strong>T</strong></a></li><li>plain</li></ul><br><img src="s"><p>after &amp; done</p></div>');
  assert.equal(selectAll(root, 'li').length, 2);
  assert.equal(selectAll(root, 'div.a.b li[data-id]').length, 1);
  assert.equal(selectOne(root, '#x ul a[href*="/jobs/view/"] strong').tag, 'strong');
  assert.equal(selectOne(root, 'li[data-id="1"]').attrs['data-id'], '1');
  assert.equal(selectOne(root, "li[data-id='2']"), null);
  assert.equal(textOf(selectOne(root, 'p')), 'after & done');
  assert.equal(selectAll(root, 'strong, p').map((e) => e.tag).join(','), 'strong,p', 'comma groups keep document order');
  // Void tags do not swallow what follows them.
  assert.equal(selectOne(root, 'br p'), null);
  assert.equal(selectOne(root, 'div p').tag, 'p');
});

test('parseHtml skips comments, doctype and script bodies', () => {
  const root = parseHtml('<!doctype html><!-- <li>no</li> --><script>var x = "<li>";</script><li>yes</li>');
  assert.equal(selectAll(root, 'li').length, 1);
  assert.equal(textOf(selectOne(root, 'li')), 'yes');
});

// ---- cards

test('parseCards reads id, title, company, location and date from the synthetic list', () => {
  const cards = parseCards(fixture('list.html'));
  assert.deepEqual(cards.map((c) => c.id), ['4477388263', '4477001122', '4479999999']);
  const first = cards[0];
  assert.equal(first.title, 'Teamleitung OSS Software Engineering (w/m/d)');
  assert.equal(first.company, 'Deutsche Glasfaser Unternehmensgruppe');
  assert.equal(first.location, 'Düsseldorf, North Rhine-Westphalia, Germany (Hybrid)');
  assert.equal(first.postedDate, '2026-10-16');
  assert.equal(cards[1].postedDate, '2026-10-15', 'a full timestamp is trimmed to a date');
  assert.equal(cards[2].title, 'Head of Engineering', 'id and title from href / aria-label only');
  assert.equal(cards[2].company, 'Soar');
  assert.equal(cards[2].postedDate, '');
});

test('parseCards on real markup reads the time tag and leaves promoted cards undated', () => {
  const cards = parseCards(fixture('list-real.html'));
  assert.deepEqual(cards.map((c) => c.id), ['4480393707', '4479350977']);
  assert.equal(cards[0].title, 'Engineering Manager (m/w/d) - INNSIDE by Meliá München Parkstadt Schwabing');
  assert.equal(cards[0].company, 'Meliá Hotels International');
  assert.equal(cards[0].location, 'Munich, Bavaria, Germany (On-site)');
  assert.equal(cards[0].postedDate, '2026-10-16');
  assert.equal(cards[1].title, 'Engineering Manager (m/f/d)');
  assert.equal(cards[1].company, 'TOPdesk');
  assert.equal(cards[1].salary, '7,500 EUR/month - 8,500 EUR/month');
  assert.equal(cards[1].postedDate, '', 'promoted cards carry no date; the detail pane fills it');
});

test('every card selector is still a selector the parser understands', () => {
  for (const sel of CARD_SELECTORS) assert.doesNotThrow(() => selectAll(parseHtml('<li></li>'), sel));
  assert.deepEqual(parseCards(''), []);
  assert.deepEqual(parseCards('<ul><li class="scaffold-layout__list-item">no id</li></ul>'), []);
});

// ---- detail pane

test('parseDetail reads title, company, location, pills and description from the synthetic pane', () => {
  const d = parseDetail(fixture('detail.html'), { now: NOW });
  assert.equal(d.title, 'Engineering Manager Platform (m/f/d)');
  assert.equal(d.company, 'momox');
  assert.equal(d.location, 'Berlin, Germany');
  assert.equal(d.postedDate, '2026-10-15', '"1 day ago"');
  assert.equal(d.workplace, 'hybrid');
  assert.equal(d.employmentType, 'Full-time');
  assert.equal(d.seniority, 'Mid-Senior level');
  assert.equal(d.salary, '€90K/yr - €110K/yr');
  assert.deepEqual(d.pills, ['€90K/yr - €110K/yr', 'Hybrid', 'Full-time', 'Mid-Senior level']);
  assert.equal(d.companyUrl, 'https://www.linkedin.com/company/momox/', 'the /life tab is dropped');
  assert.ok(d.description.startsWith('Your mission'), d.description.slice(0, 40));
  assert.ok(d.description.includes('Kubernetes'));
  assert.ok(d.description.includes('- Grow and coach the team'), 'list items keep a dash');
  assert.ok(!d.description.includes('<'));
  assert.ok(!d.description.includes('About the job'));
});

test('parseDetail on real markup derives the posting date from "Reposted 23 hours ago" and ignores the applicant insight', () => {
  const html = fixture('detail-real.html');
  assert.ok(html.includes('Applicant seniority level') && html.includes('Entry level applicants'));
  const d = parseDetail(html, { now: NOW });
  assert.equal(d.title, 'Teamleiter Planung Leit- und Sicherungstechnik Bahn (m/w/d)');
  assert.equal(d.company, 'GTU Mobility GmbH & Co. KG');
  assert.equal(d.location, 'Cologne, North Rhine-Westphalia, Germany');
  assert.equal(d.postedDate, '2026-10-15', 'at 18:30, 23 hours ago is the day before');
  assert.equal(d.workplace, 'onsite');
  assert.equal(d.employmentType, 'Full-time');
  assert.deepEqual(d.pills, ['On-site', 'Full-time']);
  assert.equal(d.seniority, '', 'the premium applicant insight describes applicants, not the job');
  assert.equal(d.companyUrl, 'https://www.linkedin.com/company/gtu-mobility-gmbh-&-co.-kg/');
  assert.ok(d.description.includes('Köln') && d.description.includes('Die GTU Unternehmensgruppe'));
  assert.ok(!d.description.includes('<'));
});

test('parseDetail on empty markup returns a blank detail', () => {
  const d = parseDetail('<div></div>');
  assert.equal(d.title, '');
  assert.equal(d.description, '');
  assert.equal(d.workplace, '');
  assert.deepEqual(d.pills, []);
  assert.equal(d.companyUrl, '');
});

test('parseDetail reads the seniority from a job criteria list, and a pill wins over it', () => {
  const html = `
    <div class="scaffold-layout__detail">
      <h1 class="t-24">Head of Engineering</h1>
      <ul class="description__job-criteria-list">
        <li class="description__job-criteria-item">
          <h3 class="description__job-criteria-subheader">Seniority level</h3>
          <span class="description__job-criteria-text">Director</span>
        </li>
        <li class="description__job-criteria-item">
          <h3 class="description__job-criteria-subheader">Employment type</h3>
          <span class="description__job-criteria-text">Full-time</span>
        </li>
      </ul>
    </div>`;
  assert.equal(parseDetail(html, { now: NOW }).seniority, 'Director');
  assert.equal(parseDetail(fixture('detail.html'), { now: NOW }).seniority, 'Mid-Senior level');
});

test('parseDetail ignores description bullets that merely mention seniority', () => {
  const html = `
    <div id="job-details">
      <ul>
        <li><strong>Seniority &amp; Leadership:</strong> <span>You have led teams of 5+ engineers.</span></li>
        <li><strong>Seniority level:</strong> Director</li>
      </ul>
    </div>`;
  assert.equal(parseDetail(html, { now: NOW }).seniority, 'Director');
  const only = '<div id="job-details"><ul><li><strong>Seniority &amp; Leadership:</strong> <span>Led teams.</span></li></ul></div>';
  assert.equal(parseDetail(only, { now: NOW }).seniority, '');
});

test('parseDetail recognises a monthly EUR pill as the salary', () => {
  const html = `
    <div class="job-details-fit-level-preferences">
      <button><span><strong>7,500 EUR/month - 8,500 EUR/month</strong></span></button>
      <button><span><strong>Hybrid</strong></span><span class="visually-hidden">Matches your job preferences, workplace type is Hybrid.</span></button>
      <button><span><strong>Full-time</strong></span></button>
    </div>`;
  const d = parseDetail(html, { now: NOW });
  assert.equal(d.salary, '7,500 EUR/month - 8,500 EUR/month');
  assert.equal(d.workplace, 'hybrid');
  assert.equal(d.employmentType, 'Full-time');
  assert.deepEqual(d.pills, ['7,500 EUR/month - 8,500 EUR/month', 'Hybrid', 'Full-time']);
});

test('canonicalCompanyUrl keeps the slug and drops section, query and fragment', () => {
  assert.equal(canonicalCompanyUrl('https://www.linkedin.com/company/momox/life'), 'https://www.linkedin.com/company/momox/');
  assert.equal(canonicalCompanyUrl('https://www.linkedin.com/company/momox/?trk=x'), 'https://www.linkedin.com/company/momox/');
  assert.equal(canonicalCompanyUrl('https://de.linkedin.com/company/acme-gmbh'), 'https://de.linkedin.com/company/acme-gmbh/');
  assert.equal(canonicalCompanyUrl('/company/acme-gmbh/jobs/'), 'https://www.linkedin.com/company/acme-gmbh/');
  assert.equal(canonicalCompanyUrl('https://www.linkedin.com/jobs/view/1/'), '');
  assert.equal(canonicalCompanyUrl(''), '');
});

// ---- posting age text

test('postedDateFromText handles relative, rounded and absolute spellings', () => {
  const cases = [
    ['Berlin, Germany · 15 minutes ago · 0 people clicked apply', '2026-10-16'],
    ['Munich, Bavaria, Germany · Reposted 21 hours ago · 81 applicants', '2026-10-15'],
    ['Cologne · Reposted 1 hour ago', '2026-10-16'],
    ['Hamburg · 2 days ago · 12 applicants', '2026-10-14'],
    ['EMEA · 1 week ago', '2026-10-09'],
    ['EMEA · 3 weeks ago', '2026-09-25'],
    ['Remote · 1 month ago', '2026-09-16'],
    ['an hour ago', '2026-10-16'],
    ['Just now', '2026-10-16'],
    ['yesterday', '2026-10-15'],
    ['Posted on Oct 14, 2026', '2026-10-14'],
    ['Berlin · 14 Oct 2026 · 3 applicants', '2026-10-14'],
    ['Berlin · 2026-10-13', '2026-10-13'],
    ['Berlin · 14.10.2026', '2026-10-14'],
    ['Berlin, Germany · 45 applicants', ''],
    ['', ''],
  ];
  for (const [text, expected] of cases) assert.equal(postedDateFromText(text, NOW), expected, text);
});

test('isoDateToEpochMs maps an ISO date to UTC midnight and rejects anything else', () => {
  assert.equal(isoDateToEpochMs('2026-10-16'), Date.UTC(2026, 9, 16));
  assert.equal(new Date(isoDateToEpochMs('2026-10-16')).toISOString().slice(0, 10), '2026-10-16');
  assert.equal(isoDateToEpochMs(''), undefined);
  assert.equal(isoDateToEpochMs('yesterday'), undefined);
});

// ---- paging and URLs

test('pagedUrl sets start per page, clears it on page 1 and drops currentJobId', () => {
  const url = 'https://www.linkedin.com/jobs/search/?keywords=Engineering%20Manager&geoId=101282230&currentJobId=1&start=50';
  assert.equal(pagedUrl(url, 2), 'https://www.linkedin.com/jobs/search/?keywords=Engineering+Manager&geoId=101282230&start=25');
  assert.equal(pagedUrl(url, 3), 'https://www.linkedin.com/jobs/search/?keywords=Engineering+Manager&geoId=101282230&start=50');
  assert.equal(pagedUrl(url, 1), 'https://www.linkedin.com/jobs/search/?keywords=Engineering+Manager&geoId=101282230');
  assert.equal(pagedUrl(url, 0), pagedUrl(url, 1), 'a page below 1 is page 1');
  const filters = 'https://www.linkedin.com/jobs/search/?f_TPR=r604800&f_WT=2%2C3&geoId=101282230&keywords=Head%20of%20Engineering&sortBy=DD';
  assert.equal(pagedUrl(filters, 1), 'https://www.linkedin.com/jobs/search/?f_TPR=r604800&f_WT=2%2C3&geoId=101282230&keywords=Head+of+Engineering&sortBy=DD', 'other parameters are untouched');
});

test('canonicalJobUrl is https://www.linkedin.com/jobs/view/{id}/', () => {
  assert.equal(canonicalJobUrl('4477001122'), 'https://www.linkedin.com/jobs/view/4477001122/');
  assert.equal(canonicalJobUrl(' 42 '), 'https://www.linkedin.com/jobs/view/42/');
});

// ---- login wall

test('isLoginWall recognises login, checkpoint, authwall and signup URLs', () => {
  assert.ok(isLoginWall('https://www.linkedin.com/login?session_redirect=%2Fjobs'));
  assert.ok(isLoginWall('https://www.linkedin.com/checkpoint/challenge/abc'));
  assert.ok(isLoginWall('https://www.linkedin.com/authwall?trk=x'));
  assert.ok(isLoginWall('https://www.linkedin.com/uas/login-submit'));
  assert.ok(isLoginWall('https://www.linkedin.com/signup/cold-join'));
  assert.ok(!isLoginWall('https://www.linkedin.com/jobs/search/?keywords=x'));
  assert.ok(!isLoginWall('https://www.linkedin.com/jobs/search/?keywords=login%20engineer'), 'a keyword is not a wall');
  assert.ok(!isLoginWall('https://www.linkedin.com/feed/'));
});

test('isLoginWall reads the logged-out jobs page from its markup, and never a logged-in one', () => {
  const search = 'https://www.linkedin.com/jobs/search/?keywords=x';
  const loggedOut = '<header><a class="nav__button-secondary" href="https://www.linkedin.com/login?x">Sign in</a></header><div class="base-search-card"></div>';
  const authwall = '<form class="authwall-join-form"></form>';
  const loggedIn = '<div id="global-nav"><div class="global-nav__me"></div></div><div class="base-search-card"></div>';
  assert.ok(isLoginWall(search, loggedOut));
  assert.ok(isLoginWall(search, authwall));
  assert.ok(!isLoginWall(search, loggedIn), 'the logged-in navigation wins over any guest marker');
  assert.ok(!isLoginWall(search, '<ul class="scaffold-layout__list-container"></ul>'));
  assert.ok(!isLoginWall(search, ''));
});

test('a LoginRequiredError names the URL and the login script and says nothing is retried', () => {
  const err = new LoginRequiredError('https://www.linkedin.com/checkpoint/challenge/1');
  assert.equal(err.name, 'LoginRequiredError');
  assert.ok(err.message.includes('https://www.linkedin.com/checkpoint/challenge/1'));
  assert.ok(err.message.includes('node linkedin-login.mjs'));
  assert.ok(err.message.includes('not retried'));
});

// ---- building the scanner job

test('buildJob merges card and detail into a scanner Job with the canonical URL and the note', () => {
  const card = parseCards(fixture('list.html'))[1];
  const detail = parseDetail(fixture('detail.html'), { now: NOW });
  const job = buildJob(card, detail, { name: 'em-germany-24h' });
  assert.equal(job.url, 'https://www.linkedin.com/jobs/view/4477001122/');
  assert.equal(job.externalId, '4477001122');
  assert.equal(job.source, 'linkedin-browser');
  assert.equal(job.note, 'linkedin-browser em-germany-24h');
  assert.equal(job.title, 'Engineering Manager Platform (m/f/d)');
  assert.equal(job.company, 'momox');
  assert.equal(job.location, 'Berlin, Germany');
  assert.equal(job.workplace, 'hybrid', 'the detail pill wins over "(Remote)" in the card location');
  assert.equal(job.seniority, 'Mid-Senior level');
  assert.equal(job.employmentType, 'Full-time');
  assert.equal(job.salaryText, '€90K/yr - €110K/yr');
  assert.equal(job.salary, undefined, 'salary text is not the scanner\'s {min,max,currency} shape');
  assert.equal(job.postedAt, Date.UTC(2026, 9, 15), 'the card date wins');
  assert.ok(job.description.startsWith('Your mission'));
  assert.deepEqual(job.jd, {
    url: 'https://www.linkedin.com/jobs/view/4477001122/',
    title: 'Engineering Manager Platform (m/f/d)',
    company: 'momox',
    location: 'Berlin, Germany',
    workplace: 'hybrid',
    seniority: 'Mid-Senior level',
    description: job.description,
    salary: '€90K/yr - €110K/yr',
    posted_date: '2026-10-15',
    source: 'linkedin-browser',
    source_id: '4477001122',
    search_name: 'em-germany-24h',
  });
});

test('buildJob without a detail falls back to the card and the text heuristic, and carries no jd', () => {
  const card = parseCards(fixture('list.html'))[1];
  const job = buildJob(card, null, { name: 's' });
  assert.equal(job.title, 'Engineering Manager Platform (m/f/d)');
  assert.equal(job.workplace, 'remote');
  assert.equal(job.description, '');
  assert.equal(job.jd, undefined);
  assert.equal(job.postedAt, Date.UTC(2026, 9, 15));
});

test('buildJob uses the detail posting date when the card has none, and the card salary when the pane has none', () => {
  const card = parseCards(fixture('list-real.html'))[1];
  const detail = parseDetail(fixture('detail-real.html'), { now: NOW });
  assert.equal(card.postedDate, '');
  const job = buildJob({ ...card, id: detail.jobId, title: detail.title, company: detail.company }, detail, { name: 'em-germany-24h' });
  assert.equal(job.postedAt, Date.UTC(2026, 9, 15));
  assert.equal(job.jd.posted_date, '2026-10-15');
  assert.equal(job.seniority, '');
  assert.equal(job.salaryText, '7,500 EUR/month - 8,500 EUR/month');
  assert.equal(job.jd.salary, '7,500 EUR/month - 8,500 EUR/month');
});

// ---- seen ids

test('the seen store lives at {dataRoot}/data/linkedin-seen.json and round-trips sorted ids', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'linkedin-seen-'));
  const path = seenStorePath(dataRoot);
  assert.equal(path, join(dataRoot, 'data', 'linkedin-seen.json'));
  assert.equal(SEEN_FILE, join('data', 'linkedin-seen.json'));
  assert.deepEqual([...loadSeen(path)], [], 'a missing file is an empty set');
  saveSeen(new Set(['2', '1', '2']), path);
  assert.deepEqual([...loadSeen(path)], ['1', '2']);
  assert.ok(readFileSync(path, 'utf-8').startsWith('['));
  assert.equal(readFileSync(path, 'utf-8'), '[\n"1",\n"2"\n]\n');
  saveSeen(new Set(), path);
  assert.equal(readFileSync(path, 'utf-8'), '[]\n');
});

test('the seen store tolerates a corrupt or wrongly shaped file', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'linkedin-seen-'));
  const path = seenStorePath(dataRoot);
  saveSeen(new Set(['1']), path);
  writeFileSync(path, '{not json');
  assert.deepEqual([...loadSeen(path)], []);
  writeFileSync(path, '{"ids":[1]}');
  assert.deepEqual([...loadSeen(path)], []);
});

test('seenStorePath follows the resolved data root when none is given', () => {
  const previous = process.env.CAREER_OPS_ROOT;
  const dataRoot = mkdtempSync(join(tmpdir(), 'linkedin-seen-root-'));
  process.env.CAREER_OPS_ROOT = dataRoot;
  try {
    assert.equal(seenStorePath(), join(dataRoot, 'data', 'linkedin-seen.json'));
  } finally {
    if (previous === undefined) delete process.env.CAREER_OPS_ROOT; else process.env.CAREER_OPS_ROOT = previous;
  }
});

test('filterUnseen drops the cards already seen in the store or earlier in the run', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'linkedin-seen-'));
  const path = seenStorePath(dataRoot);
  saveSeen(new Set(['4477388263']), path);
  const cards = parseCards(fixture('list.html'));
  const seenThisRun = new Set(['4479999999']);
  const fresh = filterUnseen(cards, seenThisRun, loadSeen(path));
  assert.deepEqual(fresh.map((c) => c.id), ['4477001122']);
  assert.deepEqual(filterUnseen(cards, new Set()).map((c) => c.id), ['4477388263', '4477001122', '4479999999']);
});

// ---- entry shape and the fetch guards that run before any browser opens

test('the provider is explicit-only: id linkedin-browser, no detect, sequential, its own source label', () => {
  assert.equal(provider.id, 'linkedin-browser');
  assert.equal(provider.detect, undefined, 'routes through provider: only, never by URL detection');
  assert.equal(typeof provider.fetch, 'function');
  assert.equal(provider.sequential, true);
  assert.equal(provider.sourceName, 'linkedin-browser');
});

test('requireSearchUrl accepts a LinkedIn jobs search URL and refuses anything else', () => {
  const ok = 'https://www.linkedin.com/jobs/search/?keywords=Engineering%20Manager&geoId=101282230';
  assert.equal(requireSearchUrl({ name: 's', search_url: ` ${ok} ` }), ok);
  assert.throws(() => requireSearchUrl({ name: 's' }), /has no search_url/);
  assert.throws(() => requireSearchUrl({ name: 's', search_url: 'not a url' }), /not a URL/);
  assert.throws(() => requireSearchUrl({ name: 's', search_url: 'http://www.linkedin.com/jobs/search/?k=x' }), /must be an https/);
  assert.throws(() => requireSearchUrl({ name: 's', search_url: 'https://evil.example/jobs/search/?k=x' }), /must be an https/);
  assert.throws(() => requireSearchUrl({ name: 's', search_url: 'https://www.linkedin.com/feed/' }), /must be an https/);
});

test('max_pages defaults to 3 and must be a positive integer', () => {
  assert.equal(DEFAULT_MAX_PAGES, 3);
  assert.equal(resolveMaxPages({}), 3);
  assert.equal(resolveMaxPages({ max_pages: 2 }), 2);
  assert.equal(resolveMaxPages({ max_pages: '5' }), 5);
  assert.equal(resolveMaxPages({ max_pages: 0 }), 3);
  assert.equal(resolveMaxPages({ max_pages: 1.5 }), 3);
  assert.equal(resolveMaxPages({ max_pages: 'many' }), 3);
});

test('fetch() refuses an entry without a search_url before touching a browser', async () => {
  await assert.rejects(provider.fetch({ name: 'broken' }), /has no search_url/);
  await assert.rejects(provider.fetch({ name: 'broken', search_url: 'https://example.com/' }), /must be an https/);
});

test('the browser profile comes from LINKEDIN_PROFILE_DIR, else ~/.job-hunt/browser-profile', () => {
  const previous = process.env.LINKEDIN_PROFILE_DIR;
  try {
    process.env.LINKEDIN_PROFILE_DIR = '/tmp/some-profile';
    assert.equal(profileDir(), '/tmp/some-profile');
    delete process.env.LINKEDIN_PROFILE_DIR;
    assert.ok(profileDir().endsWith(join('.job-hunt', 'browser-profile')));
  } finally {
    if (previous === undefined) delete process.env.LINKEDIN_PROFILE_DIR; else process.env.LINKEDIN_PROFILE_DIR = previous;
  }
});

// ---- the login script

test('node linkedin-login.mjs --help prints usage and exits 0 without opening a browser; a bad flag exits 1', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'linkedin-login.mjs');
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf-8', timeout: 20_000 });
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes('node linkedin-login.mjs'), help.stdout);
  assert.ok(help.stdout.includes('LINKEDIN_LOGIN_TIMEOUT_MS'), help.stdout);
  assert.ok(help.stdout.includes('no credential is read or stored'), help.stdout);
  const bad = spawnSync(process.execPath, [script, '--bogus'], { encoding: 'utf-8', timeout: 20_000 });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unrecognized flag/);
  const src = readFileSync(script, 'utf-8');
  assert.ok(!/password|credential\s*=|\.fill\(|\.type\(/i.test(src.replace(/^\s*(\/\/|\*).*$/gm, '').replace(/`[\s\S]*?`/g, '')), 'the script never types or reads a credential');
});

test('buildJob keeps the LinkedIn link and id beside the employer apply URL the crawl read', () => {
  const card = parseCards(fixture('list.html'))[1];
  const detail = parseDetail(fixture('detail.html'), { now: NOW });
  const apply = { applyUrl: 'https://jobs.ashbyhq.com/acme/1/application', applyKind: 'offsite' };
  const job = buildJob(card, detail, { name: 'em-germany-24h' }, apply);
  assert.equal(job.url, 'https://www.linkedin.com/jobs/view/4477001122/', 'the board link stays the posting URL');
  assert.equal(job.externalId, '4477001122', 'the LinkedIn id stays');
  assert.equal(job.applyUrl, 'https://jobs.ashbyhq.com/acme/1/application');
  assert.equal(job.applyKind, 'offsite');
  assert.equal(job.jd.apply_url, 'https://jobs.ashbyhq.com/acme/1/application');
  assert.equal(job.jd.url, 'https://www.linkedin.com/jobs/view/4477001122/');

  const easy = buildJob(card, detail, { name: 's' }, { applyUrl: '', applyKind: 'easy-apply' });
  assert.equal(easy.applyKind, 'easy-apply');
  assert.equal('applyUrl' in easy, false, 'no employer URL, no field');
  assert.equal('apply_url' in easy.jd, false);

  const plain = buildJob(card, detail, { name: 's' });
  assert.equal('applyUrl' in plain || 'applyKind' in plain, false, 'a job read without the apply step is unchanged');
});

test('isLoginWall: the signed-out posting page (a sign-in modal, no redirect) is a wall', () => {
  const guest = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'linkedin-guest-live-modal.html'), 'utf8');
  assert.equal(isLoginWall('https://www.linkedin.com/jobs/view/4480683016/', guest), true);
  assert.equal(isLoginWall('https://www.linkedin.com/jobs/view/4480683016/', '<header id="global-nav"></header><div class="contextual-sign-in-modal"></div>'), false, 'the signed-in navigation always wins');
});

test('resolveApplyLookups: posting-page visits per search, capped by default and off when asked', () => {
  assert.equal(resolveApplyLookups({}), 25);
  assert.equal(resolveApplyLookups({ max_apply_lookups: 5 }), 5);
  assert.equal(resolveApplyLookups({ max_apply_lookups: 0 }), 0);
  assert.equal(resolveApplyLookups({ max_apply_lookups: -1 }), 25);
  assert.equal(resolveApplyLookups({ max_apply_lookups: 'lots' }), 25);
  assert.equal(resolveApplyLookups({ resolve_apply_url: false, max_apply_lookups: 9 }), 0);
});

test('buildJob refuses wrong, absent or conflicting primary identity', () => {
  const card = parseCards(fixture('list.html'))[1];
  const detail = parseDetail(fixture('detail.html'));
  for (const change of [{ jobId: '4380699028' }, { jobId: '' }, { company: 'TEN Thüringer Energienetze' }, { title: 'Another role' }, { description: '' }]) {
    assert.throws(() => buildJob(card, { ...detail, ...change }, {}), WrongPostingError);
  }
  const recommendations = '<h1><a href="/jobs/view/111/">Wrong job</a></h1><aside><h2><a href="/jobs/view/222/">Wanted job</a></h2></aside>';
  assert.equal(parseDetail(recommendations).jobId, '111');
});

test('modern primary banner proves identity; recommendations cannot supply it', () => {
  const html = '<title>Engineering Manager | Doctolib | LinkedIn</title><main><section aria-label="Primary content"><div id="JobDetails_ManageJobBanner_222"></div><h2>About the job</h2><span data-testid="expandable-text-box">Lead engineers.</span></section><aside><div id="JobDetails_ManageJobBanner_111"></div></aside></main>';
  const detail = parseDetail(html);
  assert.equal(detail.jobId, '222');
  assert.equal(detail.title, 'Engineering Manager');
  assert.equal(detail.company, 'Doctolib');
  assert.equal(detail.description, 'Lead engineers.');
  assert.equal(parseDetail(html.replace('JobDetails_ManageJobBanner_222', 'unknown')).jobId, '');
});

test('wrong details are not cached or marked seen, and card identity survives', async () => {
  const root = mkdtempSync(join(tmpdir(), 'linkedin-wrong-identity-'));
  try {
    const jobs = await walkSearch(searchPage(fixture('list.html')), {
      entry: { name: 'search', resolve_apply_url: false }, searchUrl: 'https://www.linkedin.com/jobs/search/', maxPages: 1,
      seenPath: seenStorePath(root), dryRun: false, applyRoot: root, pause: async () => {},
      readDetail: async () => detailForCard('4479999999'),
    });
    assert.equal(jobs[0].company, 'Deutsche Glasfaser Unternehmensgruppe');
    assert.deepEqual(jobs.map((job) => Boolean(job.description)), [false, false, true]);
    assert.equal(loadCachedJob('4477388263', root), null);
    assert.deepEqual([...loadSeen(seenStorePath(root))], ['4479999999']);
    const file = join(root, 'data', 'linkedin-crawl-cache', '4479999999.json');
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    delete cached.identityVersion;
    writeFileSync(file, JSON.stringify(cached));
    assert.equal(loadCachedJob('4479999999', root), null, 'legacy caches have no identity proof');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('openDetail navigates a fresh document and closes it after identity rejection', async () => {
  const events = [];
  const posting = {
    goto: async (url) => events.push(['goto', url]), url: () => canonicalJobUrl('4477001122'),
    locator: () => ({ first() { return this; }, count: async () => 1 }),
    waitForSelector: async () => {}, waitForTimeout: async () => {},
    content: async () => fixture('detail.html'), close: async () => events.push(['close']),
  };
  const page = { context: () => ({ newPage: async () => posting }) };
  await openDetail(page, '4477001122');
  assert.deepEqual(events, [['goto', canonicalJobUrl('4477001122')], ['close']]);
  await assert.rejects(openDetail(page, '4380699028'), WrongPostingError);
  assert.deepEqual(events.at(-1), ['close']);
});


test('recommendations cannot supply the primary posting apply URL or kind', () => {
  const recommendation = '<aside><a aria-label="Apply on company website" href="https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fwrong.example%2Fapply">Apply</a></aside>';
  const html = '<section aria-label="Primary content"><h1>Wanted job</h1><button aria-label="Easy Apply">Apply</button></section>' + recommendation;
  assert.deepEqual(postingApply(html), { applyUrl: null, applyKind: 'easy-apply' });
  assert.deepEqual(postingApply(recommendation), { applyUrl: null, applyKind: '' });
});
