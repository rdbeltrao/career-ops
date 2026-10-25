import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyFacts, assertFacts } from '../verify-cv-facts.mjs';
import { runLatexFactGate } from '../generate-latex.mjs';
import { runPdfFactGate } from '../generate-pdf.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'career-context-facts-'));
  const directory = join(root, 'data', 'context-workspace');
  const pages = join(directory, 'pages');
  mkdirSync(pages, { recursive: true });
  mkdirSync(join(root, 'config'));
  mkdirSync(join(root, 'modes'));
  const configPath = join(root, 'config', 'cv-facts.json');
  writeFileSync(configPath, JSON.stringify({ forbidden_phrases: [], warn_phrases: [] }));
  const nodes = [
    { id: '1'.repeat(32), title: 'Career context', parentId: null, order: 0, usage: 'facts', text: '# Career context\n' },
    { id: '2'.repeat(32), title: 'Work history', parentId: '1'.repeat(32), order: 0, text: 'Led a team of 12 engineers.\n' },
    { id: '3'.repeat(32), title: 'Reference material', parentId: '1'.repeat(32), order: 1, usage: 'reference', text: 'Led a team of 900 engineers.\n' },
    { id: '4'.repeat(32), title: 'Preferences', parentId: '1'.repeat(32), order: 2, usage: 'preferences', text: 'Led a team of 77 engineers.\n' },
    { id: '5'.repeat(32), title: 'Unconfirmed', parentId: '1'.repeat(32), order: 3, usage: 'unconfirmed', text: 'Led a team of 555 engineers.\n' },
    { id: '6'.repeat(32), title: 'Reference child', parentId: '3'.repeat(32), order: 0, text: 'Led a team of 666 engineers.\n' },
  ];
  for (const node of nodes) writeFileSync(join(pages, `${node.id}.md`), node.text);
  const manifest = join(directory, 'index.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, rootId: nodes[0].id, pages: nodes.map(({ text, ...node }) => node) }));
  const options = { dataRoot: root, sourcePaths: [], configPath };
  return { root, manifest, pages, options, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a Context edit is immediately authoritative for fact checks without cv.md', () => {
  const f = fixture();
  try {
    assert.equal(verifyFacts('Led a team of 12 engineers.', f.options).verdict, 'pass');
    writeFileSync(join(f.pages, `${'2'.repeat(32)}.md`), 'Led a team of 15 engineers.\n');
    assert.equal(verifyFacts('Led a team of 12 engineers.', f.options).verdict, 'block');
    assert.equal(verifyFacts('Led a team of 15 engineers.', f.options).verdict, 'pass');
  } finally { f.cleanup(); }
});

test('reference, preferences, unconfirmed and inherited reference pages cannot substantiate claims', () => {
  const f = fixture();
  try {
    for (const count of [900, 77, 555, 666]) {
      assert.equal(verifyFacts(`Led a team of ${count} engineers.`, f.options).verdict, 'block', String(count));
    }
    const paths = ['3', '4', '5', '6'].map((id) => join(f.pages, `${id.repeat(32)}.md`));
    assert.equal(verifyFacts('Led a team of 900 engineers.', { ...f.options, sourcePaths: paths }).verdict, 'block', 'raw role-restricted pages cannot bypass the library');
  } finally { f.cleanup(); }
});

test('stale legacy files cannot override Context even when supplied explicitly', () => {
  const f = fixture();
  try {
    const paths = [join(f.root, 'cv.md'), join(f.root, 'article-digest.md'), join(f.root, 'modes', '_context.md')];
    for (const path of paths) writeFileSync(path, 'Led a team of 42 engineers.\n');
    assert.equal(verifyFacts('Led a team of 42 engineers.', { ...f.options, sourcePaths: paths }).verdict, 'block');
    assert.equal(verifyFacts('Led a team of 12 engineers.', { ...f.options, sourcePaths: paths }).verdict, 'pass');
    assert.throws(() => assertFacts('Led a team of 42 engineers.', { ...f.options, sourcePaths: paths }), /Context/);
  } finally { f.cleanup(); }
});

