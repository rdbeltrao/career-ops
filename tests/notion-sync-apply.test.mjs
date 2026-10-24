// tests/notion-sync-apply.test.mjs — the local writer behind the notion-sync
// mode: a proposal JSON becomes five user-layer files, shown as a diff first
// and written only on --apply, idempotently, without touching anything else
// in config/profile.yml.
//
// Run:  node --test tests/notion-sync-apply.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadYaml } from '../lib/yaml-document.mjs';
import { loadValidatedProfile } from '../lib/career-profile.mjs';
import { listTree } from '../lib/walk-tree.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'notion-sync-apply.mjs');
const { mergeProfileBlocks, unifiedDiff, planWrites } = await import(pathToFileURL(SCRIPT).href);

const PROFILE = [
  '# Career-Ops Profile Configuration',
  'candidate:',
  '  full_name: "Test Person"   # keep this comment',
  '  email: "test@example.com"',
  '',
  'preferences:',
  '  confirmed_on: "2025-01-01"',
  '  hard_rules: ["Old rule"]',
  '',
  '# A comment between the blocks',
  'spend_tier: standard # keep',
  'language:',
  '  output: en',
  '',
].join('\n');

const PROPOSAL = {
  context_md: '# Fit profile: Test Person\n\n## Target role\n\n- Engineering Manager\n',
  preferences: {
    confirmed_on: '2026-10-24',
    hard_rules: ['Employee contract only'],
    minus: ['Agency work'],
    neutral: [],
    plus: ['Remote-first'],
    no_penalty: ['Travel up to 10%'],
  },
  interests: {
    recorded_on: '2025-03-01',
    confirmed_on: '2026-10-24',
    role_balance: 'about 75% people management, 25% hands-on',
    team_size: '6 to 10 engineers',
    team_type: ['customer-facing product teams'],
    domains: ['marketplaces'],
    ways_of_working: ['remote-first'],
    learning: ['AI-assisted engineering'],
  },
  article_digest_md: '# Article Digest -- Proof Points\n\n## EX-01 -- Rollout\n\n**Source:** Professional Examples (Notion)\n',
  cv_facts: {
    allow_metrics: ['12 engineers', '3 teams'],
    allow_facts: ['led the migration'],
    forbidden_phrases: ['Fortune 500'],
  },
  career_profile_facts: [
    {
      section: 'summary',
      id: 'notion-summary-1',
      text: 'Engineering manager with product teams in marketplaces and health.',
      evidence: { source: 'Profile, Skills & Credentials (Notion)', line: 1, quote: 'Engineering manager with product teams in marketplaces and health.' },
    },
    {
      section: 'experiences',
      id: 'notion-exp-acme',
      label: 'Acme — Engineering Manager',
      evidence: { source: 'Career History (Notion)', line: 4, quote: 'Acme — Engineering Manager' },
      facts: [
        { id: 'notion-exp-acme-1', text: 'Managed 12 engineers in 3 teams.', evidence: { source: 'Career History (Notion)', line: 5, quote: 'Managed 12 engineers in 3 teams.' } },
      ],
    },
  ],
};

const TARGETS = ['modes/_context.md', 'config/profile.yml', 'article-digest.md', 'config/cv-facts.json', 'data/career-profile.yml'];

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'notion-sync-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10 }));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'profile.yml'), PROFILE);
  writeFileSync(join(dir, 'config', 'cv-facts.json'), JSON.stringify({
    allow_metrics: ['3 teams', '10 users'], allow_facts: [], forbidden_phrases: ['patented'], warn_phrases: ['maybe'],
  }, null, 2) + '\n');
  const proposal = join(dir, 'proposal.json');
  writeFileSync(proposal, JSON.stringify(PROPOSAL, null, 2));
  return { dir, proposal };
}

function snapshot(dir) {
  const out = {};
  for (const file of listTree(dir)) out[relative(dir, file)] = readFileSync(file, 'utf-8');
  return out;
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf-8', timeout: 60_000 });
}

test('mergeProfileBlocks replaces only the two blocks and leaves every other byte alone', () => {
  const merged = mergeProfileBlocks(PROFILE, { preferences: PROPOSAL.preferences, interests: PROPOSAL.interests });
  const head = PROFILE.split('preferences:')[0];
  assert.ok(merged.startsWith(head), 'the text before the preferences block changed');
  assert.ok(merged.includes('# A comment between the blocks\nspend_tier: standard # keep\nlanguage:\n  output: en\n'), 'text after the block changed');
  assert.ok(!merged.includes('Old rule'), 'the old preferences block survived');
  const parsed = loadYaml(merged);
  assert.deepEqual(parsed.preferences, PROPOSAL.preferences);
  assert.deepEqual(parsed.interests, PROPOSAL.interests);
  assert.deepEqual(parsed.candidate, { full_name: 'Test Person', email: 'test@example.com' });
  assert.equal(parsed.spend_tier, 'standard');
  // Idempotent: merging the same blocks again changes nothing.
  assert.equal(mergeProfileBlocks(merged, { preferences: PROPOSAL.preferences, interests: PROPOSAL.interests }), merged);
  // Only the block that is proposed moves.
  const prefsOnly = mergeProfileBlocks(PROFILE, { preferences: PROPOSAL.preferences });
  assert.ok(!prefsOnly.includes('interests:'));
  // A profile with neither block gets them appended, and an empty profile works.
  assert.ok(mergeProfileBlocks('candidate:\n  full_name: x\n', { interests: PROPOSAL.interests }).includes('\ninterests:\n'));
  assert.deepEqual(loadYaml(mergeProfileBlocks('', { preferences: PROPOSAL.preferences })).preferences, PROPOSAL.preferences);
});

