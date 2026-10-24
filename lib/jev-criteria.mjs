/**
 * jev-criteria.mjs — load and validate the Jev criteria file.
 *
 * The criteria are the questions `jev-score.mjs` sends to OpenRouter's
 * decisions endpoint (model typesafe/jev-1.13) and the rules the rest of the
 * Jev scripts read back: which answers are "reasons", which answers block.
 * The wording is the user's to tune, so it lives in a YAML file in the data
 * root (`config/jev-criteria.yml`) with a generic example shipped in the
 * checkout (`config/jev-criteria.example.yml`). The question keys and choice
 * labels are the contract and are pinned here as constants.
 *
 * Nothing in this module reads the network or the candidate's files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml } from './yaml-document.mjs';

const CODE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const EXAMPLE_RELATIVE_PATH = join('config', 'jev-criteria.example.yml');
export const USER_RELATIVE_PATH = join('config', 'jev-criteria.yml');

/** Every question key, in request order. */
export const QUESTION_KEYS = ['fit', 'verdict', 'seniority_match', 'location_ok', 'language_blocker', 'team_type', 'stack_fit'];

/** The choice questions whose answers are shown as a job's reasons. */
export const REASON_QUESTIONS = ['seniority_match', 'location_ok', 'language_blocker', 'team_type', 'stack_fit'];

/** Answers that turn a `skip` verdict into a hard stop. */
export const BLOCKING_ANSWERS = {
  seniority_match: ['below', 'above'],
  location_ok: ['no'],
  language_blocker: ['missing'],
  stack_fit: ['required_mismatch'],
};

export const DEFAULT_MAX_DESCRIPTION_CHARS = 6000;

