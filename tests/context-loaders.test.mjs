// tests/context-loaders.test.mjs — the context layer reaches every evaluation
// path, and the Jev pre-screen is wired in without being required.
//
// Two files and one block travel together:
//   - modes/_context.md, the candidate's fit profile, is a TARGETING source.
//     Every loader (the prompts, the OpenRouter runner, the batch runner) reads
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

test('modes/_shared.md lists _context.md as a targeting-only source and states the Jev rules once', () => {
  const shared = read('modes/_shared.md');
  const sourcesTable = shared.match(/^## Sources of Truth[\s\S]*?(?=^## )/m)?.[0] ?? '';
  assert.match(sourcesTable, /^\| _context\.md \| `\{DATA_ROOT\}\/modes\/_context\.md` \(if exists\) \| ALWAYS, targeting only/m,
    'the sources table has no _context.md row marked "ALWAYS, targeting only"');
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
  assert.match(prompt, /^\| Candidate context \| `modes\/_context\.md` if it exists \| Always; targeting only/m,
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
