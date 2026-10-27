import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseMergedListingSources } from '../lib/tracker-listing-merge.mjs';
import { openTrackerTransaction } from '../tracker-utils.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const header = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |';
const separator = '|---|---|---|---|---|---|---|---|---|---|';
const listing = (n, { company = 'Acme', role = 'Engineering Manager (m/f/d)', status = 'Evaluated', notes = `note ${n}`, url = `https://www.linkedin.com/jobs/view/${n}` } = {}) =>
  `| ${n} | 2026-10-${n === 1 ? '20' : '21'} | ${company} | ${role} | ${n === 1 ? '4.1' : '4.0'}/5 | ${status} | [PDF](../output/${n}.pdf) | [${n}](../reports/${n}-acme.md) | ${notes} | [listing](${url}) |`;
const content = (...rows) => ['# Tracker', '', header, separator, ...rows, '', '## Archive', '', 'Historical text.', ''].join('\n');

function sandbox(fn, source = content(listing(1), listing(2))) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'merge-listings-')));
  const tracker = join(dir, 'data', 'applications.md');
  mkdirSync(dirname(tracker), { recursive: true });
  writeFileSync(tracker, source);
  const cli = (...args) => spawnSync(process.execPath, [join(ROOT, 'merge-listings.mjs'), ...args], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_DATA_DIR: dir, CAREER_OPS_TRACKER: tracker,
      CAREER_OPS_TRACKER_LOCK: '', CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: '100', CAREER_OPS_TRACKER_LOCK_RETRY_MS: '10' },
  });
  try { fn({ dir, tracker, cli, source }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('explicit merge keeps chosen row and archives every removed field; backup is original', () => sandbox(({ tracker, cli, source }) => {
  const result = cli('--keep', '1', '--nums', '1,2');
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary, { kept: '1', merged: ['2'], changed: true, backup: `${tracker}.bak` });
  const after = readFileSync(tracker, 'utf8');
  assert.ok(after.includes('| 1 | 2026-10-20 | Acme | Engineering Manager (m/f/d) | 4.1/5 | Evaluated |'));
  assert.ok(!after.includes('\n| 2 |'));
  for (const value of ['Merged listing #2', '2026-10-21', '4.0/5', 'note 1', 'note 2', '[PDF](../output/2.pdf)', '[2](../reports/2-acme.md)', 'https://www.linkedin.com/jobs/view/2', 'Historical text.']) assert.ok(after.includes(value), value);
  assert.equal(readFileSync(`${tracker}.bak`, 'utf8'), source);
}));

test('dry-run previews merge without tracker or backup writes', () => sandbox(({ tracker, cli, source }) => {
  const result = cli('--keep', '1', '--nums', '1,2', '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { kept: '1', merged: ['2'], changed: false, backup: null });
  assert.equal(readFileSync(tracker, 'utf8'), source);
  assert.equal(existsSync(`${tracker}.bak`), false);
}));

for (const [name, args] of [
  ['missing selection', ['--keep', '1']],
  ['unknown flag', ['--keep', '1', '--nums', '1,2', '--force']],
  ['invalid number', ['--keep', '1', '--nums', '1,2junk']],
  ['duplicate selection', ['--keep', '1', '--nums', '1,1']],
  ['keep outside selection', ['--keep', '3', '--nums', '1,2']],
  ['absent row', ['--keep', '1', '--nums', '1,99']],
]) test(`${name} fails without writes`, () => sandbox(({ tracker, cli, source }) => {
  const result = cli(...args);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(tracker, 'utf8'), source);
  assert.equal(existsSync(`${tracker}.bak`), false);
}));

for (const [name, rows] of [
  ['company conflict', [listing(1), listing(2, { company: 'Other' })]],
  ['seniority conflict', [listing(1), listing(2, { role: 'Senior Engineering Manager (m/f/d)' })]],
  ['team conflict', [listing(1, { role: 'Engineering Manager, Platform' }), listing(2, { role: 'Engineering Manager, Data' })]],
  ['status conflict', [listing(1), listing(2, { status: 'Applied' })]],
  ['unknown status', [listing(1, { status: 'Alien' }), listing(2, { status: 'Alien' })]],
  ['requisition conflict', [listing(1, { notes: 'req ABC-101' }), listing(2, { notes: 'req ABC-102' })]],
  ['employer URL conflict', [listing(1, { url: 'https://jobs.acme.test/101' }), listing(2, { url: 'https://jobs.acme.test/102' })]],
  ['duplicate tracker number', [listing(1), listing(1), listing(2)]],
]) test(`${name} fails without writes`, () => sandbox(({ tracker, cli, source }) => {
  const result = cli('--keep', '1', '--nums', '1,2');
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(readFileSync(tracker, 'utf8'), source);
  assert.equal(existsSync(`${tracker}.bak`), false);
}, content(...rows)));

test('checking every pair prevents LinkedIn bridge between employer requisitions', () => sandbox(({ tracker, cli, source }) => {
  const result = cli('--keep', '1', '--nums', '1,2,3');
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(tracker, 'utf8'), source);
}, content(listing(1), listing(2, { url: 'https://jobs.acme.test/102' }), listing(3, { url: 'https://jobs.acme.test/103' }))));