const QUESTION_TYPES = new Set(['choice', 'noul']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Problems with a parsed criteria document. Empty when it is usable.
 *
 * @param {unknown} obj - The parsed YAML.
 * @returns {string[]}
 */
export function validateCriteria(obj) {
  const problems = [];
  if (!isPlainObject(obj)) return ['criteria must be a YAML mapping'];

  if (!isNonEmptyString(obj.preamble)) problems.push('preamble must be a non-empty string');

  if (obj.max_description_chars !== undefined
    && !(Number.isInteger(obj.max_description_chars) && obj.max_description_chars > 0)) {
    problems.push('max_description_chars must be a positive integer');
  }

  const questions = obj.questions;
  if (!isPlainObject(questions)) {
    problems.push('questions must be a mapping');
    return problems;
  }

  for (const key of QUESTION_KEYS) {
    if (!isPlainObject(questions[key])) problems.push(`questions.${key} is missing`);
  }
  for (const key of Object.keys(questions)) {
    if (!QUESTION_KEYS.includes(key)) problems.push(`questions.${key} is not one of the known question keys`);
  }

  for (const [key, q] of Object.entries(questions)) {
    if (!isPlainObject(q)) continue;
    if (!QUESTION_TYPES.has(q.type)) problems.push(`questions.${key}.type must be "choice" or "noul"`);
    if (!isNonEmptyString(q.instructions)) problems.push(`questions.${key}.instructions must be a non-empty string`);
    if (q.type === 'choice') {
      if (!isPlainObject(q.criteria) || Object.keys(q.criteria).length === 0) {
        problems.push(`questions.${key} is a choice question without criteria`);
      } else {
        for (const [label, description] of Object.entries(q.criteria)) {
          if (!isNonEmptyString(description)) problems.push(`questions.${key}.criteria.${label} must be a non-empty string`);
        }
      }
    } else if (q.criteria !== undefined) {
      problems.push(`questions.${key} is a noul question and takes no criteria`);
    }
  }

  if (isPlainObject(questions.fit) && questions.fit.type !== 'noul') problems.push('questions.fit must be a noul question');
  if (isPlainObject(questions.verdict)) {
    if (questions.verdict.type !== 'choice') problems.push('questions.verdict must be a choice question');
    else if (isPlainObject(questions.verdict.criteria)) {
      for (const label of ['apply', 'maybe', 'skip']) {
        if (!(label in questions.verdict.criteria)) problems.push(`questions.verdict.criteria is missing "${label}"`);
      }
    }
  }

  const labelsOf = (key) => (isPlainObject(questions[key]) && isPlainObject(questions[key].criteria)
    ? Object.keys(questions[key].criteria) : null);

  if (obj.reason_questions !== undefined) {
    if (!Array.isArray(obj.reason_questions) || obj.reason_questions.length === 0) {
      problems.push('reason_questions must be a non-empty list of question keys');
    } else {
      for (const key of obj.reason_questions) {
        if (typeof key !== 'string' || !isPlainObject(questions[key])) problems.push(`reason_questions names unknown question "${key}"`);
        else if (questions[key].type !== 'choice') problems.push(`reason_questions names "${key}", which is not a choice question`);
      }
    }
  }

  if (obj.blocking_answers !== undefined) {
    if (!isPlainObject(obj.blocking_answers)) {
      problems.push('blocking_answers must be a mapping of question key to labels');
    } else {
      for (const [key, labels] of Object.entries(obj.blocking_answers)) {
        const known = labelsOf(key);
        if (!known) { problems.push(`blocking_answers.${key} is not a choice question`); continue; }
        if (!Array.isArray(labels)) { problems.push(`blocking_answers.${key} must be a list of labels`); continue; }
        for (const label of labels) {
          if (!known.includes(String(label))) problems.push(`blocking_answers.${key} lists "${label}", which is not one of ${known.join(', ')}`);
        }
      }
    }
  }

  return problems;
}

/**
 * YAML keys like `yes`/`no` arrive as booleans from js-yaml; the choice
 * labels are strings. Normalise the criteria map so labels are always strings.
 */
function stringKeyed(map) {
  const out = {};
  for (const [k, v] of Object.entries(map)) out[String(k)] = v;
  return out;
}

function normaliseQuestions(questions) {
  const out = {};
  for (const key of QUESTION_KEYS) {
    const q = questions[key];
    const entry = { type: q.type, instructions: String(q.instructions).trim() };
    if (q.type === 'choice') entry.criteria = stringKeyed(q.criteria);
    out[key] = entry;
  }
  return out;
}

function normaliseBlocking(blocking) {
  const out = {};
  for (const [key, labels] of Object.entries(blocking)) out[key] = labels.map(String);
  return out;
}

/**
 * Parse criteria text, throwing with every problem named when it is invalid.
 *
 * @param {string} text - YAML (or JSON, which YAML accepts).
 * @param {string} [source] - Where the text came from, for messages.
 */
export function parseCriteria(text, source = 'criteria') {
  let raw;
  try {
    raw = loadYaml(text);
  } catch (err) {
    throw new Error(`${source}: ${err?.message ?? err}`);
  }
  const problems = validateCriteria(raw);
  if (problems.length) throw new Error(`${source}: ${problems.join('; ')}`);
  return {
    preamble: String(raw.preamble).trim(),
    questions: normaliseQuestions(raw.questions),
    reasonQuestions: Array.isArray(raw.reason_questions) ? raw.reason_questions.map(String) : [...REASON_QUESTIONS],
    blockingAnswers: isPlainObject(raw.blocking_answers) ? normaliseBlocking(raw.blocking_answers) : { ...BLOCKING_ANSWERS },
    maxDescriptionChars: raw.max_description_chars ?? DEFAULT_MAX_DESCRIPTION_CHARS,
    source,
  };
}

/**
 * Where the criteria would be read from, in order: an explicit path, the data
 * root's `config/jev-criteria.yml`, the checkout's example.
 *
 * @param {{ dataRoot?: string, codeRoot?: string, path?: string }} opts
 * @returns {string}
 */
export function resolveCriteriaPath({ dataRoot, codeRoot = CODE_ROOT, path } = {}) {
  if (path) return path;
  if (dataRoot) {
    const user = join(dataRoot, USER_RELATIVE_PATH);
    if (existsSync(user)) return user;
  }
  return join(codeRoot, EXAMPLE_RELATIVE_PATH);
}

/**
 * Load the criteria.
 *
 * @param {{ dataRoot?: string, codeRoot?: string, path?: string }} [opts]
 * @returns {{ preamble: string, questions: object, reasonQuestions: string[], blockingAnswers: Record<string, string[]>, maxDescriptionChars: number, source: string }}
 */
export function loadCriteria(opts = {}) {
  const source = resolveCriteriaPath(opts);
  if (!existsSync(source)) throw new Error(`criteria file not found: ${source}`);
  return parseCriteria(readFileSync(source, 'utf-8'), source);
}
