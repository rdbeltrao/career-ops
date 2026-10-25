import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSystemPrompt } from '../openrouter-runner.mjs';
import { loadContextText } from '../jev-score.mjs';
import { buildBudgetedPrompt } from '../lib/context-budget.mjs';
import { getBash } from './helpers.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IDS = ['1', '2', '3', '4'].map((digit) => digit.repeat(32));
const MARKER = 'LIBRARY_EDIT_REACHES_MATCHING';
const STALE = 'STALE_LEGACY_PERSONALIZATION';

function fixture(t, { legacy = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'context-library-evaluators-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = join(root, 'data', 'context-workspace');
  mkdirSync(join(library, 'pages'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'modes'), { recursive: true });
  const pages = IDS.map((id, index) => ({ id, title: ['Career', 'Preferences', 'Reference', 'Unconfirmed'][index], parentId: index ? IDS[0] : null, order: index ? index - 1 : 0, usage: ['facts', 'preferences', 'reference', 'unconfirmed'][index] }));
  writeFileSync(join(library, 'index.json'), JSON.stringify({ version: 1, rootId: IDS[0], pages }));
  for (const [index, body] of ['Original current fact.', 'PREFERENCE_ONLY_REMOTE', 'REFERENCE_IS_NOT_CANDIDATE_EVIDENCE', 'UNCONFIRMED_IS_NOT_CANDIDATE_EVIDENCE'].entries()) writeFileSync(join(library, 'pages', `${IDS[index]}.md`), body);
  writeFileSync(join(root, 'config', 'profile.yml'), `language:\n  output: en\n${legacy ? `north_star: ${STALE}\n` : ''}`);
  if (legacy) for (const file of ['cv.md', 'modes/_profile.md', 'modes/_context.md', 'article-digest.md']) writeFileSync(join(root, file), STALE);
  return { root, library, body: join(library, 'pages', `${IDS[0]}.md`) };
}

function captureEvaluator(t, engine, fx, extraEnv = {}) {
  const capture = join(fx.root, `${engine}-prompt.json`);
  const preload = join(fx.root, `${engine}-fetch.mjs`);
  const response = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((letter) => `## ${letter}) Block\nFixture evaluation.`).join('\n\n') + '\n---SCORE_SUMMARY---\nCOMPANY: Fixture\nROLE: Engineer\nSCORE: 4.0\nARCHETYPE: Builder\nLEGITIMACY: High Confidence\n---END_SUMMARY---';
  writeFileSync(preload, `import {writeFileSync} from 'node:fs';
globalThis.fetch = async (url, options = {}) => {
 const address = String(url);
 if (address.endsWith('/api/tags')) return new Response('{"models":[]}', {status:200});
 const body = JSON.parse(options.body || '{}');
 let reply;
 if (address.includes('generateContent')) { writeFileSync(${JSON.stringify(capture)}, JSON.stringify(body.systemInstruction)); reply = {candidates:[{content:{role:'model',parts:[{text:${JSON.stringify(response)}}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:1,candidatesTokenCount:1,totalTokenCount:2}}; }
 else if (address.endsWith('/api/chat')) { writeFileSync(${JSON.stringify(capture)}, JSON.stringify(body.messages.find(m=>m.role==='system').content)); reply = {message:{role:'assistant',content:${JSON.stringify(response)}},prompt_eval_count:1,eval_count:1}; }
 else throw new Error('Unexpected network request blocked by fixture: ' + address);
 return new Response(JSON.stringify(reply), {status:200,headers:{'content-type':'application/json'}});
};`);
  const env = { ...process.env, CAREER_OPS_ROOT: fx.root, CAREER_OPS_DATA_DIR: fx.root, CAREER_OPS_PROFILE: join(fx.root, 'config', 'profile.yml'), CAREER_OPS_JEV: 'off', CAREER_OPS_SKIP_KEYCHAIN: '1', CAREER_OPS_MASK_CONTEXT: '', GEMINI_API_KEY: 'fixture-key', OLLAMA_BASE_URL: 'http://127.0.0.1:19471', OLLAMA_NUM_CTX: '131072', ...extraEnv };
  delete env.CAREER_OPS_ALLOW_PAID_OPENROUTER;
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(ROOT, `${engine}-eval.mjs`), '--no-save', 'A fictional engineering job.'], { cwd: fx.root, env, encoding: 'utf8', timeout: 30_000 });
  return { ...result, prompt: existsSync(capture) ? readFileSync(capture, 'utf8') : null };
}

