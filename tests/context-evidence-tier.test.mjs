// tests/context-evidence-tier.test.mjs — modes/_context.md is the source of
// truth about the candidate under the Source-of-Truth Boundary.
//
// The context file is the record of what the candidate has done, mirrored
// from their career records; cv.md is one tailored rendering of it. An
// evaluation that judges the person on cv.md alone marks real experience as
// missing, so every mode reads the context file FIRST, every fact and figure in
// it is evidence (cited `_context.md:`), a requirement the context meets is a
// plain Strong or Partial, and cv.md silence is never a gap. Numbers are no
// longer masked: `node context-evidence.mjs` prints the file as written under
// a one-line notice, and masking is an opt-in for a context whose figures are
// still unresolved. Candidate-facing text may take facts from it. The rule is
// defined once, in AGENTS.md; every other file points there. These tests pin
// the wording in each place and the parity between the paths.
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

// The one label every automated evaluator puts above the context block.
const LABEL = 'CANDIDATE CONTEXT (modes/_context.md — the source of truth about the candidate, read first: every fact and figure in it is evidence, cite it as _context.md:; cv.md is a tailored rendering of it)';

test('AGENTS.md defines the context rule once: source of truth, every figure is evidence, candidate-facing text may use it', () => {
  const agents = read('AGENTS.md');
  const boundary = section(agents, '## Source-of-Truth Boundary (CRITICAL)', /\n## /);
  // The old tier heading is gone; the context file is listed first under Primary.
  assert.ok(!/\*\*Context \(qualitative evidence for the evaluation/.test(boundary), 'the old Context tier heading is still there');
  assert.ok(!/context tier/i.test(boundary), 'the boundary still speaks of a context tier');
  const primary = section(boundary, '**Primary / user-authored (full trust — the ground truth for facts):**', /\n\*\*Context file\.\*\*/);
  const firstBullet = primary.trim().split('\n')[0];
  assert.match(firstBullet, /^- `modes\/_context\.md` — \*\*the source of truth about the candidate\*\*/, 'modes/_context.md is not the first primary file');
  assert.match(firstBullet, /read FIRST in every mode/);
  assert.match(firstBullet, /`cv\.md` is one tailored rendering of it, never the authority/);
  assert.match(firstBullet, /the context wins and `cv\.md` is the file to fix/);
  assert.ok(primary.indexOf('`modes/_context.md`') < primary.indexOf('`cv.md` · `article-digest.md`'), 'the context file must come before cv.md');
  // The one definition.
  assert.match(boundary, /^\*\*Context file\.\*\* `modes\/_context\.md` holds the fit profile/m, 'no Context file paragraph');
  const rule = section(boundary, '**Context file.**', /\n\*\*Derived/);
  assert.match(rule, /This is the one place the context rule is defined; `modes\/_shared\.md`, `modes\/oferta\.md`, `batch\/batch-prompt\.md` and the evaluator scripts point here/);
  // Property 1: every fact, qualitative or quantified, is evidence, cited like cv.md lines.
  assert.match(rule, /Every fact in it, qualitative or quantified/);
  for (const kind of ['roles held', 'employers', 'domains worked in', 'responsibilities', 'skills', 'practices', 'languages', 'talks', 'publications', 'every number, percentage, team size, duration and amount of money']) {
    assert.ok(rule.includes(kind), `the rule does not list "${kind}" among the facts that are evidence`);
  }
  assert.match(rule, /is evidence, cited as `_context\.md:` the way a `cv\.md:` line is cited/);
  // Property 2: a context-met row is a plain Strong or Partial; cv.md silence is never a gap.
  assert.match(rule, /a plain `✅ Strong` or `⚠️ Partial` with that citation/);
  assert.match(rule, /`cv\.md` silence is never the reason for a Missing/);
  assert.ok(!/\(context\)/.test(rule), 'the (context) suffix convention is gone');
  // Property 3: numbers are not masked by default; masking is opt-in.
  assert.match(rule, /Numbers are not masked/);
  assert.match(rule, /prints the file as written under a one-line notice/);
  assert.match(rule, /opt-in \(`--mask`, or `CAREER_OPS_MASK_CONTEXT=1`\)/);
  // Property 4: candidate-facing text may use it, except figures the file flags.
  assert.match(rule, /Candidate-facing text — CV text, cover letters, form answers, emails and outreach — may take facts and figures from it/);
  assert.match(rule, /`verify-cv-facts\.mjs` reads it as a default source/);
  assert.match(rule, /held for confirmation, approximate, conflicting or "not a claim"/);
  assert.match(rule, /`config\/cv-facts\.json` → `forbidden_phrases`/);
  // The unchanged rules stay named.
  assert.match(rule, /The no-fabrication rule and the authorship rule below hold here/);
  assert.match(rule, /attributes it to the candidate in so many words/);
  // The targeting tier still exists, for preferences and interests, and names the context's preference sections.
  const targeting = section(boundary, '**Targeting / never evidence', /\n`story-bank\.md`/);
  assert.match(targeting, /`preferences` and `interests` blocks of `config\/profile\.yml`/);
  assert.match(targeting, /preference, deal-breaker and match-signal sections of `modes\/_context\.md`/);
  assert.match(targeting, /never what the candidate did/);
  // The authorship paragraph counts the context as a full source.
  assert.match(boundary, /attributed to them in `modes\/_context\.md`, `cv\.md` or `article-digest\.md`\. Tool-of-trade conflation/);
  assert.ok(!/for the evaluation only, in `modes\/_context\.md`/.test(boundary), 'authorship still limits the context file to the evaluation');
});

test('modes/_shared.md states the context rule and points at AGENTS.md', () => {
  const shared = read('modes/_shared.md');
  const sources = section(shared, '## Sources of Truth (EXCLUSIVE)', /\n## /);
  const row = sources.split('\n').find((l) => l.startsWith('| _context.md |')) ?? '';
  assert.match(row, /read through `node context-evidence\.mjs` \| ALWAYS, read FIRST — the source of truth about the candidate/);
  assert.match(row, /Every fact and figure in it .* is evidence, cited as `_context\.md:`/);
  assert.match(row, /`cv\.md` is a tailored rendering of it/);
  assert.match(row, /prints it as written under a one-line notice \(masking as `\[n\]` is opt-in: `--mask` or `CAREER_OPS_MASK_CONTEXT=1`\)/);
  assert.match(row, /Candidate-facing text \(CV, letter, form answer, outreach\) may take facts from it/);
  assert.match(row, /`AGENTS\.md` → Source-of-Truth Boundary → Context file/, 'the row does not point at the one definition');
  assert.ok(!/context tier/.test(row), 'the row still calls the file a tier');
  assert.match(sources, /^\*\*RULE: `modes\/_context\.md` is the source of truth about the candidate; read it first\.\*\*/m);
  assert.match(sources, /a plain `✅ Strong` or `⚠️ Partial`, never `❌ Missing` — `cv\.md` silence is never a gap/);
  assert.match(sources, /when the two disagree the context wins and `cv\.md` is the file to fix/);
  assert.ok(!/\(context\)/.test(sources), 'the (context) suffix is still in _shared.md');
  assert.ok(!/number-masked/.test(sources), '_shared.md still says the context arrives number-masked');
});

for (const [rel, blockHeading] of [['modes/oferta.md', '## Block B — Match with CV'], ['batch/batch-prompt.md', '#### Block B — CV Match']]) {
  test(`${rel}: Block B reads the context first in pass 2, never marks a context-met requirement Missing, and runs the Block B check`, () => {
    const text = read(rel);
    const blockB = section(text, blockHeading, /\n#{2,4} Block C/);
    assert.match(blockB, /`modes\/_context\.md`/, 'Block B does not name the context file');
    assert.match(blockB, /Pass 1 — JD only/, 'pass 1 must still be JD only');
    assert.match(blockB, /Pass 2 — CV and context/, 'pass 2 does not include the context file');
    assert.match(blockB, /`modes\/_context\.md` FIRST, then `article-digest\.md`, then `cv\.md`/, 'pass 2 does not read the context first');
    assert.match(blockB, /Before writing `⚠️ Partial` or `❌ Missing` in any row, check `modes\/_context\.md`/, 'pass 2 has no mechanical context check before a Partial or Missing');
    assert.match(blockB, /cite(?:s)? it as `_context\.md:` \(quote the line\)/, 'the citation must quote the context line');
    assert.match(blockB, /a plain `✅ Strong` or `⚠️ Partial`/, 'a context-met row must be a plain Strong or Partial');
    assert.match(blockB, /A `❌ Missing` row means neither the primary files nor `_context\.md` carry the fact/);
    assert.match(blockB, /`cv\.md` silence is never a gap/, 'Block B does not say cv.md silence is never a gap');
    assert.match(blockB, /never says "None in cv\.md" or "not in cv\.md"/, 'Block B does not forbid blaming cv.md silence');
    assert.match(blockB, /never `❌ Missing`, whether or not `cv\.md` shows it yet/, 'a requirement met by the context file must not be Missing');
    assert.match(blockB, /Machine Summary keeps plain `strong` \/ `partial`/, 'the Machine Summary enum must not change');
    assert.match(blockB, /`AGENTS\.md` → Source-of-Truth Boundary → Context file/, 'Block B does not point at the one definition');
    assert.match(blockB, /the source of truth about the candidate/);
    assert.match(blockB, /when the (?:two|context and the CV) disagree the context wins/);
    // The (context) suffix is named only to say it is gone; [n] only as an opt-in.
    assert.ok(!/`✅ Strong \(context\)`/.test(blockB), 'the (context) suffix convention is still in Block B');
    assert.ok(!/masked as `\[n\]`[^.]*\(`node context-evidence\.mjs`\)\. A `\[n\]` is never quoted/.test(blockB), 'Block B still describes the context as arriving masked');
    assert.match(blockB, /opt-in/, 'Block B does not say masking is an opt-in');
    // Flagged figures still back no Strong; the story-bank rule is unchanged.
    assert.match(blockB, /held for confirmation, approximate, conflicting or "not a claim"/);
    assert.match(blockB, /`derived-unverified`/);
    // The closing line, the check that follows it, and the Machine Summary enum.
    assert.match(blockB, /\*\*Context gaps to confirm:\*\*/, 'Block B has no Context gaps to confirm line');
    assert.match(blockB, /where no file — `modes\/_context\.md`, `article-digest\.md`, `cv\.md`, `config\/profile\.yml`, `modes\/_profile\.md` — carried anything/);
    assert.match(blockB, /never invent a fact to close one/i);
    assert.match(blockB, /`requirement_importance\.match` stays `strong \| partial \| missing \| na`/, 'the gaps line must stay out of the Machine Summary enum');
    const gapsAt = blockB.indexOf('**Context gaps to confirm');
    const checkAt = blockB.indexOf('**Block B check (mandatory, zero-LLM).**');
    assert.ok(checkAt > gapsAt && gapsAt !== -1, 'the Block B check must follow the Context gaps to confirm paragraph');
    const check = blockB.slice(checkAt);
    assert.match(check, /run `node verify-block-b-context\.mjs <report-file>`/);
    assert.match(check, /every row marked `?❌ Missing`? whose requirement names a technology or repeats a phrase found in `modes\/_context\.md`/);
    assert.match(check, /blames `cv\.md` silence for a Missing/);
    assert.match(check, /exits 0 with warnings \(`--strict` exits 1, `--json` for scripts\)/);
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

test('the router, the web prompt and the batch runner read the context through node context-evidence.mjs, unmasked', () => {
  const skill = read('.agents/skills/career-ops/SKILL.md');
  assert.match(skill, /read it through `node context-evidence\.mjs`[^\n]*never the raw file/);
  assert.match(skill, /prints the file as written under a one-line notice/);
  assert.match(skill, /masking every quantity as `\[n\]` is an opt-in, `--mask` or `CAREER_OPS_MASK_CONTEXT=1`/);
  assert.match(skill, /It is the source of truth about the candidate/);
  assert.match(skill, /read FIRST among the candidate files/);
  assert.match(skill, /`cv\.md` is a tailored rendering of it, and when the two disagree the context wins/);
  assert.match(skill, /Candidate-facing text \(CV, letter, form answer, outreach\) may take facts from it/);
  assert.match(skill, /\[output of `node context-evidence\.mjs` if modes\/_context\.md exists — the source of truth about the candidate, read first: every fact and figure in it is evidence, cited as _context\.md:; cv\.md is a tailored rendering of it\]/);
  assert.ok(!/context tier/.test(skill), 'SKILL.md still speaks of a context tier');
  assert.ok(!/numbers masked as \[n\]/.test(skill), 'SKILL.md still says the numbers are masked');
  const runner = read('batch/batch-runner.sh');
  assert.match(runner, /node "\$PROJECT_DIR\/context-evidence\.mjs" --file "\$context_file"/);
  assert.match(runner, /context-evidence\.mjs not found — pasting modes\/_context\.md directly, without its notice/, 'the runner must degrade with a line, never fail');
  assert.match(runner, /it is the source of truth about the candidate/);
  assert.ok(!/pasted number-masked/.test(runner), 'batch-runner.sh still says the context is pasted number-masked');
  const agents = read('AGENTS.md');
  assert.match(agents, /^\| `context-evidence\.mjs` \|/m, 'AGENTS.md scripts table has no row for context-evidence.mjs');
  const row = agents.split('\n').find((l) => l.startsWith('| `context-evidence.mjs` |')) ?? '';
  assert.match(row, /as written, under a one-line notice \(`CONTEXT_NOTICE` in `lib\/context-evidence\.mjs`\)/);
  assert.match(row, /Masking every quantity as `\[n\]` is opt-in \(`--mask`, or `CAREER_OPS_MASK_CONTEXT=1`/);
  assert.ok(!/mask such figures as `\[n\]` before the model sees the file/.test(agents), 'AGENTS.md still says the evaluators mask the figures');
  assert.match(agents, /^\| `verify-block-b-context\.mjs` \|/m, 'AGENTS.md scripts table has no row for verify-block-b-context.mjs');
  const check = agents.split('\n').find((l) => l.startsWith('| `verify-block-b-context.mjs` |')) ?? '';
  assert.match(check, /`❌ Missing`/);
  assert.match(check, /blames `cv\.md` silence/);
  assert.match(check, /`--strict` exits 1/);
  if (existsSync(join(ROOT, 'web', 'src', 'lib', 'run-prompts.mjs'))) {
    const prompts = read('web/src/lib/run-prompts.mjs');
    assert.match(prompts, /read FIRST the output of \\`node context-evidence\.mjs\\`/);
    assert.match(prompts, /the source of truth about the candidate under the Source-of-Truth Boundary, printed as written/);
    assert.match(prompts, /cite it as _context\.md:/);
    assert.match(prompts, /cv\.md is a tailored rendering of it/);
    assert.ok(!/\[n\]/.test(prompts), 'run-prompts.mjs still tells the agent about masked numbers');
    assert.ok(!/never read the raw file/.test(prompts), 'run-prompts.mjs still carries the raw-file warning');
  }
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

test('every translated _shared.md carries the _context.md row and the pointer to the rule', () => {
  const { readdirSync, statSync } = fsSync;
  const dirs = readdirSync(join(ROOT, 'modes')).filter((d) => statSync(join(ROOT, 'modes', d)).isDirectory() && existsSync(join(ROOT, 'modes', d, '_shared.md')) && d !== 'oferta-signals');
  assert.ok(dirs.length >= 20, `expected the translated modes directories, found ${dirs.length}`);
  for (const d of dirs) {
    const text = read(`modes/${d}/_shared.md`);
    assert.match(text, /^\| _context\.md \| `\{DATA_ROOT\}\/modes\/_context\.md` \(if exists\), read through `node context-evidence\.mjs` \| ALWAYS, read FIRST — the source of truth about the candidate/m, `modes/${d}/_shared.md has no _context.md row`);
    assert.match(text, /`AGENTS\.md` → Source-of-Truth Boundary → Context file/, `modes/${d}/_shared.md does not point at the rule`);
    assert.match(text, /^\*\*RULE: `modes\/_context\.md` is the source of truth about the candidate; read it first\.\*\*/m, `modes/${d}/_shared.md has no context rule`);
    assert.ok(!/\(context\)/.test(text), `modes/${d}/_shared.md still carries the (context) suffix`);
    assert.ok(!/context tier/.test(text), `modes/${d}/_shared.md still speaks of a context tier`);
  }
});

test('modes/oferta.md: Blocks C and F may name context facts and figures; flagged figures stay in words', () => {
  const oferta = read('modes/oferta.md');
  const blockC = section(oferta, '## Block C — Level and Strategy', /\n## Block D/);
  assert.match(blockC, /roles, scope, responsibilities and figures recorded in `modes\/_context\.md` \(cite `_context\.md:`\), the source of truth about the candidate/);
  assert.match(blockC, /a team size or head count the context states is named as the number it gives/);
  assert.match(blockC, /held for confirmation or approximate is described in words/);
  assert.ok(!/figures it names come from `cv\.md` or `article-digest\.md` only/.test(blockC), 'Block C still limits figures to cv.md');
  for (const [rel, heading, next] of [['modes/oferta.md', '## Block F — Interview Plan', /\n## Block G/], ['batch/batch-prompt.md', '#### Block F — Interview Plan', /\n#### Block G/]]) {
    const blockF = section(read(rel), heading, next);
    assert.match(blockF, /built on a fact from `modes\/_context\.md`/, `${rel}: Block F does not build stories on context facts`);
    assert.match(blockF, /figures (?:it states|included)/, `${rel}: Block F does not admit the context's figures`);
    assert.match(blockF, /every number inside a story comes from one of those files/, `${rel}: Block F does not name the files a number may come from`);
    assert.match(blockF, /held for confirmation or approximate states the result without the figure/, `${rel}: Block F does not keep a flagged figure out`);
    assert.match(blockF, /The story-bank `derived-unverified` rule is unchanged/, `${rel}: Block F drops the story-bank rule`);
  }
});

test('every evaluator presents modes/_context.md with the one source-of-truth label, and the OpenRouter runner uses the same label', () => {
  for (const file of ['openai-eval.mjs', 'gemini-eval.mjs', 'ollama-eval.mjs', 'batch-evaluate-gemini.mjs']) {
    const src = read(file);
    assert.ok(src.includes(LABEL), `${file} does not carry the shared source-of-truth label`);
    assert.ok(src.includes("'_context.md'"), `${file} does not read modes/_context.md`);
    assert.ok(!/targeting only, never evidence/.test(src), `${file} still carries the old targeting-only label`);
    assert.ok(!/context tier/.test(src), `${file} still speaks of a context tier`);
    assert.ok(!/masked as \[n\]/.test(src), `${file} still claims the numbers are masked`);
  }
  const runner = read('openrouter-runner.mjs');
  assert.ok(runner.includes(`${LABEL}:`), 'openrouter-runner.mjs does not carry the same label (with its trailing colon)');
  assert.ok(!/CANDIDATE CONTEXT \(context tier:/.test(runner), 'openrouter-runner.mjs still carries the old label without the file name');
  assert.ok(!/context tier/.test(runner), 'openrouter-runner.mjs still speaks of a context tier');
});

test('batch-evaluate-gemini.mjs loads modes/_context.md after _profile.md and runs as before without it', () => {
  const src = read('batch-evaluate-gemini.mjs');
  assert.match(src, /context:\s+join\(DATA_ROOT, 'modes', '_context\.md'\)/, 'PATHS has no context entry under the data root');
  assert.match(src, /readMaskedContext\(DATA_ROOT\)\?\.text \?\? ''/, 'the file must be optional and read through lib/context-evidence.mjs');
  assert.match(src, /modes\/_context\.md not found — evaluating on cv\.md and profile\.yml only/, 'no one-line notice for the absent file');
  const template = section(src, 'systemPromptTemplate = `', /IMPORTANT OPERATING RULES/);
  assert.ok(template.indexOf('(_profile.md)') < template.indexOf('${contextSection}'), 'the context section must follow _profile.md');
  assert.match(src, /const contextSection = contextContent\n\s+\? `/, 'the whole section must be conditional, so the prompt is unchanged without the file');
});

test('the context file is a source for candidate-facing text: the draft modes and the template say so', () => {
  const writing = section(read('modes/_writing.md'), '`modes/_context.md`:', /\n- `config\/profile\.yml`|\n\n/);
  assert.match(writing, /the source of truth about the candidate/);
  assert.match(writing, /preference, deal-breaker and match-signal sections are \*\*targeting only\*\*/, 'the preference sections stay targeting only');
  assert.match(writing, /experience facts and figures are evidence a draft may use/);
  assert.match(writing, /`verify-cv-facts\.mjs` reads the file as a source/);
  assert.match(writing, /held for confirmation, approximate, conflicting or "not a claim" stays out of candidate-facing text/);
  assert.ok(!/never supplies a fact, a number or a claim/.test(writing), '_writing.md still bars the drafts from the context file');
  const cover = read('modes/cover.md');
  assert.match(cover, /Only when no Context library exists, read `modes\/_context\.md` first/);
  assert.match(cover, /current facts pages as the authoritative candidate evidence/);
  assert.match(cover, /include them only when approved evidence substantiates the exact\s+figure and scope/);
  assert.ok(!/no fact, number or claim in the letter comes from `_context\.md`/.test(cover), 'cover.md still bars the letter from the context file');
  for (const rel of ['modes/email.md', 'modes/followup.md', 'modes/apply.md', 'modes/engage.md', 'modes/contacto.md', 'modes/interview-prep.md']) {
    const text = read(rel);
    assert.ok(!/never a fact or a number for the (?:email|draft)|never a fact\)|no fact, number or\nclaim in a message comes from either/.test(text), `${rel} still bars the draft from the context file`);
    assert.ok(!/context tier/.test(text), `${rel} still speaks of a context tier`);
  }
  const template = read('modes/_context.template.md');
  assert.match(template, /SOURCE OF TRUTH about you as a candidate/);
  assert.match(template, /read first in every mode/);
  assert.match(template, /may back candidate-facing text \(CV, cover letter, form answer\)/);
  assert.match(template, /cv\.md is one tailored\n\s+rendering of this file, never the authority/);
  assert.match(template, /prints it as written\n\s+under a one-line notice; masking every quantity as \[n\] is an opt-in/);
  assert.ok(!/CONTEXT\n\s+TIER/.test(template), 'the template still calls the file the context tier');
  assert.ok(!/Keep them as two documents/.test(template), 'the template still keeps the CV and the context apart');
  const contract = read('DATA_CONTRACT.md');
  assert.match(contract, /^\| `modes\/_context\.md` \| The source of truth about you as a candidate/m);
  assert.match(contract, /`verify-cv-facts\.mjs` reads it as a source/);
  assert.ok(!/context tier/.test(contract), 'DATA_CONTRACT.md still speaks of a context tier');
});