test('stored allowlists cannot override current Context facts, while wording policy still applies', () => {
  const f = fixture();
  try {
    writeFileSync(f.options.configPath, JSON.stringify({ allow_metrics: ['99 engineers', '45 engineers'], allow_facts: ['terraform', 'led the migration'], forbidden_phrases: ['forbidden wording'], warn_phrases: ['review wording'] }));
    const factsPath = join(f.pages, `${'2'.repeat(32)}.md`);
    writeFileSync(factsPath, 'Led a team of 45 engineers.\nContributed to the migration.\n');
    assert.equal(verifyFacts('Led a team of 99 engineers.', f.options).verdict, 'block');
    assert.equal(verifyFacts('Led a team of 45 engineers.', f.options).verdict, 'pass');
    assert.equal(verifyFacts('Built the service using Terraform.', f.options).verdict, 'block');
    assert.equal(verifyFacts('Led the migration.', f.options).verdict, 'block');
    assert.equal(verifyFacts('Led a team of 45 engineers. Forbidden wording.', f.options).verdict, 'block');
    assert.equal(verifyFacts('Led a team of 45 engineers. Review wording.', f.options).verdict, 'warn');
    assert.throws(() => assertFacts('Led the migration.', f.options), (error) => {
      assert.match(error.message, /Context/);
      assert.doesNotMatch(error.message, /allow_facts|config\/cv-facts/);
      return true;
    });
    const coverage = verifyFacts('Dirigé 45 techniciens sur 3 chantiers.', f.options).coverage;
    assert.match(coverage.message, /Context/);
    assert.doesNotMatch(coverage.message, /allow_metrics|config\/cv-facts/);
    writeFileSync(factsPath, 'Led a team of 50 engineers.\n');
    assert.equal(verifyFacts('Led a team of 45 engineers.', f.options).verdict, 'block');
    assert.equal(verifyFacts('Led a team of 50 engineers.', f.options).verdict, 'pass');
  } finally { f.cleanup(); }
});

test('legacy installations retain explicit metric and fact allowlist semantics', () => {
  const f = fixture();
  try {
    unlinkSync(f.manifest);
    writeFileSync(f.options.configPath, JSON.stringify({ allow_metrics: ['99 engineers'], allow_facts: ['terraform'], forbidden_phrases: [], warn_phrases: [] }));
    assert.equal(verifyFacts('Led a team of 99 engineers.', f.options).verdict, 'pass');
    assert.equal(verifyFacts('Built the service using Terraform.', f.options).verdict, 'pass');
  } finally { f.cleanup(); }
});

test('explicit independent evidence remains opt-in alongside the Context library', () => {
  const f = fixture();
  const separateRoot = mkdtempSync(join(tmpdir(), 'career-independent-evidence-'));
  try {
    const custom = join(f.root, 'approved-extra.md');
    writeFileSync(custom, 'Led a team of 24 engineers.\n');
    assert.equal(verifyFacts('Led a team of 24 engineers.', f.options).verdict, 'block');
    assert.equal(verifyFacts('Led a team of 24 engineers.', { ...f.options, sourcePaths: [custom] }).verdict, 'pass');
    assert.equal(verifyFacts('Led a team of 12 engineers.', { ...f.options, sourcePaths: [custom] }).verdict, 'pass');
    const separateCv = join(separateRoot, 'cv.md');
    writeFileSync(separateCv, 'Led a team of 24 engineers.\n');
    assert.equal(verifyFacts('Led a team of 24 engineers.', { ...f.options, sourcePaths: [separateCv] }).verdict, 'pass', 'an explicit independent file outside the canonical root remains opt-in');
  } finally { f.cleanup(); rmSync(separateRoot, { recursive: true, force: true }); }
});

test('unconfirmed lines within a facts page cannot substantiate candidate claims', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.pages, `${'2'.repeat(32)}.md`), 'Led a team of 12 engineers.\n\nNeeds confirmation: Led a team of 88 engineers.\n');
    assert.equal(verifyFacts('Led a team of 12 engineers.', f.options).verdict, 'pass');
    assert.equal(verifyFacts('Led a team of 88 engineers.', f.options).verdict, 'block');
  } finally { f.cleanup(); }
});

test('dataRoot resolves default sources and phrase policy anew for each call', () => {
  const first = fixture();
  const second = fixture();
  try {
    writeFileSync(join(second.pages, `${'2'.repeat(32)}.md`), 'Led a team of 24 engineers.\n');
    writeFileSync(join(second.root, 'config', 'cv-facts.json'), JSON.stringify({ forbidden_phrases: ['forbidden example'], warn_phrases: [] }));
    assert.equal(verifyFacts('Led a team of 12 engineers.', { dataRoot: first.root }).verdict, 'pass');
    assert.equal(verifyFacts('Led a team of 12 engineers.', { dataRoot: second.root }).verdict, 'block');
    assert.equal(verifyFacts('Led a team of 24 engineers.', { dataRoot: second.root }).verdict, 'pass');
    assert.equal(verifyFacts('A forbidden example.', { dataRoot: second.root }).verdict, 'block');
  } finally { first.cleanup(); second.cleanup(); }
});

