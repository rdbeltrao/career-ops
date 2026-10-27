import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareIdentityRepairs } from '../repair-tracker-identities.mjs';
import { detectColumns, parseTrackerRow } from '../tracker-parse.mjs';

const tracker = '# Applications\r\n\r\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |\r\n|---|---|---|---|---|---|---|---|---|---|\r\n| 3 | 2026-10-19 | Wrong label | (see report) | N/A | Rejected | ✅ | - | applied 2026-10-19; rejected 2026-10-22 | https://example.com/wrong |\r\n| 4 | 2026-10-20 | Keep | Manager | 4/5 | Applied | ❌ | - | Original notes | https://example.com/keep |\r\n';
const row = (content, num) => content.split('\r\n').map((line) => parseTrackerRow(line, detectColumns(content.split('\r\n')))).find((entry) => entry?.num === num);
function proposal() {
  const expected = row(tracker, 3);
  delete expected.raw;
  return [{ num: 3, expected, changes: { company: 'Correct company', role: 'Engineering Manager / Platform', url: 'https://example.com/right' }, note: 'Identity repaired; original values are retained in the audit receipt.', evidence: ['https://example.com/right'] }];
}
test('repairs the selected identity without changing application history, other rows, or line endings', () => {
  const result = prepareIdentityRepairs(tracker, proposal());
  const before = row(tracker, 3), after = row(result.content, 3);
  for (const field of ['num', 'date', 'score', 'status', 'pdf', 'report']) assert.equal(after[field], before[field]);
  assert.ok(after.notes.startsWith(before.notes));
  assert.equal(after.url, 'https://example.com/right');
  assert.equal(row(result.content, 4).raw, row(tracker, 4).raw);
  assert.equal(result.content.replaceAll('\r\n', '').includes('\n'), false);
  assert.deepEqual(prepareIdentityRepairs(result.content, proposal()).changes, []);
});
test('refuses history edits, ambiguous IDs, and stale proposals before writing anything', () => {
  const p = proposal();
  assert.throws(() => prepareIdentityRepairs(tracker, [{ ...p[0], changes: { status: 'Applied' } }]), /history fields/);
  assert.throws(() => prepareIdentityRepairs(tracker.replace('Wrong label', 'Changed elsewhere'), p), /changed since the proposal/);
  assert.throws(() => prepareIdentityRepairs(tracker, [...p, ...p]), /repeated tracker ID/);
  assert.throws(() => prepareIdentityRepairs(tracker, [{ ...p[0], changes: { url: 'javascript:bad' } }]), /posting URL/);
  assert.throws(() => prepareIdentityRepairs(tracker, [{ ...p[0], changes: { url: 'https://example.com/a|b' } }]), /posting URL/);
});

test('CLI defaults to preview, backs up the locked write, and leaves repeat runs unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-ops-identity-repair-'));
  try {
    fs.mkdirSync(path.join(root, 'data'));
    const trackerPath = path.join(root, 'data/applications.md');
    fs.writeFileSync(trackerPath, tracker);
    const proposalPath = path.join(root, 'proposal.json');
    fs.writeFileSync(proposalPath, JSON.stringify({ receipt_dir: 'output/repair', repairs: proposal() }));
    const cli = fileURLToPath(new URL('../repair-tracker-identities.mjs', import.meta.url));
    const env = { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_TRACKER: trackerPath };
    const run = (...args) => spawnSync(process.execPath, [cli, '--proposal', proposalPath, ...args], { env, encoding: 'utf8' });
    const preview = run();
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(fs.readFileSync(trackerPath, 'utf8'), tracker);
    assert.equal(fs.existsSync(path.join(root, 'output/repair')), false);
    const applied = run('--apply');
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'output/repair/applications.before.md'), 'utf8'), tracker);
    const receipt = fs.readFileSync(path.join(root, 'output/repair/receipt.json'), 'utf8');
    assert.equal(JSON.parse(receipt).status, 'applied');
    assert.equal(JSON.parse(receipt).changes[0].before.status, 'Rejected');
    const after = fs.readFileSync(trackerPath, 'utf8');
    const repeated = run('--apply');
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).changed, 0);
    assert.equal(fs.readFileSync(trackerPath, 'utf8'), after);
    assert.equal(fs.readFileSync(path.join(root, 'output/repair/receipt.json'), 'utf8'), receipt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
