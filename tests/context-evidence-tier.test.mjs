// tests/context-evidence-tier.test.mjs — modes/_context.md is the context tier
// of the Source-of-Truth Boundary.
//
// The CV and the candidate context are two different documents on purpose:
// cv.md is what the candidate sends, modes/_context.md is what the candidate
// has done. An evaluation that judges the person on cv.md alone marks real
// experience as missing, so the evaluation reads the context file's
// qualitative facts as evidence (cited `_context.md:`), while its numbers stay
// targeting only and candidate-facing text (CV, letters, form answers) takes
// nothing from it. The tier is defined once, in AGENTS.md; every other file
// points there. These tests pin the wording in each place and the safety
// properties around it.
//
// Run:  node --test tests/context-evidence-tier.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsSync from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8').replace(/\r\n/g, '\n');

const section = (text, startHeading, nextHeadingPattern) => {
  const start = text.indexOf(startHeading);
  assert.notEqual(start, -1, `heading not found: ${startHeading}`);
  const rest = text.slice(start + startHeading.length);
  const end = rest.search(nextHeadingPattern);
  return end === -1 ? rest : rest.slice(0, end);
};

test('AGENTS.md defines the context tier once, with the three properties', () => {
  const agents = read('AGENTS.md');
  const boundary = section(agents, '## Source-of-Truth Boundary (CRITICAL)', /\n## /);
  assert.match(boundary, /^\*\*Context \(qualitative evidence for the evaluation; NEVER a source for candidate-facing text\):\*\*$/m,
    'the Source-of-Truth Boundary has no Context tier heading');
  const tier = section(boundary, '**Context (qualitative evidence for the evaluation; NEVER a source for candidate-facing text):**', /\n\*\*Targeting/);
  assert.match(tier, /`modes\/_context\.md`/);
  // Property 1: qualitative facts are evidence, cited like cv.md lines, never "Missing".
  assert.match(tier, /Qualitative facts are evidence for the evaluation/);
  assert.match(tier, /cited as `_context\.md:`/);
  assert.match(tier, /never `❌ Missing`/);
  for (const kind of ['Roles held', 'domains', 'responsibilities', 'skills', 'practices', 'languages', 'talks', 'publications']) {
    assert.ok(tier.includes(kind), `the tier does not list "${kind}" among the qualitative facts`);
  }
  // Property 2: numbers stay targeting only.
  assert.match(tier, /Quantified claims stay targeting only/);
  assert.match(tier, /A figure is evidence only when `cv\.md` or `article-digest\.md` carries it/);
  assert.match(tier, /Claims to Confirm/);
  // Property 3: candidate-facing text keeps the primary rule, and the two documents stay apart.
  assert.match(tier, /Candidate-facing text keeps the primary rule/);
  assert.match(tier, /`verify-cv-facts\.mjs` does not read it/);
  assert.match(tier, /never copy a context fact into `cv\.md`/);
  // The targeting tier still exists, for preferences and interests, after the context tier.
  assert.ok(boundary.indexOf('**Context (qualitative evidence') < boundary.indexOf('**Targeting / never evidence'),
    'the targeting tier must follow the context tier');
  const targeting = section(boundary, '**Targeting / never evidence', /\n`story-bank\.md`/);
  assert.match(targeting, /`preferences` and `interests` blocks of `config\/profile\.yml`/);
  assert.match(targeting, /never what the candidate did/);
});

test('modes/_shared.md states the context-tier rule and points at AGENTS.md', () => {
  const shared = read('modes/_shared.md');
  const sources = section(shared, '## Sources of Truth (EXCLUSIVE)', /\n## /);
  const row = sources.split('\n').find((l) => l.startsWith('| _context.md |')) ?? '';
  assert.match(row, /ALWAYS, context tier/);
  assert.match(row, /qualitative facts .* are evidence for the evaluation/);
  assert.match(row, /numbers arrive masked as `\[n\]`/);
  assert.match(row, /node context-evidence\.mjs/);
  assert.match(row, /never a source for candidate-facing text/);
  assert.match(row, /`AGENTS\.md` → Source-of-Truth Boundary → Context tier/, 'the row does not point at the one definition');
  assert.match(sources, /^\*\*RULE: `modes\/_context\.md` is evidence for the evaluation and never for candidate-facing text\.\*\*/m);
  assert.match(sources, /`✅ Strong \(context\)` or `⚠️ Partial \(context\)`, never `❌ Missing`/);
  assert.match(sources, /The context reaches you number-masked: a `\[n\]` stands for a figure that lives only in `_context\.md`, is written nowhere in the report/);
});

for (const [rel, blockHeading] of [['modes/oferta.md', '## Block B — Match with CV'], ['batch/batch-prompt.md', '#### Block B — CV Match']]) {
  test(`${rel}: Block B reads the context tier in pass 2 and never marks a context-met requirement Missing`, () => {
    const text = read(rel);
    const blockB = section(text, blockHeading, /\n#{2,4} Block C/);
    assert.match(blockB, /`modes\/_context\.md`/, 'Block B does not name the context file');
    assert.match(blockB, /Pass 2 — CV and context/, 'pass 2 does not include the context file');
    assert.match(blockB, /Before writing `⚠️ Partial` or `❌ Missing` in any row, check `modes\/_context\.md`/, 'pass 2 has no mechanical context check before a Partial or Missing');
    assert.match(blockB, /A `❌ Missing` row means neither the primary files nor `_context\.md` carry the fact/);
    assert.match(blockB, /Pass 1 — JD only/, 'pass 1 must still be JD only');
    assert.match(blockB, /`✅ Strong \(context\)` or `⚠️ Partial \(context\)`, never `❌ Missing`/,
      'a requirement met only by the context file must not be Missing');
    assert.match(blockB, /Machine Summary keeps plain `strong` \/ `partial`/, 'the Machine Summary enum must not change');
    assert.match(blockB, /`_context\.md:`/, 'rows must cite the context file by prefix');
    assert.match(blockB, /`AGENTS\.md` → Source-of-Truth Boundary → Context tier/, 'Block B does not point at the one definition');
    // The quantified-claims caveat, in the Match column rule.
    assert.match(blockB, /never quoted in `Evidence \/ gap`/, 'a context-only number must never be quoted as evidence');
    assert.match(blockB, /`✅ Strong` never rests on it|never the basis of a `✅ Strong`/, 'a context-only number must never carry a Strong');
    assert.match(blockB, /figure left out/, 'the row that needs the figure must drop it');
    assert.match(blockB, /masked as `\[n\]`/, 'Block B does not say the context arrives number-masked');
    assert.match(blockB, /\*\*Context gaps to confirm:\*\*/, 'Block B has no Context gaps to confirm line');
    assert.match(blockB, /never invent a fact to close one/i);
    assert.match(blockB, /`requirement_importance\.match` stays `strong \| partial \| missing \| na`/, 'the gaps line must stay out of the Machine Summary enum');
    // The CV stays the CV.
    assert.match(blockB, /Nothing from `modes\/_context\.md` reaches the tailored CV|Nothing from `_context\.md` reaches the tailored CV/,
      'a cited row must not leak into the tailored CV');
  });
}

test('both report templates carry a Scoring note line that names a missing Jev gate or research', () => {
  const oferta = read('modes/oferta.md');
  assert.match(oferta, /^\*\*Jev:\*\* [^\n]*\n\*\*Scoring note:\*\* /m, 'oferta.md: **Scoring note:** is not the line under **Jev:**');
  const batch = read('batch/batch-prompt.md');
  assert.match(batch, /^\*\*Score:\*\* \{X\.X\/5\}\n\*\*Scoring note:\*\* /m, 'batch-prompt.md: **Scoring note:** is not the line under **Score:**');
  for (const text of [oferta, batch]) {
    const line = text.split('\n').find((l) => l.startsWith('**Scoring note:**'));
    assert.match(line, /`no Jev gate`/);
    assert.match(line, /`no web research`/);
    assert.match(line, /docs\/JEV\.md → Score variance/);
  }
  const jev = read('docs/JEV.md');
  assert.match(jev, /^## Score variance$/m);
  assert.match(jev, /lib\/sampling\.mjs/);
  assert.match(jev, /model noise/);
});

test('the router, the web prompt and the batch runner read the context through node context-evidence.mjs', () => {
  const skill = read('.agents/skills/career-ops/SKILL.md');
  assert.match(skill, /read it through `node context-evidence\.mjs`[^\n]*never the raw file/);
  assert.match(skill, /\[output of `node context-evidence\.mjs` if modes\/_context\.md exists/);
  const runner = read('batch/batch-runner.sh');
  assert.match(runner, /node "\$PROJECT_DIR\/context-evidence\.mjs" --file "\$context_file"/);
  assert.match(runner, /context-evidence\.mjs not found — pasting modes\/_context\.md unmasked/, 'the runner must degrade with a line, never fail');
  const agents = read('AGENTS.md');
  assert.match(agents, /^\| `context-evidence\.mjs` \|/m, 'AGENTS.md scripts table has no row for context-evidence.mjs');
  assert.match(agents, /mask such figures as `\[n\]` before the model sees the file/);
});

test('every automated evaluator sends temperature 0 and a fixed seed and runs the Jev pre-screen', () => {
  for (const file of ['openai-eval.mjs', 'gemini-eval.mjs', 'ollama-eval.mjs', 'batch-evaluate-gemini.mjs', 'openrouter-runner.mjs']) {
    const src = read(file);
    assert.match(src, /SAMPLING_TEMPERATURE/, `${file} does not use the shared temperature`);
    assert.match(src, /SAMPLING_SEED/, `${file} does not use the shared seed`);
    assert.ok(!/temperature:\s*0\.4/.test(src), `${file} still hardcodes temperature 0.4`);
    assert.match(src, /jevPrescreen\(/, `${file} does not run the Jev pre-screen`);
  }
  const sampling = read('lib/sampling.mjs');
  assert.match(sampling, /export const SAMPLING_TEMPERATURE = 0;/);
  assert.match(sampling, /export const SAMPLING_SEED = 42;/);
});

test('every translated _shared.md carries the _context.md row and the pointer to the tier', () => {
  const { readdirSync, statSync } = fsSync;
  const dirs = readdirSync(join(ROOT, 'modes')).filter((d) => statSync(join(ROOT, 'modes', d)).isDirectory() && existsSync(join(ROOT, 'modes', d, '_shared.md')) && d !== 'oferta-signals');
  assert.ok(dirs.length >= 20, `expected the translated modes directories, found ${dirs.length}`);
  for (const d of dirs) {
    const text = read(`modes/${d}/_shared.md`);
    assert.match(text, /^\| _context\.md \| `\{DATA_ROOT\}\/modes\/_context\.md` \(if exists\), read through `node context-evidence\.mjs` \| ALWAYS, context tier/m, `modes/${d}/_shared.md has no _context.md row`);
    assert.match(text, /`AGENTS\.md` → Source-of-Truth Boundary → Context tier/, `modes/${d}/_shared.md does not point at the tier`);
    assert.match(text, /^\*\*RULE: `modes\/_context\.md` is evidence for the evaluation and never for candidate-facing text\.\*\*/m, `modes/${d}/_shared.md has no context rule`);
  }
});

test('modes/oferta.md: Blocks C and F may frame on context facts, with the figures from cv.md only', () => {
  const oferta = read('modes/oferta.md');
  const blockC = section(oferta, '## Block C — Level and Strategy', /\n## Block D/);
  assert.match(blockC, /`modes\/_context\.md`/);
  assert.match(blockC, /figures it names come from `cv\.md` or `article-digest\.md` only/);
  const blockF = section(oferta, '## Block F — Interview Plan', /\n## Block G/);
  assert.match(blockF, /qualitative fact from `modes\/_context\.md`/);
  assert.match(blockF, /every number inside a story comes from `cv\.md` or `article-digest\.md`/);
  const batchF = section(read('batch/batch-prompt.md'), '#### Block F — Interview Plan', /\n#### Block G/);
  assert.match(batchF, /qualitative fact from `modes\/_context\.md`/);
  assert.match(batchF, /every number inside a story comes from `cv\.md` or `article-digest\.md`/);
});

test('every evaluator presents modes/_context.md as the context tier with the quantified-claims caveat', () => {
  const LABEL = 'CANDIDATE CONTEXT (modes/_context.md — context tier: qualitative facts are evidence for the evaluation, cite them as _context.md:; its numbers are masked as [n], so every figure you see came from cv.md or article-digest.md and a [n] is never written as a figure; never a source for the CV, a letter or a form answer)';
  for (const file of ['openai-eval.mjs', 'gemini-eval.mjs', 'ollama-eval.mjs', 'batch-evaluate-gemini.mjs']) {
    const src = read(file);
    assert.ok(src.includes(LABEL), `${file} does not carry the shared context-tier label`);
    assert.ok(src.includes("'_context.md'"), `${file} does not read modes/_context.md`);
    assert.ok(!/targeting only, never evidence/.test(src), `${file} still carries the old targeting-only label`);
  }
  const runner = read('openrouter-runner.mjs');
  assert.ok(runner.includes('CANDIDATE CONTEXT (context tier: qualitative facts are evidence for the evaluation, cite them as _context.md:; its numbers are masked as [n], so every figure you see came from cv.md or article-digest.md and a [n] is never written as a figure; never a source for the CV, a letter or a form answer):'),
    'openrouter-runner.mjs does not carry the context-tier label');
  const webPrompts = join(ROOT, 'web', 'src', 'lib', 'run-prompts.mjs');
  if (existsSync(webPrompts)) {
    const prompts = read('web/src/lib/run-prompts.mjs');
    assert.match(prompts, /context tier of the Source-of-Truth Boundary/);
    assert.match(prompts, /node context-evidence\.mjs/);
  }
});

test('batch-evaluate-gemini.mjs loads modes/_context.md after _profile.md and runs as before without it', () => {
  const src = read('batch-evaluate-gemini.mjs');
  assert.match(src, /context:\s+join\(DATA_ROOT, 'modes', '_context\.md'\)/, 'PATHS has no context entry under the data root');
  assert.match(src, /readMaskedContext\(DATA_ROOT\)\?\.text \?\? ''/, 'the file must be optional and masked');
  assert.match(src, /modes\/_context\.md not found — evaluating on cv\.md and profile\.yml only/, 'no one-line notice for the absent file');
  const template = section(src, 'systemPromptTemplate = `', /IMPORTANT OPERATING RULES/);
  assert.ok(template.indexOf('(_profile.md)') < template.indexOf('${contextSection}'), 'the context section must follow _profile.md');
  assert.match(src, /const contextSection = contextContent\n\s+\? `/, 'the whole section must be conditional, so the prompt is unchanged without the file');
});

test('the safety property holds: verify-cv-facts.mjs and the draft modes take nothing from modes/_context.md', () => {
  assert.ok(!/_context\.md/.test(read('verify-cv-facts.mjs')), 'verify-cv-facts.mjs must not read modes/_context.md');
  const writing = section(read('modes/_writing.md'), '`modes/_context.md`:', /\n- `config\/profile\.yml`|\n\n/);
  assert.match(writing, /targeting only/, '_writing.md must keep the context file targeting only for drafts');
  assert.match(writing, /never supplies a fact, a number or a claim for candidate-facing text/);
  assert.match(writing, /ask the candidate to confirm it in the conversation first/);
  const cover = read('modes/cover.md');
  assert.match(cover, /no fact, number or claim in the letter comes from `_context\.md`/);
  const template = read('modes/_context.template.md');
  assert.match(template, /CONTEXT\n\s+TIER/);
  assert.match(template, /numbers are\n\s+targeting only/);
  assert.match(template, /Keep them as two documents/);
});
