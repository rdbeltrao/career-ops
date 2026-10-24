/**
 * context-evidence.mjs — the candidate context as the evaluation may see it.
 *
 * modes/_context.md is the context tier of the Source-of-Truth Boundary
 * (AGENTS.md): its qualitative facts are evidence for the evaluation, its
 * numbers are not, because the file is mirrored from career notes whose
 * figures Claims to Confirm has not all resolved. A prompt rule asked the
 * model not to repeat those figures; models kept naming team sizes anyway.
 * So the figures never reach the model: every loader that feeds the context
 * to an evaluator reads it through readMaskedContext(), which replaces each
 * quantity with `[n]`. Any figure the report still shows therefore came from
 * cv.md or article-digest.md, where the fact gate can check it.
 *
 * What is masked: integers, decimals, thousands-separated numbers, percentages,
 * currency amounts, magnitude suffixes (k, M, million, billion), multipliers
 * (2.6x), ranges (6-10, 6 to 10), approximate forms (~20, about 20), ordinals
 * (1st) and the number words one to twenty, the tens, hundred, thousand,
 * million, billion and dozen.
 *
 * What is kept, because timelines and staleness depend on it or because it is
 * a name rather than a quantity: ISO dates (2026-10-17), YYYY-MM, MM/YYYY and
 * D/M/YYYY dates, four-digit years 1900-2099, times of day (14:30), ratios
 * (1:1), alphanumeric identifiers (p50, EX-01, S3, B2B, Q4, OAuth2), version
 * numbers after a product name (Symfony 6.4, Vue 3) or with a v prefix
 * (v1.2), and the phrases "one of", "one another", "one-on-one" and
 * "no one".
 *
 * Jev (`node jev-score.mjs`) keeps reading the raw file: it only scores and
 * never writes prose, so a figure there steers a probability and nothing else.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MASK = '[n]';
export const CONTEXT_RELATIVE_PATH = 'modes/_context.md';
export const MASKED_NOTICE = 'Numbers in this context are masked as [n]: a figure that exists only in modes/_context.md is not evidence, and every figure you still see came from cv.md or article-digest.md.';

const NUMBER_WORDS = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
  'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundred', 'thousand', 'million', 'billion', 'dozen',
];

// Protected spans are swapped for private-use sentinels before masking and
// swapped back afterwards, so a later pattern cannot eat part of a date.
const PROTECT = [
  /\b\d{4}-\d{2}-\d{2}\b/g,                              // 2026-10-17
  /\b\d{4}-\d{2}\b/g,                                    // 2026-10
  /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,                        // 17/10/2026
  /\b\d{1,2}\/\d{4}\b/g,                                 // 04/2023
  /\b(?:19|20)\d{2}\b/g,                                 // 2023
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,                       // 14:30
  /\b\d+:\d+s?\b/g,                                      // 1:1, 1:1s
  /\b24\/7\b/g,
  /\bv\d+(?:\.\d+)+\b/gi,                                // v1.2.3
  // A version after a product name (Symfony 6.4, Vue 3). The names are listed
  // because "EUR 2" and "Team 5" have the same shape and are quantities.
  /\b(?:Vue|Angular|React|Next|Nuxt|Svelte|Ember|Node|Deno|Bun|PHP|Laravel|Symfony|Zend|Rails|Ruby|Django|Flask|Python|Java|Spring|Kotlin|Swift|Scala|Go|Rust|Elixir|Phoenix|Flutter|Dart|Unity|Unreal|iOS|Android|Windows|macOS|Ubuntu|Debian|HTTP|TLS|SSL|GPT|Claude|Gemini|Llama|Mistral|Postgres|PostgreSQL|MySQL|MariaDB|Redis|Kafka|Elasticsearch|Typesense|Terraform|Kubernetes|Docker|Drupal|WordPress|Magento|Shopware|Webpack|Vite|Babel|ES|ECMAScript|Bootstrap|Tailwind|jQuery|Vuex|Pinia|Nest|Express|Fastify|Expo|Xcode)(?:\.js)?\s\d+(?:\.\d+)*\b/gi,
  /\b[A-Za-z]+\d+(?:[A-Za-z0-9-]*[A-Za-z0-9])?\b/g,        // p50, S3, B2B, Q4, OAuth2
  /\b[A-Z]+[-_]\d+\b/g,                                    // EX-01 (upper-case code; "sub-200" is a quantity)
  /\bone[- ]on[- ]one\b/gi,
  /\bone[- ]to[- ]one\b/gi,
  /\bone another\b/gi,
  /\bone of\b/gi,
  /\bno one\b/gi,
];

const CURRENCY = /(€|\$|£|¥|R\$|\b(?:EUR|USD|GBP|BRL|CHF|CAD|AUD|JPY|CNY|INR)\b)\s?\d[\d,.]*(?:\s?[-–]\s?\d[\d,.]*)?\s?(?:k|K|M|bn|mio|mil|million|billion|thousand)?\b/g;
const MAGNITUDE = /\b~?\d[\d,.]*\s?(?:k|K|M|bn|mio|million|billion|thousand)\b/g;
const PERCENT = /~?\d[\d,.]*\s?%/g;
const RANGE = /~?\d[\d,.]*\s?[-–]\s?\d[\d,.]*(?:k|K|M|bn)?\b/g;
const MULTIPLIER = /\b~?\d[\d,.]*x\b/g;
const ORDINAL = /\b\d+(?:st|nd|rd|th)\b/g;
const NUMBER = /~?\b\d[\d,]*(?:\.\d+)?\b/g;
const WORDS = new RegExp(`\\b(?:${NUMBER_WORDS.join('|')})\\b`, 'gi');

/**
 * Replace every quantity in a context text with MASK, keeping dates, years,
 * identifiers and version numbers. Pure; the same input gives the same output.
 *
 * @param {string} text
 * @returns {string}
 */
