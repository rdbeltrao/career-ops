import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const IDS = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(32));
const JD = '## Requirements\n- Python\n- Kubernetes\n- Terraform\n- Rust\n- Docker\n';
const REPORT = `## B) Match with CV

| Requirement | Match | Evidence / gap |
|---|---|---|
| Experience with Python | ❌ Missing | Not found in career records |
| Experience with Kubernetes | ❌ Missing | Not found in career records |
| Experience with Terraform | ❌ Missing | Not found in career records |
| Experience with Rust | ❌ Missing | Not found in career records |
`;

function fixture(t, legacy = false) {
  const root = mkdtempSync(join(tmpdir(), 'context-matching-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'data', 'context-workspace');
  mkdirSync(join(directory, 'pages'), { recursive: true });
  const manifest = { version: 1, rootId: IDS[0], pages: IDS.map((id, i) => ({
    id, title: ['Career record', 'Study guide', 'Job preferences', 'Notes to confirm'][i],
    parentId: i === 0 ? null : IDS[0], order: i === 0 ? 0 : i - 1,
    usage: ['facts', 'reference', 'preferences', 'unconfirmed'][i],
  })) };
  const manifestPath = join(directory, 'index.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const files = IDS.map((id) => join(directory, 'pages', `${id}.md`));
  for (const [i, content] of [
    '# Career\n\n## Skills\n\n- Worked with Python.\n',
    '# Kubernetes reference\n\n- Worked with Kubernetes.\n',
    '# Desired role\n\n- Work with Terraform.\n',
    '# Unconfirmed\n\n- Worked with Rust.\n',
  ].entries()) writeFileSync(files[i], content);
  if (legacy) {
    mkdirSync(join(root, 'modes'));
    writeFileSync(join(root, 'cv.md'), '# Skills\n\nPython, Kubernetes, Terraform, Rust, Docker.\n');
    writeFileSync(join(root, 'modes', '_context.md'), '- Worked with Python, Kubernetes, Terraform, Rust and Docker.\n');
  }
  const jd = join(root, 'jd.md'); const report = join(root, 'report.md');
  writeFileSync(jd, JD); writeFileSync(report, REPORT);
  return { root, files, manifestPath, jd, report };
}

function run(f, script, args) {
  const result = spawnSync(process.execPath, [join(REPO, script), ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, CAREER_OPS_ROOT: f.root, CAREER_OPS_DATA_DIR: '' },
  });
  assert.ifError(result.error);
  return result;
}

test('skill-gap checks use current Context facts without requiring a CV or trusting reference pages', (t) => {
  const f = fixture(t);
  const first = run(f, 'jd-skill-gap.mjs', [f.jd]);
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.ok([...result.existing, ...result.supportedByResume].includes('Python'));
  assert.deepEqual(result.gap.sort(), ['Docker', 'Kubernetes', 'Rust', 'Terraform']);
  const summary = run(f, 'jd-skill-gap.mjs', [f.jd, '--summary']);
  assert.match(summary.stdout, /Context/);
  assert.doesNotMatch(summary.stdout, /resume prose|in cv\.md/);
  writeFileSync(f.files[0], '# Skills\n\n- Worked with Docker.\n');
  const changed = JSON.parse(run(f, 'jd-skill-gap.mjs', [f.jd]).stdout);
  assert.ok(changed.gap.includes('Python'));
  assert.ok([...changed.existing, ...changed.supportedByResume].includes('Docker'));
});

test('Block B checks use current Context facts and preserve explicit diagnostic overrides', (t) => {
  const f = fixture(t);
  const first = run(f, 'verify-block-b-context.mjs', [f.report, '--json']);
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.context, realpathSync(f.manifestPath));
  assert.deepEqual(result.findings.map((finding) => finding.requirement), ['Experience with Python']);
  assert.match(run(f, 'verify-block-b-context.mjs', [f.report]).stdout, /Context pages mentions|Context pages mention/);
  writeFileSync(f.files[0], '# Skills\n\n- Worked with Docker.\n');
  assert.equal(JSON.parse(run(f, 'verify-block-b-context.mjs', [f.report, '--json']).stdout).status, 'ok');
  const override = join(f.root, 'diagnostic.md');
  writeFileSync(override, '- Worked with Rust.\n');
  const explicit = run(f, 'verify-block-b-context.mjs', [f.report, '--context', override, '--json']);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.deepEqual(JSON.parse(explicit.stdout).findings.map((finding) => finding.requirement), ['Experience with Rust']);
});

test('matching checks never resurrect stale CV or summary evidence when Context exists', (t) => {
  const f = fixture(t, true);
  const skills = JSON.parse(run(f, 'jd-skill-gap.mjs', [f.jd]).stdout);
  assert.deepEqual(skills.gap.sort(), ['Docker', 'Kubernetes', 'Rust', 'Terraform']);
  const report = JSON.parse(run(f, 'verify-block-b-context.mjs', [f.report, '--json']).stdout);
  assert.deepEqual(report.findings.map((finding) => finding.requirement), ['Experience with Python']);
});

test('a malformed library or missing page fails both checks instead of falling back to legacy files', (t) => {
  for (const corrupt of [(f) => writeFileSync(f.manifestPath, '{broken'), (f) => unlinkSync(f.files[1])]) {
    const f = fixture(t, true); corrupt(f);
    const skills = run(f, 'jd-skill-gap.mjs', [f.jd]);
    assert.equal(skills.status, 1);
    assert.equal(skills.stdout, '');
    assert.match(skills.stderr, /Context|context/i);
    const report = run(f, 'verify-block-b-context.mjs', [f.report, '--json']);
    assert.equal(report.status, 2);
    assert.equal(JSON.parse(report.stdout).status, 'unverified');
    assert.match(report.stderr, /Context|context/i);
  }
});