test('sequential merge cannot bridge prior employer source through retained LinkedIn row', () => sandbox(({ tracker, cli }) => {
  const first = cli('--keep', '1', '--nums', '1,2');
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = readFileSync(tracker, 'utf8');
  const backup = readFileSync(`${tracker}.bak`, 'utf8');
  const second = cli('--keep', '1', '--nums', '1,3');
  assert.notEqual(second.status, 0, second.stdout);
  assert.match(second.stderr, /conflicting employer posting URLs/);
  assert.equal(readFileSync(tracker, 'utf8'), afterFirst);
  assert.equal(readFileSync(`${tracker}.bak`, 'utf8'), backup);
}, content(listing(1), listing(2, { url: 'https://jobs.acme.test/101' }), listing(3, { url: 'https://jobs.acme.test/102' }))));

test('sequential compatible merge retains all previous employer sources', () => sandbox(({ tracker, cli }) => {
  assert.equal(cli('--keep', '1', '--nums', '1,2').status, 0);
  const second = cli('--keep', '1', '--nums', '1,3');
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(parseMergedListingSources(readFileSync(tracker, 'utf8')), [
    { num: '2', url: 'https://jobs.acme.test/101' },
    { num: '3', url: 'https://jobs.acme.test/101' },
  ]);
}, content(listing(1), listing(2, { url: 'https://jobs.acme.test/101' }), listing(3, { url: 'https://jobs.acme.test/101' }))));

test('sequential merge preserves language-version guards from prior source', () => sandbox(({ tracker, cli }) => {
  assert.equal(cli('--keep', '1', '--nums', '1,2').status, 0);
  const afterFirst = readFileSync(tracker, 'utf8');
  const second = cli('--keep', '1', '--nums', '1,3');
  assert.notEqual(second.status, 0, second.stdout);
  assert.equal(readFileSync(tracker, 'utf8'), afterFirst);
}, content(listing(1), listing(2, { url: 'https://jobs.acme.test/101?lang=en' }), listing(3, { url: 'https://jobs.acme.test/101?lang=de' }))));

test('all source requisition IDs are checked rather than only first note match', () => sandbox(({ tracker, cli, source }) => {
  const result = cli('--keep', '1', '--nums', '1,2');
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /conflicting requisition IDs/);
  assert.equal(readFileSync(tracker, 'utf8'), source);
}, content(listing(1, { notes: 'req ABC-101 · [Merged listing #9](<https://linkedin.com/jobs/view/9>): Notes: req ABC-102' }), listing(2, { notes: 'req ABC-101' }))));

test('sequential merge preserves prior requisition ID conflict protection', () => sandbox(({ tracker, cli }) => {
  assert.equal(cli('--keep', '1', '--nums', '1,2').status, 0);
  const afterFirst = readFileSync(tracker, 'utf8');
  const second = cli('--keep', '1', '--nums', '1,3');
  assert.notEqual(second.status, 0, second.stdout);
  assert.match(second.stderr, /conflicting requisition IDs/);
  assert.equal(readFileSync(tracker, 'utf8'), afterFirst);
}, content(listing(1), listing(2, { notes: 'req ABC-101' }), listing(3, { notes: 'req ABC-102' }))));

test('gender suffix formatting can differ while chosen identity remains unchanged', () => sandbox(({ tracker, cli }) => {
  const result = cli('--keep', '2', '--nums', '1,2');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(tracker, 'utf8').includes('| 2 | 2026-10-21 | Acme | Engineering Manager |'));
}, content(listing(1), listing(2, { role: 'Engineering Manager' }))));

test('localized reordered table preserves custom columns, escaped pipes and archive table', () => {
  const source = '# Tracker\r\n\r\n| Empresa | # | Status | Puesto | Score | Notes | Location | Via | URL | Custom |\r\n|---|---|---|---|---|---|---|---|---|---|\r\n| Acme | 1 | Evaluated | Manager | 4.1/5 | keep \\| intact | Berlin | — | https://linkedin.com/jobs/view/1 | chosen |\r\n| Acme | 2 | Evaluated | Manager | 4/5 | old \\| detail | Berlin | — | https://linkedin.com/jobs/view/2 | retained |\r\n\r\n## Archive\r\n\r\n' + header + '\r\n' + separator + '\r\n' + listing(2, { company: 'Archived' }) + '\r\n';
  sandbox(({ tracker, cli }) => {
    const result = cli('--keep', '1', '--nums', '1,2');
    assert.equal(result.status, 0, result.stderr);
    const after = readFileSync(tracker, 'utf8');
    assert.ok(after.includes('keep \\| intact'));
    assert.ok(after.includes('old \\| detail'));
    assert.ok(after.includes('Custom: retained'));
    assert.ok(after.includes(listing(2, { company: 'Archived' })));
    assert.equal(after.replace(/\r\n/g, '').includes('\n'), false);
  }, source);
});