function captureBatch(t, fx, { cli = 'claude' } = {}) {
  const checkout = join(fx.root, 'checkout');
  const bin = join(checkout, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const file of ['batch/batch-runner.sh', 'path-resolver.mjs', 'context-evidence.mjs', 'lib/is-main-module.mjs', 'lib/context-evidence.mjs', 'lib/context-library.mjs']) {
    mkdirSync(dirname(join(checkout, file)), { recursive: true });
    copyFileSync(join(ROOT, file), join(checkout, file));
  }
  writeFileSync(join(checkout, 'batch', 'batch-prompt.md'), 'Fictional evaluation method.\n');
  writeFileSync(join(checkout, 'batch', 'batch-input.tsv'), 'id\turl\tsource\tnotes\n1\thttps://example.com/job\tfixture\t-\n');
  writeFileSync(join(checkout, 'reserve-report-num.mjs'), "if (!process.argv.includes('--release')) console.log('001');");
  for (const file of ['merge-tracker', 'reconcile-pipeline', 'verify-pipeline']) writeFileSync(join(checkout, `${file}.mjs`), '');
  writeFileSync(join(bin, 'curl'), '#!/usr/bin/env bash\nexit 1\n');
  const captured = join(checkout, 'captured-prompt.md');
  writeFileSync(join(bin, 'claude'), '#!/usr/bin/env bash\nprev=""\nfor arg in "$@"; do\n if [[ "$prev" == "--append-system-prompt-file" ]]; then cp "$arg" "$CAPTURE_PROMPT"; fi\n prev="$arg"\ndone\nexit 1\n');
  for (const name of ['gemini', 'opencode', 'qwen', 'grok']) {
    writeFileSync(join(bin, name), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$CAPTURE_PROMPT.args"\ncat > "$CAPTURE_PROMPT"\nexit 1\n');
    chmodSync(join(bin, name), 0o755);
  }
  chmodSync(join(bin, 'curl'), 0o755);
  chmodSync(join(bin, 'claude'), 0o755);
  const result = spawnSync(getBash(), [join(checkout, 'batch', 'batch-runner.sh'), '--cli', cli, '--parallel', '1', '--max-retries', '0', '--rate-limit-sleep', '0'], { cwd: checkout, encoding: 'utf8', timeout: 30_000, env: { ...process.env, CAREER_OPS_ROOT: fx.root, CAREER_OPS_DATA_DIR: fx.root, CAREER_OPS_PROFILE: join(fx.root, 'config', 'profile.yml'), PATH: `${bin}${delimiter}${process.env.PATH}`, CAPTURE_PROMPT: captured } });
  return { ...result, prompt: existsSync(captured) ? readFileSync(captured, 'utf8') : null, args: existsSync(`${captured}.args`) ? readFileSync(`${captured}.args`, 'utf8') : null };
}

test('OpenRouter library prompt trusts reader role notice and omits stale candidate sources', () => {
  const prompt = buildSystemPrompt('METHOD', { shared: 'RULES', cv: STALE, profileMode: STALE, profile: `language:\n  output: en\n${STALE}`, context: MARKER, contextSource: 'library', contextNotice: 'Role notice: references are not candidate evidence.' });
  assert.ok(prompt.includes(MARKER));
  assert.equal(prompt.split(MARKER).length, 2);
  assert.match(prompt, /Role notice: references are not candidate evidence/);
  assert.doesNotMatch(prompt, new RegExp(STALE));
  assert.doesNotMatch(prompt, /every fact and figure in it is evidence/);
});

test('OpenRouter reads the latest library and fails closed without making model calls', (t) => {
  const fx = fixture(t);
  writeFileSync(fx.body, MARKER);
  const driver = join(fx.root, 'openrouter-context.mjs');
  writeFileSync(driver, `const {loadContext,buildSystemPrompt}=await import(${JSON.stringify(pathToFileURL(join(ROOT, 'openrouter-runner.mjs')).href)}); process.stdout.write(buildSystemPrompt('METHOD',loadContext()));`);
  const run = () => spawnSync(process.execPath, [driver], { cwd: fx.root, encoding: 'utf8', timeout: 10_000, env: { ...process.env, CAREER_OPS_ROOT: fx.root, CAREER_OPS_DATA_DIR: fx.root, CAREER_OPS_PROFILE: join(fx.root, 'config', 'profile.yml') } });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split(MARKER).length, 2);
  assert.doesNotMatch(result.stdout, new RegExp(STALE));
  rmSync(fx.body);
  const broken = run();
  assert.notEqual(broken.status, 0);
  assert.doesNotMatch(broken.stdout, new RegExp(STALE));
});

test('the token budget keeps the complete library in a correctly labelled section', () => {
  const { contextBody, budgetReport } = buildBudgetedPrompt({ contextContent: MARKER, maxTokens: 1, safetyMargin: 0 });
  assert.match(contextBody, /CANDIDATE CONTEXT/);
  assert.equal(contextBody.split(MARKER).length, 2);
  assert.equal(budgetReport.overBudget, true);
});

