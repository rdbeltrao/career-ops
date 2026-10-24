// tests/jev-criteria.test.mjs — the Jev criteria file and its loader.
//
// The question keys and choice labels are the contract every other Jev script
// reads (`jev-score.mjs` builds the request from them, `jev-rank.mjs` writes
// them into pipeline rows), so the shipped example has to carry exactly those
// keys, and a data-root copy has to win over it so the wording stays tunable
// per candidate without touching the checkout.
//
// Run: node --test tests/jev-criteria.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml } from '../lib/yaml-document.mjs';
import {
  BLOCKING_ANSWERS, QUESTION_KEYS, REASON_QUESTIONS, loadCriteria, validateCriteria,
} from '../lib/jev-criteria.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXAMPLE = join(ROOT, 'config', 'jev-criteria.example.yml');
const tmp = () => mkdtempSync(join(tmpdir(), 'jev-criteria-'));

test('the example file loads from the checkout when the data root has none', () => {
  const c = loadCriteria({ dataRoot: tmp(), codeRoot: ROOT });
  assert.ok(c.source.endsWith('jev-criteria.example.yml'), c.source);
  assert.equal(typeof c.preamble, 'string');
  assert.ok(c.preamble.length > 40);
  assert.equal(c.maxDescriptionChars, 6000);
  assert.deepEqual(Object.keys(c.questions), QUESTION_KEYS);
  assert.deepEqual(c.reasonQuestions, REASON_QUESTIONS);
  assert.deepEqual(c.blockingAnswers, BLOCKING_ANSWERS);
});

test('the example keys and labels are the contract', () => {
  const c = loadCriteria({ dataRoot: tmp(), codeRoot: ROOT });
  assert.deepEqual(QUESTION_KEYS, ['fit', 'verdict', 'seniority_match', 'location_ok', 'language_blocker', 'team_type', 'stack_fit']);
  assert.equal(c.questions.fit.type, 'noul');
  assert.deepEqual(Object.keys(c.questions.verdict.criteria), ['apply', 'maybe', 'skip']);
  assert.deepEqual(Object.keys(c.questions.seniority_match.criteria), ['below', 'match', 'above']);
  assert.deepEqual(Object.keys(c.questions.location_ok.criteria), ['yes', 'no', 'unclear']);
  assert.deepEqual(Object.keys(c.questions.language_blocker.criteria), ['none', 'missing', 'partial']);
  assert.deepEqual(Object.keys(c.questions.team_type.criteria), ['product', 'platform_infra', 'unclear']);
  assert.deepEqual(Object.keys(c.questions.stack_fit.criteria), ['required_match', 'desired_match', 'stack_agnostic', 'required_mismatch']);
  assert.deepEqual(c.blockingAnswers, {
    seniority_match: ['below', 'above'],
    location_ok: ['no'],
    language_blocker: ['missing'],
    stack_fit: ['required_mismatch'],
  });
  for (const key of QUESTION_KEYS) {
    assert.equal(typeof c.questions[key].instructions, 'string', `${key} has instructions`);
    assert.ok(c.questions[key].instructions.trim().length > 20, `${key} instructions are not a stub`);
  }
});

test('the example wording is generic: no personal stack, title or city', () => {
  const text = readFileSync(EXAMPLE, 'utf-8');
  for (const word of ['PHP', 'engineering manager', 'Engineering manager', 'Berlin', 'Vue', 'Renato']) {
    assert.ok(!text.includes(word), `example names "${word}"`);
  }
});

test('a data-root config/jev-criteria.yml wins over the example', () => {
  const dataRoot = tmp();
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  const own = loadYaml(readFileSync(EXAMPLE, 'utf-8'));
  own.preamble = 'My own preamble for one candidate.';
  own.max_description_chars = 4000;
  writeFileSync(join(dataRoot, 'config', 'jev-criteria.yml'), JSON.stringify(own));
  const c = loadCriteria({ dataRoot, codeRoot: ROOT });
  assert.equal(c.source, join(dataRoot, 'config', 'jev-criteria.yml'));
  assert.equal(c.preamble, 'My own preamble for one candidate.');
  assert.equal(c.maxDescriptionChars, 4000);
});

test('an explicit path wins over both', () => {
  const dir = tmp();
  const own = loadYaml(readFileSync(EXAMPLE, 'utf-8'));
  own.preamble = 'Explicit file.';
  const path = join(dir, 'anything.yml');
  writeFileSync(path, JSON.stringify(own));
  const c = loadCriteria({ dataRoot: tmp(), codeRoot: ROOT, path });
  assert.equal(c.source, path);
  assert.equal(c.preamble, 'Explicit file.');
});

test('an invalid file is refused with the problems named', () => {
  const dir = tmp();
  const path = join(dir, 'bad.yml');
  writeFileSync(path, 'preamble: x\nquestions:\n  fit:\n    type: noul\n    instructions: y\n');
  assert.throws(() => loadCriteria({ dataRoot: tmp(), codeRoot: ROOT, path }), /verdict/);
});

test('validateCriteria rejects a missing verdict question', () => {
  const own = loadYaml(readFileSync(EXAMPLE, 'utf-8'));
  delete own.questions.verdict;
  const problems = validateCriteria(own);
  assert.ok(problems.some((p) => /verdict/.test(p)), problems.join('; '));
});

test('validateCriteria rejects a choice question without criteria', () => {
  const own = loadYaml(readFileSync(EXAMPLE, 'utf-8'));
  delete own.questions.team_type.criteria;
  const problems = validateCriteria(own);
  assert.ok(problems.some((p) => /team_type/.test(p) && /criteria/.test(p)), problems.join('; '));
});

test('validateCriteria rejects a blocking answer that is not one of the labels', () => {
  const own = loadYaml(readFileSync(EXAMPLE, 'utf-8'));
  own.blocking_answers.location_ok = ['nope'];
  const problems = validateCriteria(own);
  assert.ok(problems.some((p) => /location_ok/.test(p) && /nope/.test(p)), problems.join('; '));
});

test('validateCriteria rejects a reason question that is not a choice question', () => {
  const own = loadYaml(readFileSync(EXAMPLE, 'utf-8'));
  own.reason_questions = ['fit'];
  const problems = validateCriteria(own);
  assert.ok(problems.some((p) => /reason_questions/.test(p)), problems.join('; '));
});

test('validateCriteria accepts the shipped example', () => {
  assert.deepEqual(validateCriteria(loadYaml(readFileSync(EXAMPLE, 'utf-8'))), []);
});

test('validateCriteria rejects non-objects', () => {
  assert.ok(validateCriteria(null).length > 0);
  assert.ok(validateCriteria('text').length > 0);
  assert.ok(validateCriteria([]).length > 0);
});
