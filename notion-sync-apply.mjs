#!/usr/bin/env node
/**
 * notion-sync-apply.mjs — the local writer behind the `notion-sync` mode.
 *
 * The mode (modes/notion-sync.md) reads the candidate's Notion career records
 * through the session's Notion connector and turns them into one proposal
 * JSON. This script is the only thing that touches the data root: it shows a
 * unified diff per target file (`--dry-run`, the default) and writes only on
 * `--apply`, after the user said yes. It never reads Notion and never writes
 * to it.
 *
 * Proposal keys (every one optional; an absent key leaves its target alone):
 *
 *   context_md            full text of modes/_context.md
 *   preferences           the `preferences` block of config/profile.yml
 *   interests             the `interests` block of config/profile.yml
 *   article_digest_md     full text of article-digest.md
 *   cv_facts              { allow_metrics, allow_facts, forbidden_phrases }: lists
 *                         merged into config/cv-facts.json (union, sorted); other
 *                         keys of that file are preserved
 *   career_profile_facts  facts appended to data/career-profile.yml, each
 *                         { section, id, text, evidence: { source, line, quote } }
 *                         for summary | skills | certifications, or
 *                         { section, id, label, evidence, facts: [...] } for
 *                         experiences | projects | education. Every appended
 *                         fact carries review_status `needs_review` (the schema
 *                         in lib/career-profile.mjs has no `proposed` status;
 *                         `needs_review` is its proposed-not-yet-verified state)
 *
 * config/profile.yml is edited by replacing the text of the two blocks, never
 * by re-serialising the file: every other key, comment and blank line stays
 * byte-identical.
 *
 * Usage:
 *   node notion-sync-apply.mjs --proposal <file> [--dry-run|--apply] [--data-root <dir>]
 *
 * Exit codes:
 *   0  diff printed (dry run) or files written (apply)
 *   1  usage error, unreadable proposal, or an invalid career profile
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as yaml from 'js-yaml';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { loadYaml } from './lib/yaml-document.mjs';
import { validateProfile as validateCareerProfile } from './lib/career-profile.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const PROFILE_BLOCKS = ['preferences', 'interests'];
const CV_FACT_LISTS = ['allow_metrics', 'allow_facts', 'forbidden_phrases'];
const FLAT_SECTIONS = ['summary', 'skills', 'certifications'];
const ENTRY_SECTIONS = ['experiences', 'projects', 'education'];

// ── diff ───────────────────────────────────────────────────────────────────

/**
 * Line-level LCS table, the textbook O(n*m) version. Files here are a profile,
 * a context file, a digest: hundreds of lines, so the table is small. Past
 * 4M cells the diff degrades to "everything removed, everything added"
 * rather than hanging.
 */