test('Jev sees latest library edits and roles without a legacy context file', (t) => {
  const fx = fixture(t, { legacy: false });
  writeFileSync(fx.body, `${MARKER}\n`);
  const context = loadContextText({ dataRoot: fx.root, profilePath: join(fx.root, 'config', 'profile.yml') });
  assert.equal(context.source, 'library');
  assert.equal(context.text.split(MARKER).length, 2);
  assert.ok(context.text.includes(context.notice));
  assert.match(context.text, /reference/i);
  assert.match(context.text, /preferences/i);
});

test('Jev refuses an invalid library instead of falling back to legacy facts', (t) => {
  const fx = fixture(t);
  rmSync(fx.body);
  assert.throws(() => loadContextText({ dataRoot: fx.root }), /missing|unavailable|read|file/i);
});

for (const engine of ['gemini', 'ollama']) {
  test(`${engine} sends the latest library edit once and excludes stale files`, (t) => {
    const fx = fixture(t);
    writeFileSync(fx.body, MARKER);
    const result = captureEvaluator(t, engine, fx);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.prompt, 'the fixture model received no request');
    assert.equal(result.prompt.split(MARKER).length, 2);
    assert.doesNotMatch(result.prompt, new RegExp(STALE));
    assert.match(result.prompt, /reference/i);
    assert.doesNotMatch(result.prompt, /CANDIDATE CONTEXT \(modes\/_context\.md — the source of truth/);
  });
  test(`${engine} fails before its model request if a library page is missing`, (t) => {
    const fx = fixture(t);
    rmSync(fx.body);
    const result = captureEvaluator(t, engine, fx);
    assert.notEqual(result.status, 0);
    assert.equal(result.prompt, null, 'invalid Context must never reach a model request');
  });
}

test('Ollama refuses an oversized Context instead of silently truncating it', (t) => {
  const fx = fixture(t, { legacy: false });
  const result = captureEvaluator(t, 'ollama', fx, { OLLAMA_NUM_CTX: '1024' });
  assert.notEqual(result.status, 0);
  assert.equal(result.prompt, null);
  assert.match(result.stderr, /Context library exceeds this model’s prompt budget/);
});

test('batch worker receives a library-only root and the latest page content once', { skip: !getBash() }, (t) => {
  const fx = fixture(t, { legacy: false });
  writeFileSync(fx.body, MARKER);
  const result = captureBatch(t, fx);
  assert.ok(result.prompt, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.prompt.split(MARKER).length, 2);
  assert.match(result.prompt, /Runtime Context library/);
  assert.doesNotMatch(result.prompt, new RegExp(STALE));
});

test('batch refuses invalid Context before launching a worker', { skip: !getBash() }, (t) => {
  const fx = fixture(t);
  rmSync(fx.body);
  const result = captureBatch(t, fx);
  assert.equal(result.prompt, null);
  assert.match(result.stderr, /Context library could not be read/);
});

test('batch rejects a dangling library directory symlink instead of loading legacy facts', { skip: !getBash() }, (t) => {
  const fx = fixture(t);
  rmSync(fx.library, { recursive: true });
  symlinkSync(join(fx.root, 'missing-library'), fx.library, 'dir');
  const result = captureBatch(t, fx);
  assert.equal(result.prompt, null);
  assert.match(result.stderr, /Context library could not be read/);
});

for (const cli of ['gemini', 'opencode']) {
  test(`batch sends large Context through stdin to ${cli} with complete tail`, { skip: !getBash() }, (t) => {
    const fx = fixture(t, { legacy: false });
    writeFileSync(fx.body, `${'Fictional source sentence. '.repeat(6000)}\n${MARKER}`);
    const result = captureBatch(t, fx, { cli });
    assert.ok(result.prompt?.includes(MARKER), `${result.stdout}\n${result.stderr}`);
    assert.equal(result.prompt.split(MARKER).length, 2);
    assert.ok(Buffer.byteLength(result.prompt) > 150_000);
    assert.ok(Buffer.byteLength(result.args) < 1024, 'large Context must never travel in command arguments');
  });
}

test('batch explains unsupported large-prompt transport without launching Qwen', { skip: !getBash() }, (t) => {
  const fx = fixture(t, { legacy: false });
  writeFileSync(fx.body, 'Fictional source sentence. '.repeat(6000));
  const result = captureBatch(t, fx, { cli: 'qwen' });
  assert.equal(result.prompt, null);
  assert.match(result.stdout + result.stderr, /too large.*qwen|qwen.*too large/i);
  assert.match(result.stdout + result.stderr, /claude|gemini|opencode/);
});
