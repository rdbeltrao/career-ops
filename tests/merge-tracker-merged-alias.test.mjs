import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pass, fail } from './helpers.mjs';
import { extractCellUrl, parseTrackerRow, resolveColumns } from '../tracker-parse.mjs';

const script = fileURLToPath(new URL('../merge-tracker.mjs', import.meta.url));
const header = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |';
const separator = '|---|---|---|---|---|---|---|---|---|---|';
const primary = 'https://www.linkedin.com/jobs/view/1001';
const alias = 'https://www.linkedin.com/jobs/view/1002';
const secondAlias = 'https://www.linkedin.com/jobs/view/1003';
const marker = (num, url) => `[Merged listing #${num}](<${url}>)`;
const row = (n, url, notes = 'Original note') => `| ${n} | 2026-10-25 | Fixture Alpha | Engineering Manager | 4.0/5 | Evaluated | ❌ | [${n}](../reports/${n}-fixture.md) | ${notes} | ${url} |`;

function fixture(rows) {
  const root = mkdtempSync(join(tmpdir(), 'co-merged-alias-'));
  const tracker = join(root, 'data/applications.md');
  const additions = join(root, 'additions');
  mkdirSync(join(root, 'data'));
  mkdirSync(additions);
  writeFileSync(tracker, `${header}\n${separator}\n${rows.join('\n')}\n`);
  const env = { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_CODE_ROOT: '', CAREER_OPS_TRACKER: tracker, CAREER_OPS_ADDITIONS: additions, CAREER_OPS_BATCH_STATE: join(root, 'absent-state.tsv') };
  return { root, tracker, additions, env };
}

function addition(f, num, url, notes = 'New evaluation') {
  const file = join(f.additions, `${num}-fixture.tsv`);
  writeFileSync(file, `num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\turl\n${num}\t2026-10-27\tFixture Alpha\tEngineering Manager\tEvaluated\t4.2/5\t❌\t[${num}](reports/${num}-fixture.md)\t${notes}\t${url}\n`);
  return file;
}

function parsed(f) {
  const lines = readFileSync(f.tracker, 'utf8').split('\n');
  const columns = resolveColumns(lines);
  return lines.map((line) => parseTrackerRow(line, columns)).filter(Boolean);
}

function check(name, fn) {
  try { fn(); pass(name); } catch (error) { fail(`${name} — ${error.message}`); }
}

check('merged source URLs re-ingest into the chosen tracker number and preserve its primary URL', () => {
  const f = fixture([row(1, primary, `Original note; ${marker(2, alias)}; ${marker(3, secondAlias)}`)]);
  try {
    for (const [num, url] of [[22, `${alias}?utm_source=repost`], [23, secondAlias]]) {
      addition(f, num, url);
      execFileSync(process.execPath, [script], { env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const rows = parsed(f);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].num, 1);
      assert.equal(extractCellUrl(rows[0].url), primary);
      assert.ok(rows[0].notes.includes(marker(2, alias)));
      assert.ok(rows[0].notes.includes(marker(3, secondAlias)));
      assert.ok(rows[0].notes.includes('../reports/1-fixture.md'), 'initial primary report remains linked in notes');
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

check('unmerged LinkedIn IDs and arbitrary notes links do not become aliases', () => {
  const f = fixture([row(1, primary, `[Interesting listing #2](${alias})`)]);
  try {
    addition(f, 22, alias);
    execFileSync(process.execPath, [script], { env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(parsed(f).length, 2);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

check('new unrelated rows cannot reuse archived merged tracker numbers, including nested URL-less snapshots', () => {
  const notes = `${marker(2, alias)}: Notes=Merged listing #7: Score=3.0/5; ${marker(9, secondAlias)}`;
  const f = fixture([row(1, primary, notes)]);
  try {
    addition(f, 2, 'https://www.linkedin.com/jobs/view/2002');
    addition(f, 7, 'https://www.linkedin.com/jobs/view/2007');
    execFileSync(process.execPath, [script], { env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const rows = parsed(f);
    assert.deepEqual(rows.map(({ num }) => num), [1, 10, 11]);
    assert.ok(rows[0].notes.includes('Merged listing #7:'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

check('merged tracker numbers introduced by an earlier same-run update stay reserved', () => {
  const f = fixture([row(1, primary, marker(2, alias))]);
  try {
    addition(f, 20, alias, 'Merged listing #30: Previous original row');
    addition(f, 30, 'https://www.linkedin.com/jobs/view/2030');
    execFileSync(process.execPath, [script], { env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.deepEqual(parsed(f).map(({ num }) => num), [1, 31]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const directConflict of [false, true]) {
  check(`ambiguous merged URL ${directConflict ? 'conflicting with a direct URL' : 'claimed by multiple canonical rows'} is refused`, () => {
    const f = fixture([row(1, primary, marker(2, alias)), row(4, directConflict ? alias : secondAlias, directConflict ? 'Original note' : marker(2, alias))]);
    try {
      const original = readFileSync(f.tracker, 'utf8');
      const pending = addition(f, 22, alias);
      const result = spawnSync(process.execPath, [script], { env: f.env, encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /ambiguous merged listing URL/i);
      assert.equal(readFileSync(f.tracker, 'utf8'), original);
      assert.equal(existsSync(pending), true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}