for (const field of ['Location', 'Via']) test(`${field} conflict fails`, () => {
  const source = content(listing(1), listing(2)).replace(header, `${header} ${field} |`).replace(separator, `${separator}---|`)
    .replace(listing(1), `${listing(1)} Berlin |`).replace(listing(2), `${listing(2)} Munich |`);
  sandbox(({ tracker, cli }) => {
    const result = cli('--keep', '1', '--nums', '1,2');
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(tracker, 'utf8'), source);
  }, source);
});

test('retry fails clearly with original merge and backup untouched', () => sandbox(({ tracker, cli }) => {
  assert.equal(cli('--keep', '1', '--nums', '1,2').status, 0);
  const after = readFileSync(tracker, 'utf8');
  const backup = readFileSync(`${tracker}.bak`, 'utf8');
  const retry = cli('--keep', '1', '--nums', '1,2');
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /2/);
  assert.equal(readFileSync(tracker, 'utf8'), after);
  assert.equal(readFileSync(`${tracker}.bak`, 'utf8'), backup);
}));

test('source aliases expose removed URL identities and preserve report files', () => sandbox(({ dir, tracker, cli }) => {
  const reports = join(dir, 'reports');
  mkdirSync(reports);
  const report = join(reports, '2-acme.md');
  writeFileSync(report, '# Original report\n');
  const result = cli('--keep', '1', '--nums', '1,2');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseMergedListingSources(readFileSync(tracker, 'utf8')), [{ num: '2', url: 'https://www.linkedin.com/jobs/view/2' }]);
  assert.equal(readFileSync(report, 'utf8'), '# Original report\n');
  assert.deepEqual(parseMergedListingSources('[2](../reports/2-acme.md) and [Merged listing #3](javascript:alert(1))'), []);
}));

test('malformed first tracker header never falls through to archive table', () => {
  const active = content(listing(1), listing(2)).replace('| Status |', '| Unknown status field |');
  const source = active + '\n' + content(listing(1), listing(2));
  sandbox(({ tracker, cli }) => {
    const result = cli('--keep', '1', '--nums', '1,2');
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(tracker, 'utf8'), source);
  }, source);
});

test('same LinkedIn page with different language versions cannot merge', () => sandbox(({ tracker, cli, source }) => {
  const result = cli('--keep', '1', '--nums', '1,2');
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(tracker, 'utf8'), source);
}, content(listing(1, { url: 'https://linkedin.com/jobs/view/1?lang=en' }), listing(2, { url: 'https://linkedin.com/jobs/view/1?lang=de' }))));

test('symlink tracker retains symlink and writes backup beside canonical target', () => sandbox(({ dir, tracker, cli, source }) => {
  const target = join(dir, 'target.md');
  writeFileSync(target, source);
  rmSync(tracker);
  symlinkSync(target, tracker);
  const result = cli('--keep', '1', '--nums', '1,2');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).backup, `${target}.bak`);
  assert.equal(realpathSync(tracker), target);
  assert.equal(readFileSync(`${target}.bak`, 'utf8'), source);
  assert.equal(existsSync(`${tracker}.bak`), false);
}));

test('backup failure leaves original tracker unchanged', () => sandbox(({ tracker, cli, source }) => {
  mkdirSync(`${tracker}.bak`);
  const result = cli('--keep', '1', '--nums', '1,2');
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(tracker, 'utf8'), source);
}));

test('shared tracker lock prevents merge and leaves tracker untouched', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'merge-listings-lock-')));
  const tracker = join(dir, 'applications.md');
  const source = content(listing(1), listing(2));
  writeFileSync(tracker, source);
  const transaction = await openTrackerTransaction(tracker);
  try {
    const result = spawnSync(process.execPath, [join(ROOT, 'merge-listings.mjs'), '--keep', '1', '--nums', '1,2'], {
      encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_TRACKER: tracker, CAREER_OPS_TRACKER_LOCK: '', CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: '50', CAREER_OPS_TRACKER_LOCK_RETRY_MS: '10' },
    });
    assert.equal(result.status, 4, result.stderr);
    assert.match(result.stderr, /Timed out waiting for tracker lock/);
    assert.equal(readFileSync(tracker, 'utf8'), source);
    assert.equal(existsSync(`${tracker}.bak`), false);
  } finally { transaction.close(); rmSync(dir, { recursive: true, force: true }); }
});