export function maskContextNumbers(text) {
  if (typeof text !== 'string' || text === '') return text ?? '';
  // The sentinel index is spelt in private-use characters, one per decimal
  // digit, so no later pattern (digits, number words) can touch it.
  const kept = [];
  const encode = (i) => `\uE000${String(i).replace(/\d/g, (d) => String.fromCharCode(0xE010 + Number(d)))}\uE001`;
  const decode = (s) => Number(s.replace(/[\uE010-\uE019]/g, (c) => String(c.charCodeAt(0) - 0xE010)));
  let out = text;
  for (const pattern of PROTECT) {
    out = out.replace(pattern, (m) => {
      kept.push(m);
      return encode(kept.length - 1);
    });
  }
  out = out
    .replace(CURRENCY, (m, unit) => `${unit} ${MASK}`)
    .replace(PERCENT, (m) => `${MASK}%`)
    .replace(RANGE, MASK)
    .replace(MAGNITUDE, MASK)
    .replace(MULTIPLIER, `${MASK}x`)
    .replace(ORDINAL, MASK)
    .replace(NUMBER, MASK)
    .replace(WORDS, MASK);
  return out.replace(/\uE000([\uE010-\uE019]+)\uE001/g, (m, i) => kept[decode(i)]);
}

/**
 * Read modes/_context.md under a data root, masked. Returns null when the
 * file is absent, so a caller can keep its "evaluating on cv.md and
 * profile.yml only" notice.
 *
 * @param {string} dataRoot
 * @param {{raw?: boolean}} [opts] raw: true returns the file as written (Jev's view)
 * @returns {{path: string, text: string, masked: boolean} | null}
 */
export function readMaskedContext(dataRoot, { raw = false } = {}) {
  const path = join(dataRoot, 'modes', '_context.md');
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf-8').replace(/^﻿/, '').trim();
  return { path, text: raw ? text : maskContextNumbers(text), masked: !raw };
}