test('unifiedDiff shows removed and added lines with the file name', () => {
  const diff = unifiedDiff('a\nb\nc\n', 'a\nB\nc\nd\n', 'config/profile.yml');
  assert.match(diff, /^--- a\/config\/profile\.yml\n\+\+\+ b\/config\/profile\.yml\n/);
  assert.match(diff, /^-b$/m);
  assert.match(diff, /^\+B$/m);
  assert.match(diff, /^\+d$/m);
  assert.match(diff, /^ a$/m);
  assert.equal(unifiedDiff('same\n', 'same\n', 'x'), '', 'identical text has no diff');
  assert.match(unifiedDiff(null, 'new\n', 'x'), /^--- \/dev\/null\n\+\+\+ b\/x\n@@ [^\n]+ @@\n\+new$/m);
});

test('planWrites names the five targets and marks what changes', (t) => {
  const { dir } = fixture(t);
  const plan = planWrites(PROPOSAL, { dataRoot: dir });
  assert.deepEqual(plan.map((p) => p.path), TARGETS);
  assert.ok(plan.every((p) => p.changed), 'every target changes on a fresh data root');
  assert.equal(plan.find((p) => p.path === 'config/cv-facts.json').before !== null, true, 'the existing cv-facts.json is read');
  assert.equal(planWrites({}, { dataRoot: dir }).length, 0, 'an empty proposal plans nothing');
});

test('--dry-run writes nothing and prints a diff naming each target', (t) => {
  const { dir, proposal } = fixture(t);
  const before = snapshot(dir);
  const r = run(['--proposal', proposal, '--dry-run', '--data-root', dir]);
  assert.equal(r.status, 0, r.stderr);
  for (const target of TARGETS) {
    assert.ok(r.stdout.includes(`+++ b/${target}`), `the dry run does not show a diff for ${target}`);
  }
  assert.match(r.stdout, /dry run: nothing written/);
  assert.deepEqual(snapshot(dir), before, 'a dry run changed the data root');
  assert.ok(!existsSync(join(dir, 'modes', '_context.md')));
});

test('--apply writes the five files; a second apply is a no-op; profile keys outside the blocks are byte-identical', (t) => {
  const { dir, proposal } = fixture(t);
  const r = run(['--proposal', proposal, '--apply', '--data-root', dir]);
  assert.equal(r.status, 0, r.stderr);
  for (const target of TARGETS) assert.ok(existsSync(join(dir, target)), `${target} was not written`);
  assert.match(r.stdout, /written: modes\/_context\.md, config\/profile\.yml, article-digest\.md, config\/cv-facts\.json, data\/career-profile\.yml/);

  assert.equal(readFileSync(join(dir, 'modes', '_context.md'), 'utf-8'), PROPOSAL.context_md);
  assert.equal(readFileSync(join(dir, 'article-digest.md'), 'utf-8'), PROPOSAL.article_digest_md);

  const profileText = readFileSync(join(dir, 'config', 'profile.yml'), 'utf-8');
  assert.ok(profileText.startsWith(PROFILE.split('preferences:')[0]), 'the profile head changed');
  assert.ok(profileText.includes('spend_tier: standard # keep'), 'a key outside the blocks lost its comment');
  const parsed = loadYaml(profileText);
  assert.deepEqual(parsed.preferences, PROPOSAL.preferences);
  assert.deepEqual(parsed.interests, PROPOSAL.interests);
  assert.equal(parsed.candidate.full_name, 'Test Person');

  const facts = JSON.parse(readFileSync(join(dir, 'config', 'cv-facts.json'), 'utf-8'));
  assert.deepEqual(facts.allow_metrics, ['10 users', '12 engineers', '3 teams'], 'allow_metrics is not the sorted union');
  assert.deepEqual(facts.allow_facts, ['led the migration']);
  assert.deepEqual(facts.forbidden_phrases, ['Fortune 500', 'patented']);
  assert.deepEqual(facts.warn_phrases, ['maybe'], 'a key the proposal does not carry was dropped');

  const career = loadValidatedProfile({ dataRoot: dir });
  assert.equal(career.summary[0].id, 'notion-summary-1');
  assert.equal(career.summary[0].review_status, 'needs_review');
  assert.equal(career.experiences[0].label, 'Acme — Engineering Manager');
  assert.equal(career.experiences[0].facts[0].text, 'Managed 12 engineers in 3 teams.');
  assert.equal(career.experiences[0].facts[0].review_status, 'needs_review');

  const after = snapshot(dir);
  const again = run(['--proposal', proposal, '--apply', '--data-root', dir]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /written: none/);
  assert.match(again.stdout, /unchanged: modes\/_context\.md, config\/profile\.yml, article-digest\.md, config\/cv-facts\.json, data\/career-profile\.yml/);
  assert.deepEqual(snapshot(dir), after, 'the second apply changed a file');
});

test('usage errors: a missing proposal, both modes at once, an unknown flag', (t) => {
  const { dir, proposal } = fixture(t);
  assert.notEqual(run(['--dry-run']).status, 0, '--proposal is required');
  assert.notEqual(run(['--proposal', proposal, '--dry-run', '--apply', '--data-root', dir]).status, 0, '--dry-run and --apply exclude each other');
  assert.notEqual(run(['--proposal', proposal, '--aply', '--data-root', dir]).status, 0, 'a mistyped flag must not fall through to a dry run');
  assert.notEqual(run(['--proposal', join(dir, 'absent.json'), '--data-root', dir]).status, 0, 'a missing proposal file is an error');
});