function lcsOps(a, b) {
  if (a.length * b.length > 4_000_000) {
    return [...a.map((line) => ['-', line]), ...b.map((line) => ['+', line])];
  }
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

const splitLines = (text) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

/**
 * A unified-style diff with three lines of context, or '' when the texts are
 * equal. `before` null means the file does not exist yet.
 *
 * @param {string|null} before
 * @param {string} after
 * @param {string} path - Repo-relative path, for the header.
 * @returns {string}
 */
export function unifiedDiff(before, after, path, context = 3) {
  if (before === after) return '';
  const a = splitLines(before ?? '');
  const b = splitLines(after);
  const ops = lcsOps(a, b);
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op[0] === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true;
  });
  const out = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`];
  let oldLine = 1;
  let newLine = 1;
  let idx = 0;
  while (idx < ops.length) {
    if (!keep[idx]) {
      if (ops[idx][0] !== '+') oldLine++;
      if (ops[idx][0] !== '-') newLine++;
      idx++;
      continue;
    }
    let end = idx;
    while (end < ops.length && keep[end]) end++;
    const hunk = ops.slice(idx, end);
    const oldCount = hunk.filter((op) => op[0] !== '+').length;
    const newCount = hunk.filter((op) => op[0] !== '-').length;
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    for (const [kind, line] of hunk) {
      out.push(`${kind}${line}`);
      if (kind !== '+') oldLine++;
      if (kind !== '-') newLine++;
    }
    idx = end;
  }
  return `${out.join('\n')}\n`;
}

// ── config/profile.yml: block replacement, never re-serialisation ──────────

/**
 * The [start, end) line range of a top-level block: its `key:` line plus every
 * following line that is indented or blank, trimmed of trailing blank lines
 * so the spacing around the block is left to the file.
 */
function blockRange(lines, key) {
  const start = lines.findIndex((line) => line.startsWith(`${key}:`) && /^[a-z0-9_]+:(\s|$)/.test(line));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end++;
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  return [start, end];
}

function dumpBlock(key, value) {
  return yaml.dump({ [key]: value }, { lineWidth: -1, noRefs: true }).replace(/\n$/, '');
}

/**
 * Replace (or append) the `preferences` and `interests` blocks in the text of
 * config/profile.yml. Keys, comments and blank lines outside those blocks are
 * returned byte for byte.
 *
 * @param {string} profileText
 * @param {{preferences?: object, interests?: object}} blocks
 * @returns {string}
 */
export function mergeProfileBlocks(profileText, blocks) {
  let text = String(profileText ?? '');
  for (const key of PROFILE_BLOCKS) {
    const value = blocks?.[key];
    if (value === undefined) continue;
    const rendered = dumpBlock(key, value);
    const lines = text.split('\n');
    const range = blockRange(lines, key);
    if (range) {
      lines.splice(range[0], range[1] - range[0], ...rendered.split('\n'));
      text = lines.join('\n');
    } else {
      const body = text.replace(/\n*$/, '');
      text = body ? `${body}\n\n${rendered}\n` : `${rendered}\n`;
    }
  }
  if (text && !text.endsWith('\n')) text += '\n';
  return text;
}

// ── config/cv-facts.json: union, sorted ────────────────────────────────────

const unique = (items) => [...new Set(items.map((s) => String(s ?? '').trim()).filter(Boolean))].sort();

/**
 * @param {object|null} existing - Parsed cv-facts.json, or null when absent.
 * @param {object} proposed - { allow_metrics?, allow_facts?, forbidden_phrases? }
 * @returns {object}
 */
export function mergeCvFacts(existing, proposed) {
  const out = existing && typeof existing === 'object' ? { ...existing } : {};
  for (const key of ['allow_metrics', 'allow_facts', 'forbidden_phrases', 'warn_phrases']) {
    if (!Array.isArray(out[key])) out[key] = [];
  }
  for (const key of CV_FACT_LISTS) {
    const add = Array.isArray(proposed?.[key]) ? proposed[key] : [];
    out[key] = unique([...out[key], ...add]);
  }
  return out;
}

// ── data/career-profile.yml: append through the schema ─────────────────────

const EMPTY_CAREER_PROFILE = () => ({
  schema_version: 1, candidate: {}, summary: [], experiences: [], projects: [], education: [], certifications: [], skills: [],
});

const factOf = (fact) => ({
  id: String(fact.id ?? '').trim(),
  text: String(fact.text ?? '').trim(),
  evidence: { source: String(fact.evidence?.source ?? ''), line: fact.evidence?.line, quote: String(fact.evidence?.quote ?? '') },
  review_status: 'needs_review',
});

function knownIds(profile) {
  const ids = new Set();
  for (const key of FLAT_SECTIONS) for (const f of profile[key] ?? []) ids.add(f?.id);
  for (const key of ENTRY_SECTIONS) {
    for (const entry of profile[key] ?? []) {
      ids.add(entry?.id);
      for (const f of entry?.facts ?? []) ids.add(f?.id);
    }
  }
  return ids;
}

/**
 * Append proposed facts to a career profile. A fact whose id is already there
 * is skipped, so the same proposal applied twice adds nothing. The result is
 * validated against lib/career-profile.mjs before it is returned.
 *
 * @param {object|null} existing - Parsed data/career-profile.yml, or null when absent.
 * @param {object[]} proposed - See the file header.
 * @returns {object}
 */
export function mergeCareerProfile(existing, proposed) {
  const profile = existing && typeof existing === 'object' ? structuredClone(existing) : EMPTY_CAREER_PROFILE();
  for (const key of [...FLAT_SECTIONS, ...ENTRY_SECTIONS]) if (!Array.isArray(profile[key])) profile[key] = [];
  const ids = knownIds(profile);
  for (const item of Array.isArray(proposed) ? proposed : []) {
    const section = String(item?.section ?? '');
    if (FLAT_SECTIONS.includes(section)) {
      const fact = factOf(item);
      if (ids.has(fact.id)) continue;
      profile[section].push(fact);
      ids.add(fact.id);
    } else if (ENTRY_SECTIONS.includes(section)) {
      const label = String(item?.label ?? '').trim();
      let entry = profile[section].find((e) => e?.id === item?.id || (label && e?.label === label));
      if (!entry) {
        entry = { ...factOf(item), label, facts: [] };
        delete entry.text;
        profile[section].push(entry);
        ids.add(entry.id);
      }
      if (!Array.isArray(entry.facts)) entry.facts = [];
      for (const raw of Array.isArray(item?.facts) ? item.facts : []) {
        const fact = factOf(raw);
        if (ids.has(fact.id)) continue;
        entry.facts.push(fact);
        ids.add(fact.id);
      }
    } else {
      throw new Error(`career_profile_facts: unknown section "${section}" (use ${[...FLAT_SECTIONS, ...ENTRY_SECTIONS].join(', ')})`);
    }
  }
  const errors = validateCareerProfile(profile);
  if (errors.length) throw new Error(`career profile would be invalid after the merge:\n- ${errors.join('\n- ')}`);
  return profile;
}

// ── the plan ───────────────────────────────────────────────────────────────

const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf-8') : null);
const withNewline = (text) => (text.endsWith('\n') ? text : `${text}\n`);

/**
 * What `--apply` would write, one entry per target the proposal names.
 *
 * @param {object} proposal
 * @param {{dataRoot?: string}} [opts]
 * @returns {Array<{path: string, before: string|null, after: string, changed: boolean}>}
 */
export function planWrites(proposal, { dataRoot = getCareerOpsRoot() } = {}) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const plan = [];
  const add = (path, after) => {
    const before = readText(join(dataRoot, ...path.split('/')));
    plan.push({ path, before, after, changed: before !== after });
  };

  if (typeof p.context_md === 'string') add('modes/_context.md', withNewline(p.context_md));

  if (PROFILE_BLOCKS.some((key) => p[key] !== undefined)) {
    const before = readText(join(dataRoot, 'config', 'profile.yml'));
    const after = mergeProfileBlocks(before ?? '', { preferences: p.preferences, interests: p.interests });
    plan.push({ path: 'config/profile.yml', before, after, changed: before !== after });
  }

  if (typeof p.article_digest_md === 'string') add('article-digest.md', withNewline(p.article_digest_md));

  if (p.cv_facts && typeof p.cv_facts === 'object') {
    const path = join(dataRoot, 'config', 'cv-facts.json');
    const before = readText(path);
    let existing = null;
    if (before !== null) {
      try { existing = JSON.parse(before); } catch (err) { throw new Error(`config/cv-facts.json is not valid JSON: ${err.message}`); }
    }
    const after = `${JSON.stringify(mergeCvFacts(existing, p.cv_facts), null, 2)}\n`;
    plan.push({ path: 'config/cv-facts.json', before, after, changed: before !== after });
  }

  if (Array.isArray(p.career_profile_facts)) {
    const path = join(dataRoot, 'data', 'career-profile.yml');
    const before = readText(path);
    const existing = before === null ? null : loadYaml(before);
    if (before !== null) {
      const errors = validateCareerProfile(existing);
      if (errors.length) throw new Error(`data/career-profile.yml is invalid before the merge; fix it first:\n- ${errors.join('\n- ')}`);
    }
    const merged = mergeCareerProfile(existing, p.career_profile_facts);
    const after = yaml.dump(merged, { noRefs: true, lineWidth: 100 });
    plan.push({ path: 'data/career-profile.yml', before, after, changed: before !== after });
  }

  return plan;
}

/**
 * Write every changed entry of a plan atomically (temp file, then rename).
 * @returns {{written: string[], unchanged: string[]}}
 */
export function applyWrites(plan, { dataRoot = getCareerOpsRoot() } = {}) {
  const written = [];
  const unchanged = [];
  for (const entry of plan) {
    if (!entry.changed) { unchanged.push(entry.path); continue; }
    const target = join(dataRoot, ...entry.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, entry.after, 'utf-8');
    renameSync(tmp, target);
    written.push(entry.path);
  }
  return { written, unchanged };
}

// ── CLI ────────────────────────────────────────────────────────────────────

const USAGE = `Usage: node notion-sync-apply.mjs --proposal <file> [--dry-run|--apply] [--data-root <dir>]

