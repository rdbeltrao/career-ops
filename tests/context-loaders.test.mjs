// tests/context-loaders.test.mjs — the context layer reaches every evaluation
// path, and the Jev pre-screen is wired in without being required.
//
// Two files and one block travel together:
//   - modes/_context.md, the candidate's fit profile, is the CONTEXT tier of the
//     Source-of-Truth Boundary (tests/context-evidence-tier.test.mjs covers the
//     wording of that tier). Every loader (the prompts, the OpenRouter runner, the batch runner) reads
//     it when present and runs exactly as before when it is absent.
//   - the Jev pre-screen block (modes/_shared.md → Calibrated pre-screen (Jev))
//     arrives from `node jev-score.mjs`; when that script is not installed every
//     path degrades to "not run" instead of failing.
//
// Run:  node --test tests/context-loaders.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8').replace(/\r\n/g, '\n');

// ── B3: the prompts ────────────────────────────────────────────────────────

test('modes/_shared.md lists _context.md as the context tier and states the Jev rules once', () => {
  const shared = read('modes/_shared.md');
  const sourcesTable = shared.match(/^## Sources of Truth[\s\S]*?(?=^## )/m)?.[0] ?? '';
  assert.match(sourcesTable, /^\| _context\.md \| `\{DATA_ROOT\}\/modes\/_context\.md` \(if exists\)(?:, read through `node context-evidence\.mjs`)? \| ALWAYS, context tier/m,
    'the sources table has no _context.md row marked "ALWAYS, context tier"');
  assert.match(shared, /^## Calibrated pre-screen \(Jev\)$/m);
  // The section names its own heading in prose, so cut at heading LINES, not at
  // the first occurrence of the text.
  const section = shared.match(/^## Calibrated pre-screen \(Jev\)$\n([\s\S]*?)(?=^## )/m)?.[1] ?? '';
  for (const phrase of ['hard stop', 'evaluate anyway', 'jev_score', 'never averaged', 'confirmed_on', '90 days', 'CV match', 'North Star']) {
    assert.ok(section.includes(phrase), `the Jev section does not mention "${phrase}"`);
  }
  // The section sits after Scoring System, where the Global score is defined.
  assert.ok(shared.indexOf('## Scoring System') < shared.indexOf('## Calibrated pre-screen (Jev)'));
  assert.ok(shared.indexOf('## Calibrated pre-screen (Jev)') < shared.indexOf('## Posting Legitimacy (Block G)'));
});

test('modes/oferta.md gates on the Jev pre-screen and reports it under the score', () => {
  const oferta = read('modes/oferta.md');
  assert.match(oferta, /^## Jev pre-screen gate$/m);
  assert.ok(oferta.indexOf('## Dealbreaker gate') < oferta.indexOf('## Jev pre-screen gate'));
  assert.ok(oferta.indexOf('## Jev pre-screen gate') < oferta.indexOf('## Agency confirmation gate'));
  const gate = oferta.split('## Jev pre-screen gate')[1].split('\n## ')[0];
  assert.ok(gate.includes('node jev-score.mjs --job'), 'the gate does not run jev-score');
  assert.ok(gate.includes('--format markdown'));
  assert.ok(gate.includes('Jev marks this as {blocking}. Evaluate it anyway?'), 'the interactive question is missing');
  assert.ok(gate.includes('needs_confirmation: jev {blocking} - rerun with "evaluate anyway" to evaluate'), 'the headless line is missing');
  assert.ok(gate.includes('not run'), 'the gate does not say what happens when jev-score is missing');
  assert.ok(gate.includes('Calibrated pre-screen (Jev)'));
  // Header line directly under **Score:**.
  assert.match(oferta, /^\*\*Score:\*\* \{X\/5\}\n\*\*Jev:\*\* /m, '**Jev:** is not the line under **Score:** in the report template');
  assert.ok(oferta.includes('**Jev:** not run'));
  // Machine Summary mirrors the block.
  assert.match(oferta, /Machine Summary \(required\)[^\n]*`jev:`/, 'the Machine Summary rule does not name the jev: block');
  assert.ok(oferta.includes('needs_confirmation: jev'), 'the Unattended runs paragraph does not list the jev gate');
});

test('modes/auto-pipeline.md runs the Jev gate as Step 0.8', () => {
  const auto = read('modes/auto-pipeline.md');
  assert.match(auto, /^## Step 0\.8 — Jev pre-screen gate$/m);
  assert.ok(auto.indexOf('## Step 0.7') < auto.indexOf('## Step 0.8'));
  assert.ok(auto.indexOf('## Step 0.8') < auto.indexOf('## Step 1 '));
  assert.ok(auto.split('## Step 0.8')[1].split('\n## ')[0].includes('Jev pre-screen gate'));
});

test('batch/batch-prompt.md loads _context.md, carries jev: in the schema and never recomputes the pre-screen', () => {
  const prompt = read('batch/batch-prompt.md');
  assert.match(prompt, /^\| Candidate context \| `modes\/_context\.md` if it exists \| Always; context tier/m,
    'the sources table has no modes/_context.md row');
  const fence = prompt.match(/#### Machine Summary[\s\S]*?```yaml\n([\s\S]*?)\n```/)?.[1] ?? '';
  assert.ok(fence, 'no Machine Summary fence');
  assert.match(fence, /^jev:$/m, 'the schema has no jev: block');
  for (const key of ['model:', 'fit:', 'score:', 'verdict:', 'blocking:', 'reasons:', 'seniority_match:', 'location_ok:', 'language_blocker:', 'team_type:', 'stack_fit:']) {
    assert.ok(fence.includes(key), `the jev: block is missing ${key}`);
  }
  assert.ok(prompt.includes('`jev: null`'), 'the prompt does not say when jev is null');
  assert.ok(prompt.includes('## Runtime pre-screen: jev'), 'the prompt does not name the block the orchestrator appends');
  assert.ok(/never recompute/i.test(prompt), 'the worker is not told to leave the pre-screen alone');
  assert.ok(prompt.includes('Calibrated pre-screen (Jev)'));
  const globalScore = prompt.split('#### Global Score')[1].split('#### Score Evidence')[0];
  assert.ok(/jev/i.test(globalScore), 'the Global Score section says nothing about the pre-screen');
  assert.ok(/never averaged/.test(globalScore));
});

// ── B4: the loaders ────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getBash, toBashPath } from './helpers.mjs';

const or = await import(pathToFileURL(join(ROOT, 'openrouter-runner.mjs')).href);
// The updater never ships web/; a CLI-only checkout has no machine-summary.mjs (#3269).
const WEB_LIB = join(ROOT, 'web', 'src', 'lib');
const { readMachineSummary } = existsSync(WEB_LIB) ? await import(pathToFileURL(join(WEB_LIB, 'machine-summary.mjs')).href) : { readMachineSummary: null };

test('SKILL.md loads modes/_context.md after _profile.md and before _custom.md, for every mode group and the subagent template', () => {
  const skill = read('.agents/skills/career-ops/SKILL.md');
  const loading = skill.split('## Context Loading by Mode')[1] ?? '';
  const shared = loading.split('### Modes that require `_shared.md` + their mode file')[1]?.split('\n### ')[0] ?? '';
  const standalone = loading.split('### Standalone modes with profile and custom context')[1]?.split('\n### ')[0] ?? '';
  const delegated = loading.split('### Modes delegated to subagent')[1] ?? '';
  for (const [label, text] of [['shared-context modes', shared], ['standalone modes', standalone], ['subagent template', delegated]]) {
    const profileAt = text.indexOf('modes/_profile.md');
    const contextAt = text.indexOf('modes/_context.md');
    const customAt = text.indexOf('modes/_custom.md');
    assert.ok(contextAt !== -1, `${label}: modes/_context.md is not loaded`);
    assert.ok(profileAt !== -1 && profileAt < contextAt && contextAt < customAt, `${label}: _context.md is not between _profile.md and _custom.md`);
  }
  assert.match(loading, /context tier/i, 'the router does not name the context tier');
  const rule = skill.split('\n').find((l) => l.startsWith('Resolve every path in this router')) ?? '';
  assert.ok(rule.includes('`modes/_context.md`'), 'the router does not resolve modes/_context.md against DATA_ROOT');
});

test('buildSystemPrompt appends the context after the CV and is byte-identical without it', () => {
  const ctx = { cv: 'CV TEXT', profile: 'language:\n  output: en\n', shared: 'SHARED', profileMode: 'PROFILE MODE' };
  const before = or.buildSystemPrompt('MODE', ctx);
  assert.equal(or.buildSystemPrompt('MODE', { ...ctx, context: '' }), before, 'an empty context changed the prompt');
  assert.equal(or.buildSystemPrompt('MODE', { ...ctx, context: undefined }), before, 'an undefined context changed the prompt');
  assert.ok(!before.includes('CANDIDATE CONTEXT'), 'the label leaks into a prompt with no context');
  const withContext = or.buildSystemPrompt('MODE', { ...ctx, context: 'CTX_SENTINEL_TARGETING' });
  assert.ok(withContext.includes('CANDIDATE CONTEXT (context tier:'), 'the context block has no label');
  assert.ok(withContext.includes('its numbers are masked as [n]'), 'the context label drops the masking note');
  assert.ok(withContext.indexOf('CV TEXT') < withContext.indexOf('CTX_SENTINEL_TARGETING'), 'the context must follow the CV');
  assert.ok(withContext.indexOf('CTX_SENTINEL_TARGETING') < withContext.indexOf('OUTPUT LANGUAGE'), 'the context must precede the language instruction');
});

test('resolveModelTimeoutMs: 15000 for unset or invalid, the integer otherwise', () => {
  assert.equal(or.resolveModelTimeoutMs({}), 15000);
  for (const bad of ['', ' ', 'abc', '0', '-5', '1.5', '15000ms', '99999999999999999999']) {
    assert.equal(or.resolveModelTimeoutMs({ CAREER_OPS_MODEL_TIMEOUT_MS: bad }), 15000, `"${bad}" should fall back`);
  }
  assert.equal(or.resolveModelTimeoutMs({ CAREER_OPS_MODEL_TIMEOUT_MS: '45000' }), 45000);
  assert.equal(or.resolveModelTimeoutMs({ CAREER_OPS_MODEL_TIMEOUT_MS: ' 120000 ' }), 120000);
  assert.match(read('openrouter-runner.mjs'), /^ \*[^\n]*CAREER_OPS_MODEL_TIMEOUT_MS/m, 'the header usage block does not document the variable');
});

const JOB = { url: 'https://example.com/jobs/1', title: '', company: '', location: '', workplace: '', seniority: '', description: 'A posting.' };
const SCORED = {
  model: 'typesafe/jev-1.13', fit: 79, score: 4.2, verdict: 'apply',
  reasons: { seniority_match: 'match', location_ok: 'yes', language_blocker: 'none', team_type: 'product', stack_fit: 'stack_agnostic' },
  confidences: {}, probabilities: {}, blocking: [], fallback: false, error: null,
};

test('loadJevModule returns null when jev-score.mjs is not installed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-absent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10 }));
  assert.equal(await or.loadJevModule({ jevPath: join(dir, 'jev-score.mjs') }), null);
});

test('jevPrescreen degrades to "not run" without the module, a key or a working scorer, and formats a scored result', async () => {
  const absent = await or.jevPrescreen(JOB, { jev: null, env: {} });
  assert.equal(absent.block, null, 'no module must add nothing to the request');
  assert.equal(absent.result, null);
  assert.match(absent.notice, /jev-score\.mjs/);

  const fake = {
    loadContextText: () => ({ text: 'CONTEXT TEXT', source: 'cv+profile' }),
    scoreJob: async (args) => ({ ...SCORED, _seen: args }),
    formatPrescreenMarkdown: (r) => `## Calibrated pre-screen (Jev)\n\nfit: ${r.fit} verdict: ${r.verdict}`,
  };
  // An empty data root and the Keychain skip keep a developer's real key out of
  // the "no key" case: resolveOpenRouterKey would otherwise read it from the
  // data root's .env or the macOS Keychain.
  const emptyRoot = mkdtempSync(join(tmpdir(), 'ctx-nokey-'));
  const noKeyEnv = { CAREER_OPS_SKIP_KEYCHAIN: '1' };
  const noKey = await or.jevPrescreen(JOB, { jev: fake, env: noKeyEnv, dataRoot: emptyRoot, loadCriteria: () => ({}) });
  assert.match(noKey.block, /^## Calibrated pre-screen \(Jev\)\n\nnot run: .*OPENROUTER_API_KEY/s);
  assert.equal(noKey.result, null);

  const scored = await or.jevPrescreen(JOB, { jev: fake, env: { OPENROUTER_API_KEY: 'k' }, loadCriteria: () => ({ questions: {} }) });
  assert.equal(scored.block, '## Calibrated pre-screen (Jev)\n\nfit: 79 verdict: apply');
  assert.equal(scored.result._seen.apiKey, 'k');
  assert.equal(scored.result._seen.profileText, 'CONTEXT TEXT');
  assert.deepEqual(scored.result._seen.job, JOB);
  assert.match(scored.notice, /Jev pre-screen: fit 79, apply/);

  const broken = { ...fake, scoreJob: async () => { throw new Error('boom'); } };
  const failed = await or.jevPrescreen(JOB, { jev: broken, env: { OPENROUTER_API_KEY: 'k' }, loadCriteria: () => ({}) });
  assert.match(failed.block, /^## Calibrated pre-screen \(Jev\)\n\nnot run: boom/);
  assert.equal(failed.result, null);

  const errored = { ...fake, scoreJob: async () => ({ ...SCORED, fit: null, score: null, verdict: null, error: 'HTTP 500' }) };
  const apiError = await or.jevPrescreen(JOB, { jev: errored, env: { OPENROUTER_API_KEY: 'k' }, loadCriteria: () => ({}) });
  assert.match(apiError.block, /not run: HTTP 500/);
});

const REPORT = (yaml) => `# Evaluation: Acme -- Engineer\n\n**Score:** 4.1/5\n\n## Machine Summary\n\n\`\`\`yaml\n${yaml}\n\`\`\`\n\n## A) Role Summary\n`;

test('readMachineSummary returns the jev block, or null when it is null or absent', { skip: !readMachineSummary && 'no web/ in this checkout' }, () => {
  const withJev = readMachineSummary(REPORT([
    'company: "Acme"', 'final_decision: "Apply"', 'score: 4.1',
    'jev:', '  model: "typesafe/jev-1.13"', '  fit: 79', '  score: 4.2', '  verdict: "apply"', '  blocking: []',
    '  reasons:', '    seniority_match: "match"', '    location_ok: "yes"', '    language_blocker: "none"', '    team_type: "product"', '    stack_fit: "stack_agnostic"',
  ].join('\n')));
  assert.deepEqual(withJev.jev, { fit: 79, score: 4.2, verdict: 'apply', blocking: [] });
  assert.equal(withJev.decision, 'Apply', 'the rest of the summary still parses');

  const blocking = readMachineSummary(REPORT(['final_decision: "Skip"', 'jev:', '  fit: 12', '  score: 1.5', '  verdict: "skip"', '  blocking:', '    - "location_ok=no"', '    - "seniority_match=above"'].join('\n')));
  assert.deepEqual(blocking.jev, { fit: 12, score: 1.5, verdict: 'skip', blocking: ['location_ok=no', 'seniority_match=above'] });

  const noFit = readMachineSummary(REPORT(['final_decision: "Consider"', 'jev:', '  fit: null', '  score: null', '  verdict: "maybe"'].join('\n')));
  assert.deepEqual(noFit.jev, { fit: null, score: null, verdict: 'maybe', blocking: [] });

  assert.equal(readMachineSummary(REPORT('final_decision: "Apply"\njev: null')).jev, null);
  assert.equal(readMachineSummary(REPORT('final_decision: "Apply"')).jev, null, 'older reports have no jev key');
});

test('the eval scripts and the web evaluate prompt load modes/_context.md as the context tier', () => {
  for (const file of ['openai-eval.mjs', 'gemini-eval.mjs', 'ollama-eval.mjs', 'batch-evaluate-gemini.mjs']) {
    const src = read(file);
    assert.ok(src.includes("'_context.md'"), `${file} does not read modes/_context.md`);
    assert.match(src, /CANDIDATE CONTEXT \(modes\/_context\.md — context tier:/, `${file} does not label the context as the context tier`);
    assert.match(src, /its numbers are masked as \[n\]/, `${file} drops the masking note`);
    assert.match(src, /readMaskedContext\(DATA_ROOT\)/, `${file} reads the context file raw instead of masked`);
    assert.match(src, /_context\.md not found/, `${file} has no one-line notice for the absent file`);
  }
  if (!existsSync(WEB_LIB)) return;
  const prompts = read('web/src/lib/run-prompts.mjs');
  assert.match(prompts, /modes\/_context\.md/, 'run-prompts.mjs does not name modes/_context.md');
  assert.match(prompts, /context tier/, 'run-prompts.mjs does not name the context tier');
  assert.match(prompts, /node context-evidence\.mjs/, 'run-prompts.mjs lets the agent read the raw context file instead of the masked output');
});

// ── batch-runner.sh: the flags, the context file and the degraded paths ────

const RUNNER = join(ROOT, 'batch', 'batch-runner.sh');
const RUNNER_SRC = read('batch/batch-runner.sh');
const bash = getBash();

test('batch-runner.sh parses (bash -n) and documents --min-jev and --skip-jev-verdict in usage()', () => {
  if (bash) {
    const r = spawnSync(bash, ['-n', RUNNER], { encoding: 'utf-8' });
    assert.equal(r.status, 0, r.stderr);
  }
  const usage = RUNNER_SRC.match(/usage\(\) \{\n  cat <<'USAGE'\n([\s\S]*?)\nUSAGE/)?.[1] ?? '';
  assert.match(usage, /^  --min-jev N\b/m, 'usage() does not list --min-jev');
  assert.match(usage, /^  --skip-jev-verdict /m, 'usage() does not list --skip-jev-verdict');
  assert.match(RUNNER_SRC, /--min-jev\)/, 'no case arm parses --min-jev');
  assert.match(RUNNER_SRC, /--skip-jev-verdict\)/, 'no case arm parses --skip-jev-verdict');
  // The context file rides in the personalization loop, between the profile and the house rules.
  const loop = RUNNER_SRC.match(/for context_file in ([^\n]+); do/)?.[1] ?? '';
  const order = ['modes/_profile.md', '$PROFILE_FILE', 'modes/_context.md', 'modes/_custom.md'].map((p) => loop.indexOf(p));
  assert.ok(order.every((i) => i !== -1) && order.join() === [...order].sort((a, b) => a - b).join(), `personalization order is wrong: ${loop}`);
  // The pre-screen is appended after every stable block, so the cacheable prefix is untouched.
  assert.ok(RUNNER_SRC.indexOf('## Runtime personalization:') < RUNNER_SRC.indexOf('## Runtime pre-screen: jev'));
  assert.ok(RUNNER_SRC.includes('[[ ! -f "$PROJECT_DIR/jev-score.mjs" ]]'), 'the jev call is not guarded by an existence check');
});

/**
 * A runner copied into a temp tree with a fake claude (captures the resolved
 * system prompt, exits 1), a fake curl (writes a 120-word JD) and, on request,
 * a fake jev-score.mjs driven by JEV_STUB_MODE.
 */
function batchFixture(t, { jevStub = true, context = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'batch-jev-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 10 }));
  const dir = join(base, 'checkout');
  const binDir = join(base, 'bin');
  const captureDir = join(base, 'captures');
  for (const d of [join(dir, 'batch'), join(dir, 'modes'), join(dir, 'reports'), join(dir, 'data'), binDir, captureDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dir, 'batch', 'batch-runner.sh'), RUNNER_SRC);
  chmodSync(join(dir, 'batch', 'batch-runner.sh'), 0o755);
  writeFileSync(join(dir, 'batch', 'batch-prompt.md'), 'Fixture worker prompt for {{URL}}.\n');
  writeFileSync(join(dir, 'batch', 'batch-input.tsv'), 'id\turl\tsource\tnotes\n1\thttps://example.com/jobs/one\tfixture\t-\n');
  writeFileSync(join(dir, 'path-resolver.mjs'), read('path-resolver.mjs'));
  mkdirSync(join(dir, 'lib'), { recursive: true });
  for (const rel of ['lib/is-main-module.mjs', 'lib/context-evidence.mjs']) writeFileSync(join(dir, rel), read(rel));
  writeFileSync(join(dir, 'context-evidence.mjs'), read('context-evidence.mjs'));
  writeFileSync(join(dir, 'reserve-report-num.mjs'), "if (!process.argv.includes('--release')) console.log('001');\n");
  for (const name of ['merge-tracker.mjs', 'reconcile-pipeline.mjs', 'verify-pipeline.mjs']) writeFileSync(join(dir, name), '// Not under test here.\n');
  if (context) writeFileSync(join(dir, 'modes', '_context.md'), '# Fit profile\n\nCONTEXT_SENTINEL_TARGETING across five teams of 20.\n');
  if (jevStub) {
    writeFileSync(join(dir, 'jev-score.mjs'), [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      '// The runner also imports this file (looking for formatPrescreenMarkdown) from a',
      '// `node -e` script with no --job flag, so the flag is what says "run as the CLI".',
      "if (process.argv.includes('--job')) {",
      "  const jobPath = process.argv[process.argv.indexOf('--job') + 1];",
      "  writeFileSync(process.env.CAPTURE_DIR + '/jev-job.json', readFileSync(jobPath, 'utf-8'));",
      "  const mode = process.env.JEV_STUB_MODE || 'apply';",
      "  if (mode === 'exit2') { console.error('jev-score: OPENROUTER_API_KEY not set'); process.exitCode = 2; }",
      "  else if (mode === 'exit1') { console.error('jev-score: HTTP 500'); process.exitCode = 1; }",
      '  else {',
      "    const skip = mode === 'skip';",
      '    const result = {',
      "      model: 'typesafe/jev-1.13', fit: skip ? 20 : 79, score: skip ? 1.8 : 4.2, verdict: skip ? 'skip' : 'apply',",
      "      reasons: { seniority_match: 'match', location_ok: skip ? 'no' : 'yes', language_blocker: 'none', team_type: 'product', stack_fit: 'stack_agnostic' },",
      "      confidences: { seniority_match: 0.91, location_ok: 0.88, language_blocker: 0.95, team_type: 0.7, stack_fit: 0.66 },",
      "      probabilities: {}, blocking: skip ? ['location_ok=no'] : [], fallback: false, error: null,",
      '    };',
      '    process.stdout.write(JSON.stringify(result));',
      '  }',
      '}',
      '',
    ].join('\n'));
  }
  const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
  writeFileSync(join(binDir, 'curl'), [
    '#!/usr/bin/env bash',
    'out=""; hdr=""; prev=""',
    'for a in "$@"; do',
    '  [[ "$prev" == "--output" ]] && out="$a"',
    '  [[ "$prev" == "--dump-header" ]] && hdr="$a"',
    '  prev="$a"',
    'done',
    '[[ -n "$hdr" ]] && printf "HTTP/1.1 200 OK\\r\\n\\r\\n" > "$hdr"',
    `[[ -n "$out" ]] && printf '<html><body><h1>Senior Engineer</h1><p>${words}</p></body></html>' > "$out"`,
    'exit 0',
    '',
  ].join('\n'));
  writeFileSync(join(binDir, 'claude'), [
    '#!/usr/bin/env bash',
    'prev=""',
    'for arg in "$@"; do',
    '  [[ "$prev" == "--append-system-prompt-file" ]] && cp "$arg" "$CAPTURE_DIR/prompt.md"',
    '  prev="$arg"',
    'done',
    'exit 1',
    '',
  ].join('\n'));
  chmodSync(join(binDir, 'curl'), 0o755);
  chmodSync(join(binDir, 'claude'), 0o755);
  return { dir, binDir, captureDir };
}

function runBatch({ dir, binDir, captureDir }, args, extraEnv = {}) {
  const env = { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}`, CAPTURE_DIR: captureDir, ...extraEnv };
  for (const k of ['CAREER_OPS_HEADLESS', 'CAREER_OPS_ROOT', 'CAREER_OPS_DATA_DIR', 'CAREER_OPS_PROFILE', 'CAREER_OPS_TRACKER']) delete env[k];
  const r = spawnSync(bash, [toBashPath(join(dir, 'batch', 'batch-runner.sh')), '--parallel', '1', '--max-retries', '0', '--rate-limit-sleep', '0', ...args], {
    cwd: dir, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], env,
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  const stateFile = join(dir, 'batch', 'batch-state.tsv');
  return {
    out: `${r.stdout}\n${r.stderr}`,
    prompt: existsSync(join(captureDir, 'prompt.md')) ? readFileSync(join(captureDir, 'prompt.md'), 'utf8') : null,
    job: existsSync(join(captureDir, 'jev-job.json')) ? JSON.parse(readFileSync(join(captureDir, 'jev-job.json'), 'utf8')) : null,
    state: existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : '',
  };
}

test('batch-runner.sh: no jev-score.mjs → one log line, worker spawned as before (even with --min-jev)', { skip: !bash && 'no bash' }, (t) => {
  const fx = batchFixture(t, { jevStub: false, context: true });
  const run = runBatch(fx, ['--min-jev', '50', '--skip-jev-verdict', 'skip']);
  assert.ok(run.prompt, `the worker was never launched:\n${run.out.slice(-800)}`);
  assert.match(run.out, /jev: jev-score\.mjs not found/, 'the degraded path logs no line');
  assert.ok(!run.prompt.includes('## Runtime pre-screen: jev'), 'no block may be appended when Jev did not run');
  // The runner indents the file as a code block, blank lines included.
  assert.match(run.prompt, /## Runtime personalization: modes\/_context\.md\n\n    <!-- Numbers in this context are masked as \[n\][^\n]*-->\n\s*\n    # Fit profile\n\s*\n    CONTEXT_SENTINEL_TARGETING across \[n\] teams of \[n\]\./, 'modes/_context.md is not injected masked into the worker prompt');
});

test('batch-runner.sh: jev-score.mjs exits 2 (no key) → one log line, worker spawned', { skip: !bash && 'no bash' }, (t) => {
  const fx = batchFixture(t);
  const run = runBatch(fx, ['--min-jev', '50'], { JEV_STUB_MODE: 'exit2' });
  assert.ok(run.prompt, `the worker was never launched:\n${run.out.slice(-800)}`);
  assert.match(run.out, /jev: no OPENROUTER_API_KEY/);
  assert.ok(!run.prompt.includes('## Runtime pre-screen: jev'));
});

test('batch-runner.sh: a scored result reaches the worker as ## Runtime pre-screen: jev, after the personalization', { skip: !bash && 'no bash' }, (t) => {
  const fx = batchFixture(t, { context: true });
  const run = runBatch(fx, [], { JEV_STUB_MODE: 'apply' });
  assert.ok(run.prompt, `the worker was never launched:\n${run.out.slice(-800)}`);
  assert.match(run.out, /jev: fit 79, apply/, 'the runner does not log the pre-screen');
  const at = run.prompt.indexOf('## Runtime pre-screen: jev');
  assert.ok(at !== -1, 'the pre-screen block is missing from the resolved prompt');
  assert.ok(run.prompt.indexOf('## Runtime personalization: modes/_context.md') < at, 'the pre-screen must come after the stable blocks');
  const block = run.prompt.slice(at);
  assert.match(block, /## Calibrated pre-screen \(Jev\)/);
  assert.match(block, /fit: 79\/100 \| jev_score: 4\.2\/5 \| verdict: apply/);
  assert.match(block, /seniority_match: match \(0\.91\)/);
  assert.match(block, /blocking: none/);
  // The job JSON handed to jev-score carries the row's URL and the prefetched JD text.
  assert.equal(run.job.url, 'https://example.com/jobs/one');
  assert.match(run.job.description, /Senior Engineer/);
  assert.match(run.job.description, /word119/);
  assert.ok(!/<html>/.test(run.job.description), 'HTML must not reach the pre-screen as markup');
});

test('batch-runner.sh: --skip-jev-verdict skip and --min-jev N skip the worker and record why', { skip: !bash && 'no bash' }, (t) => {
  const byVerdict = runBatch(batchFixture(t), ['--skip-jev-verdict', 'skip'], { JEV_STUB_MODE: 'skip' });
  assert.equal(byVerdict.prompt, null, 'the worker was spawned despite the verdict gate');
  assert.match(byVerdict.out, /Skipped by Jev/);
  assert.match(byVerdict.state, /\tskipped\t[^\n]*jev: 20 skip verdict-skip/);

  const byFit = runBatch(batchFixture(t), ['--min-jev', '50'], { JEV_STUB_MODE: 'skip' });
  assert.equal(byFit.prompt, null, 'the worker was spawned despite the fit gate');
  assert.match(byFit.state, /\tskipped\t[^\n]*jev: 20 skip below-min-jev/);

  // Both gates off: the same skip verdict still reaches a worker, with the block.
  const noGate = runBatch(batchFixture(t), [], { JEV_STUB_MODE: 'skip' });
  assert.ok(noGate.prompt, 'with both gates off the worker must run');
  assert.match(noGate.prompt, /verdict: skip/);
  assert.match(noGate.prompt, /blocking: location_ok=no/);
});

test('batch-runner.sh rejects a bad --min-jev or --skip-jev-verdict before doing anything', { skip: !bash && 'no bash' }, () => {
  for (const args of [['--min-jev', 'high'], ['--skip-jev-verdict', 'apply'], ['--skip-jev-verdict', 'skip,nope']]) {
    const r = spawnSync(bash, [RUNNER, ...args, '--dry-run'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, CAREER_OPS_ROOT: '', CAREER_OPS_DATA_DIR: '' } });
    assert.notEqual(r.status, 0, `${args.join(' ')} was accepted`);
    assert.match(`${r.stdout}${r.stderr}`, /ERROR: --(min-jev|skip-jev-verdict)/);
  }
});

test('ensureOpenRouterKeyInEnv keeps an existing key and returns null with no source', async () => {
  const withKey = { OPENROUTER_API_KEY: 'present' };
  assert.equal(await or.ensureOpenRouterKeyInEnv({ env: withKey }), 'present');
  const emptyRoot = mkdtempSync(join(tmpdir(), 'ctx-runner-key-'));
  const env = { CAREER_OPS_SKIP_KEYCHAIN: '1' };
  assert.equal(await or.ensureOpenRouterKeyInEnv({ env, dataRoot: emptyRoot }), null);
  assert.equal(env.OPENROUTER_API_KEY, undefined, 'nothing is written when no key was found');
});

test('resolveMaxTokens and resolveReasoning: defaults for unset or invalid, parsed otherwise', () => {
  assert.equal(or.resolveMaxTokens({}), 8192);
  for (const bad of ['', 'abc', '-1', '0', '1.5']) assert.equal(or.resolveMaxTokens({ CAREER_OPS_MAX_TOKENS: bad }), 8192, `"${bad}" should fall back`);
  assert.equal(or.resolveMaxTokens({ CAREER_OPS_MAX_TOKENS: ' 16384 ' }), 16384);
  assert.equal(or.resolveReasoning({}), null);
  for (const bad of ['', 'maximum', '0', '-5', 'LOWEST']) assert.equal(or.resolveReasoning({ CAREER_OPS_REASONING: bad }), null, `"${bad}" should send no field`);
  assert.deepEqual(or.resolveReasoning({ CAREER_OPS_REASONING: 'off' }), { enabled: false });
  assert.deepEqual(or.resolveReasoning({ CAREER_OPS_REASONING: ' Low ' }), { effort: 'low' });
  assert.deepEqual(or.resolveReasoning({ CAREER_OPS_REASONING: 'high' }), { effort: 'high' });
  assert.deepEqual(or.resolveReasoning({ CAREER_OPS_REASONING: '2048' }), { max_tokens: 2048 });
});

test('buildRequestBody sends reasoning only when resolved and keeps the cached system message', () => {
  const base = { model: 'm', systemPrompt: 'SYS', userMessage: 'USER', maxTokens: 8192 };
  const plain = or.buildRequestBody(base);
  assert.deepEqual(plain, {
    model: 'm',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: 'USER' },
    ],
    max_tokens: 8192,
    temperature: 0,
    seed: 42,
  });
  assert.equal(Object.hasOwn(plain, 'reasoning'), false, 'no field when nothing was resolved');
  const bounded = or.buildRequestBody({ ...base, maxTokens: 16384, reasoning: { effort: 'low' } });
  assert.equal(bounded.max_tokens, 16384);
  assert.deepEqual(bounded.reasoning, { effort: 'low' });
});

test('describeEmptyResponse names the all-reasoning budget exhaustion and falls back to the finish reason', () => {
  const exhausted = {
    choices: [{ finish_reason: 'length', native_finish_reason: 'max_tokens', message: { content: null } }],
    usage: { completion_tokens: 8192, completion_tokens_details: { reasoning_tokens: 8191 } },
  };
  const msg = or.describeEmptyResponse(exhausted, 8192);
  assert.match(msg, /spent its whole max_tokens budget \(8192\) on reasoning \(8191 of 8192/);
  assert.match(msg, /CAREER_OPS_REASONING=low/);
  assert.match(msg, /CAREER_OPS_MAX_TOKENS/);
  const filtered = { choices: [{ finish_reason: 'content_filter', message: { content: '' } }], usage: { completion_tokens: 10 } };
  assert.equal(or.describeEmptyResponse(filtered, 8192), 'Empty response (finish_reason "content_filter")');
  assert.equal(or.describeEmptyResponse({}, 8192), 'Empty response (finish_reason "unknown")');
});
