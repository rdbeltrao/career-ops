// tests/jd-store.test.mjs — lib/jd-store.mjs, the feeder JD store and index.
//
// Contract C6 of the consolidation plan: one JSON per posting under
// `{DATA_ROOT}/jds/feeder/{source}-{source_id}.json`, an append-only TSV index
// at `{DATA_ROOT}/data/jd-index.tsv` with one row per URL, and a reader that
// matches a URL exactly, then with a trailing slash added or removed. The
// Python feeder (job-hunt `jobs/pipeline_md.py`) writes the same files, so
// the shapes here are what it has to produce.
//
// Run: node --test tests/jd-store.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INDEX_HEADER, INDEX_RELATIVE_PATH, jdRelativePath, readIndex, readJdForUrl, writeJd,
} from '../lib/jd-store.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'jd-store-'));

const JOB = {
  url: 'https://www.linkedin.com/jobs/view/4321',
  title: 'Engineering Lead',
  company: 'Acme',
  location: 'Remote (EU)',
  workplace: 'remote',
  seniority: 'Mid-Senior level',
  description: 'Lead a team of six.',
  salary: '',
  posted_date: '2026-10-16',
  source: 'linkedin',
  source_id: '4321',
  first_seen: '2026-10-20',
  search_name: 'lead-remote-eu',
};

test('jdRelativePath follows {source}-{source_id}.json under jds/feeder', () => {
  assert.equal(jdRelativePath(JOB), 'jds/feeder/linkedin-4321.json');
  assert.equal(jdRelativePath({ source: 'greenhouse', source_id: 'acme/123' }), 'jds/feeder/greenhouse-acme-123.json');
  assert.equal(jdRelativePath({ source: '../x', source_id: '..' }), 'jds/feeder/x-_.json');
  assert.throws(() => jdRelativePath({ source: 'linkedin' }), /source_id/);
  assert.throws(() => jdRelativePath({ source_id: '1' }), /source/);
});

test('write then read back by exact URL', () => {
  const dataRoot = tmp();
  const written = writeJd(JOB, { dataRoot });
  assert.deepEqual(written, { path: 'jds/feeder/linkedin-4321.json', appended: true });
  assert.ok(existsSync(join(dataRoot, 'jds', 'feeder', 'linkedin-4321.json')));

  const index = readFileSync(join(dataRoot, INDEX_RELATIVE_PATH), 'utf-8');
  assert.equal(INDEX_HEADER, 'url\tpath\tsource\tsource_id\tfirst_seen');
  assert.equal(index, `${INDEX_HEADER}\n${JOB.url}\tjds/feeder/linkedin-4321.json\tlinkedin\t4321\t2026-10-20\n`);

  const job = readJdForUrl(JOB.url, { dataRoot });
  assert.deepEqual(job, JOB);
});

test('the JSON body is the job plus source, source_id, first_seen and search_name', () => {
  const dataRoot = tmp();
  const { path } = writeJd({ url: 'https://x.test/a', title: 'T', description: 'D', source: 'ashby', source_id: 'a1' }, { dataRoot, today: '2026-10-24' });
  const body = JSON.parse(readFileSync(join(dataRoot, path), 'utf-8'));
  assert.equal(body.url, 'https://x.test/a');
  assert.equal(body.title, 'T');
  assert.equal(body.source, 'ashby');
  assert.equal(body.source_id, 'a1');
  assert.equal(body.first_seen, '2026-10-24');
  assert.equal(body.search_name, '');
  const row = readIndex(dataRoot).get('https://x.test/a');
  assert.deepEqual(row, { url: 'https://x.test/a', path, source: 'ashby', source_id: 'a1', first_seen: '2026-10-24' });
});

test('read matches with and without a trailing slash', () => {
  const dataRoot = tmp();
  writeJd({ ...JOB, url: 'https://jobs.example.com/123/' }, { dataRoot });
  assert.equal(readJdForUrl('https://jobs.example.com/123', { dataRoot })?.title, 'Engineering Lead');
  const other = tmp();
  writeJd({ ...JOB, url: 'https://jobs.example.com/456' }, { dataRoot: other });
  assert.equal(readJdForUrl('https://jobs.example.com/456/', { dataRoot: other })?.title, 'Engineering Lead');
  assert.equal(readJdForUrl('https://jobs.example.com/789', { dataRoot: other }), null);
});

test('a second writeJd for the same URL does not append a second index row', () => {
  const dataRoot = tmp();
  assert.equal(writeJd(JOB, { dataRoot }).appended, true);
  const again = writeJd({ ...JOB, description: 'Updated body.' }, { dataRoot });
  assert.equal(again.appended, false);
  const lines = readFileSync(join(dataRoot, INDEX_RELATIVE_PATH), 'utf-8').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(readIndex(dataRoot).size, 1);
  // The JSON is rewritten with the newer body; the index keeps its first row.
  assert.equal(readJdForUrl(JOB.url, { dataRoot }).description, 'Updated body.');
});

test('a missing index returns null and an empty map', () => {
  const dataRoot = tmp();
  assert.equal(readJdForUrl('https://x.test/none', { dataRoot }), null);
  assert.equal(readIndex(dataRoot).size, 0);
});

test('an index row whose file is gone, unreadable or outside the root reads as null', () => {
  const dataRoot = tmp();
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  writeFileSync(join(dataRoot, INDEX_RELATIVE_PATH), [
    INDEX_HEADER,
    'https://x.test/gone\tjds/feeder/gone.json\tsrc\t1\t2026-01-01',
    'https://x.test/bad\tjds/feeder/bad.json\tsrc\t2\t2026-01-01',
    'https://x.test/escape\t../../etc/passwd\tsrc\t3\t2026-01-01',
    'not a row',
    '',
  ].join('\n'));
  mkdirSync(join(dataRoot, 'jds', 'feeder'), { recursive: true });
  writeFileSync(join(dataRoot, 'jds', 'feeder', 'bad.json'), '{not json');
  assert.equal(readJdForUrl('https://x.test/gone', { dataRoot }), null);
  assert.equal(readJdForUrl('https://x.test/bad', { dataRoot }), null);
  assert.equal(readJdForUrl('https://x.test/escape', { dataRoot }), null);
  assert.equal(readIndex(dataRoot).size, 3);
});

test('index cells never carry a tab or a line break', () => {
  const dataRoot = tmp();
  writeJd({ url: 'https://x.test/t', source: 'a\tb', source_id: 'c\nd', title: 'T', description: '' }, { dataRoot, today: '2026-10-24' });
  const lines = readFileSync(join(dataRoot, INDEX_RELATIVE_PATH), 'utf-8').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1].split('\t').length, 5);
});

test('the index tolerates a feeder-written file with CRLF line endings', () => {
  const dataRoot = tmp();
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  mkdirSync(join(dataRoot, 'jds', 'feeder'), { recursive: true });
  writeFileSync(join(dataRoot, 'jds', 'feeder', 'linkedin-9.json'), JSON.stringify({ url: 'https://x.test/9', title: 'Nine' }));
  writeFileSync(join(dataRoot, INDEX_RELATIVE_PATH), `${INDEX_HEADER}\r\nhttps://x.test/9\tjds/feeder/linkedin-9.json\tlinkedin\t9\t2026-10-01\r\n`);
  assert.equal(readJdForUrl('https://x.test/9', { dataRoot })?.title, 'Nine');
  // Appending to a CRLF file still yields one row per line.
  writeJd({ url: 'https://x.test/10', source: 'linkedin', source_id: '10', title: 'Ten' }, { dataRoot, today: '2026-10-24' });
  assert.equal(readIndex(dataRoot).size, 2);
});