Turns a notion-sync proposal JSON into modes/_context.md, the preferences and
interests blocks of config/profile.yml, article-digest.md, config/cv-facts.json
and data/career-profile.yml under the data root. --dry-run (the default) prints
a unified diff per file and writes nothing; --apply writes the changed files.
Never reads or writes Notion.`;

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, ['--proposal', '--dry-run', '--apply', '--data-root', '--help', '-h'], USAGE, {
    valueFlags: ['--proposal', '--data-root'],
    requireOperand: true,
  });
  const proposalPath = flagValue(args, '--proposal');
  if (!proposalPath) {
    console.error('Error: --proposal <file> is required');
    console.error(USAGE);
    process.exit(1);
  }
  const apply = hasFlag(args, '--apply');
  if (apply && hasFlag(args, '--dry-run')) {
    console.error('Error: --dry-run and --apply exclude each other');
    process.exit(1);
  }
  if (!existsSync(proposalPath)) {
    console.error(`Error: no proposal at ${proposalPath}`);
    process.exit(1);
  }
  let proposal;
  try {
    proposal = JSON.parse(readFileSync(proposalPath, 'utf-8'));
  } catch (err) {
    console.error(`Error: ${proposalPath} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    console.error('Error: the proposal must be a JSON object');
    process.exit(1);
  }
  const known = ['context_md', 'preferences', 'interests', 'article_digest_md', 'cv_facts', 'career_profile_facts'];
  for (const key of Object.keys(proposal)) {
    if (!known.includes(key)) console.error(`Warning: unknown proposal key "${key}" is ignored (known: ${known.join(', ')})`);
  }
  const dataRoot = flagValue(args, '--data-root') ?? getCareerOpsRoot();

  let plan;
  try {
    plan = planWrites(proposal, { dataRoot });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  if (plan.length === 0) {
    console.log('The proposal names no target; nothing to do.');
    process.exit(0);
  }

  console.log(`Data root: ${dataRoot}\n`);
  for (const entry of plan) {
    const state = entry.before === null ? 'new' : entry.changed ? 'modified' : 'unchanged';
    console.log(`=== ${entry.path} (${state})`);
    const diff = unifiedDiff(entry.before, entry.after, entry.path);
    console.log(diff ? diff : '(no change)\n');
  }

  if (!apply) {
    console.log(`dry run: nothing written. ${plan.filter((e) => e.changed).length} of ${plan.length} target(s) would change; rerun with --apply after reviewing the diff.`);
    process.exit(0);
  }
  const { written, unchanged } = applyWrites(plan, { dataRoot });
  console.log(`written: ${written.length ? written.join(', ') : 'none'}`);
  console.log(`unchanged: ${unchanged.length ? unchanged.join(', ') : 'none'}`);
}