test('a broken Context library blocks instead of falling back to legacy evidence', () => {
  const f = fixture();
  try {
    const cv = join(f.root, 'cv.md');
    writeFileSync(cv, 'Led a team of 12 engineers.\n');
    unlinkSync(join(f.pages, `${'2'.repeat(32)}.md`));
    assert.throws(() => verifyFacts('Led a team of 12 engineers.', { ...f.options, sourcePaths: [cv] }));
    writeFileSync(f.manifest, '{ malformed');
    assert.throws(() => verifyFacts('Led a team of 12 engineers.', { ...f.options, sourcePaths: [cv] }));
  } finally { f.cleanup(); }
});

test('LaTeX gates a Context-only root and reports unsupported claims before compilation', async () => {
  const f = fixture();
  try {
    assert.equal((await runLatexFactGate('Led a team of 12 engineers.', { root: f.root })).verdict, 'pass');
    const result = await runLatexFactGate('Led a team of 42 engineers.', { root: f.root });
    assert.equal(result.verdict, 'block');
    assert.match(result.reason, /Context/);
    writeFileSync(f.manifest, '{ malformed');
    assert.equal((await runLatexFactGate('Led a team of 12 engineers.', { root: f.root })).verdict, 'block');
  } finally { f.cleanup(); }
});

test('PDF gates a Context-only root and never bypasses a broken library', async () => {
  const f = fixture();
  try {
    assert.equal((await runPdfFactGate('<p>Led a team of 12 engineers.</p>', 'fictional CV', { dataRoot: f.root })).verdict, 'pass');
    await assert.rejects(runPdfFactGate('<p>Led a team of 42 engineers.</p>', 'fictional CV', { dataRoot: f.root }), /Context/);
    writeFileSync(f.manifest, '{ malformed');
    await assert.rejects(runPdfFactGate('<p>Led a team of 12 engineers.</p>', 'fictional CV', { dataRoot: f.root }));
  } finally { f.cleanup(); }
});

test('generation gates block unsafe Context ancestors instead of treating the library as absent', async () => {
  for (const relative of ['data/context-workspace', 'data']) {
    const f = fixture();
    try {
      const ancestor = join(f.root, relative);
      rmSync(ancestor, { recursive: true });
      symlinkSync(join(f.root, 'missing-context-target'), ancestor, 'dir');
      await assert.rejects(runPdfFactGate('Led a team of 12 engineers.', 'fictional CV', { dataRoot: f.root }), /symlink|Context/i);
      const latex = await runLatexFactGate('Led a team of 12 engineers.', { root: f.root });
      assert.equal(latex.verdict, 'block', relative);
      assert.match(latex.reason, /symlink|Context/i);
    } finally { f.cleanup(); }
  }
});

test('fact-check and cover-letter CLIs use Context and block stale claims before PDF output', () => {
  const f = fixture();
  try {
    const cv = join(f.root, 'cv.md');
    writeFileSync(cv, 'Led a team of 42 engineers.\n');
    const target = join(f.root, 'generated.md');
    writeFileSync(target, 'Led a team of 42 engineers.\n');
    const env = { ...process.env, CAREER_OPS_ROOT: f.root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_TRACKER: '' };
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../verify-cv-facts.mjs', import.meta.url)), target, '--source', cv, '--json'], { cwd: f.root, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).source, 'library');
    unlinkSync(cv);
    const payload = join(f.root, 'letter.json');
    writeFileSync(payload, JSON.stringify({ candidate: { name: 'Jordan Example' }, letter: { role_title: 'Engineer', opening: 'Led a team of 42 engineers.', profile_intro: 'Career experience.' }, output_path: 'output/letter.pdf' }));
    const cover = spawnSync(process.execPath, [fileURLToPath(new URL('../generate-cover-letter.mjs', import.meta.url)), '--payload', payload], { cwd: f.root, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(cover.status, 1, `${cover.stdout}${cover.stderr}`);
    assert.match(`${cover.stdout}${cover.stderr}`, /Context/);
    assert.equal(existsSync(join(f.root, 'output', 'letter.pdf')), false);
  } finally { f.cleanup(); }
});
