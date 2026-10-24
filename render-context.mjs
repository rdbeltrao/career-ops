#!/usr/bin/env node
/**
 * render-context.mjs — print the targeting blocks of config/profile.yml as
 * markdown: `preferences`, `interests` and the Hard DQ list built from
 * `dealbreakers` plus `preferences.hard_rules`.
 *
 * The same blocks steer the Jev pre-screen, the Dealbreaker gate in
 * modes/oferta.md and the triage brief (modes/_brief.md → Hard DQ), so this is
 * the one place that turns them into text: a mode pastes the output instead of
 * re-deriving it, and the Hard DQ list cannot drift from the gate.
 *
 * Staleness: `confirmed_on` older than STALE_DAYS (90) marks the block
 * `STALE: reconfirm before deciding`. A mode that lets preferences or
 * interests decide a verdict or a "why this role" paragraph says so and asks
 * before relying on them (modes/_shared.md → Calibrated pre-screen (Jev)).
 *
 * Usage:
 *   node render-context.mjs [--profile <path>] [--today YYYY-MM-DD] [--section preferences|interests|dq|all]
 *
 * Exit codes:
 *   0  printed
 *   1  usage error, or no profile at the resolved path
 *   2  the profile exists and does not parse
 */

import { existsSync, readFileSync } from 'node:fs';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';
import { loadYaml } from './lib/yaml-document.mjs';
import { getProfilePath } from './path-resolver.mjs';

export const STALE_DAYS = 90;
export const STALE_NOTE = 'STALE: reconfirm before deciding';
export const SECTIONS = ['preferences', 'interests', 'dq', 'all'];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** @param {unknown} value @returns {number|null} UTC midnight in ms, or null when not YYYY-MM-DD. */
function parseDay(value) {
  const m = DATE_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  // Reject 2026-02-31: Date.UTC rolls it over instead of failing.
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return ms;
}

/**
 * Whether a confirmation date is too old to rely on without asking.
 * A missing or unparseable date is stale: nothing confirms it, so the mode
 * has to ask.
 *
 * @param {unknown} dateStr - `YYYY-MM-DD`, as written in config/profile.yml.
 * @param {string} today - `YYYY-MM-DD`.
 * @param {number} [days] - The window; STALE_DAYS by default.
 * @returns {boolean}
 */
export function isStale(dateStr, today, days = STALE_DAYS) {
  const confirmed = parseDay(dateStr);
  const now = parseDay(today);
  if (confirmed === null || now === null) return true;
  return (now - confirmed) / 86_400_000 > days;
}

/** @param {unknown} v @returns {string[]} */
function toList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s ?? '').trim()).filter(Boolean);
  if (v === null || v === undefined) return [];
  const s = String(v).trim();
  return s ? [s] : [];
}

/** @param {unknown} v @returns {string} */
function text(v) {
  if (Array.isArray(v)) return toList(v).join(', ');
  return String(v ?? '').trim();
}

const PREFERENCE_GROUPS = [
  ['hard_rules', 'Hard rules'],
  ['minus', 'Minus (not a blocker)'],
  ['neutral', 'Neutral'],
  ['plus', 'Plus'],
  ['no_penalty', 'No penalty'],
];

const INTEREST_FIELDS = [
  ['role_balance', 'Role balance'],
  ['team_size', 'Team size'],
  ['team_type', 'Team type'],
  ['domains', 'Domains'],
  ['ways_of_working', 'Ways of working'],
  ['learning', 'Learning'],
];

function confirmedLabel(dateStr, today) {
  const label = dateStr ? `confirmed ${text(dateStr)}` : 'confirmed_on not set';
  return isStale(dateStr, today) ? `${label}, ${STALE_NOTE}` : label;
}

/** @param {unknown} prefs @param {string} today @returns {string} */
export function renderPreferences(prefs, today) {
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    return '## Preferences\n\n- (no preferences block in config/profile.yml)';
  }
  const lines = [`## Preferences (${confirmedLabel(prefs.confirmed_on, today)})`, ''];
  let any = false;
  for (const [key, label] of PREFERENCE_GROUPS) {
    const items = toList(prefs[key]);
    if (items.length === 0) continue;
    any = true;
    lines.push(`**${label}**`);
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  }
  if (!any) lines.push('- (empty)', '');
  return lines.join('\n').trimEnd();
}

/** @param {unknown} interests @param {string} today @returns {string} */
export function renderInterests(interests, today) {
  if (!interests || typeof interests !== 'object' || Array.isArray(interests)) {
    return '## Interests\n\n- (no interests block in config/profile.yml)';
  }
  const recorded = interests.recorded_on ? text(interests.recorded_on) : 'unknown';
  const lines = [`## Interests (recorded ${recorded}, ${confirmedLabel(interests.confirmed_on, today)})`, ''];
  let any = false;
  for (const [key, label] of INTEREST_FIELDS) {
    const value = text(interests[key]);
    if (!value) continue;
    any = true;
    lines.push(`- ${label}: ${value}`);
  }
  if (!any) lines.push('- (empty)');
  return lines.join('\n');
}

/**
 * One bullet per `dealbreakers` entry and per `preferences.hard_rules` entry,
 * de-duplicated. This is the list the triage brief and the Dealbreaker gate
 * share with the Jev pre-screen.
 *
 * @param {unknown} profile
 * @returns {string}
 */
export function renderHardDq(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const prefs = p.preferences && typeof p.preferences === 'object' ? p.preferences : {};
  const rules = [...new Set([...toList(p.dealbreakers), ...toList(prefs.hard_rules)])];
  const lines = ['## Hard DQ', ''];
  if (rules.length === 0) {
    lines.push('- (none set: add `dealbreakers` or `preferences.hard_rules` to config/profile.yml)');
  } else {
    for (const rule of rules) lines.push(`- ${rule}`);
  }
  return lines.join('\n');
}

/**
 * @param {unknown} profile - Parsed config/profile.yml.
 * @param {{today?: string, section?: string}} [opts]
 * @returns {string} Markdown, ending in one newline.
 */
export function renderContext(profile, { today = localToday(), section = 'all' } = {}) {
  if (!SECTIONS.includes(section)) throw new Error(`unknown section "${section}"; use one of ${SECTIONS.join(', ')}`);
  const p = profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {};
  const parts = [];
  if (section === 'all' || section === 'preferences') parts.push(renderPreferences(p.preferences, today));
  if (section === 'all' || section === 'interests') parts.push(renderInterests(p.interests, today));
  if (section === 'all' || section === 'dq') parts.push(renderHardDq(p));
  return `${parts.join('\n\n')}\n`;
}

const USAGE = `Usage: node render-context.mjs [--profile <path>] [--today YYYY-MM-DD] [--section preferences|interests|dq|all]

Prints the preferences, interests and Hard DQ blocks of config/profile.yml as
markdown. A confirmed_on older than ${STALE_DAYS} days is marked "${STALE_NOTE}".`;

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, ['--profile', '--today', '--section', '--help', '-h'], USAGE, {
    valueFlags: ['--profile', '--today', '--section'],
    requireOperand: true,
  });
  const section = flagValue(args, '--section') ?? 'all';
  if (!SECTIONS.includes(section)) {
    console.error(`Error: --section must be one of ${SECTIONS.join(', ')} (got "${section}")`);
    process.exit(1);
  }
  const today = flagValue(args, '--today') ?? localToday();
  if (parseDay(today) === null) {
    console.error(`Error: --today must be YYYY-MM-DD (got "${today}")`);
    process.exit(1);
  }
  const profilePath = flagValue(args, '--profile') ?? getProfilePath();
  if (!existsSync(profilePath)) {
    console.error(`render-context: no profile at ${profilePath}`);
    process.exit(1);
  }
  let profile;
  try {
    profile = loadYaml(readFileSync(profilePath, 'utf-8'));
  } catch (err) {
    console.error(`render-context: ${profilePath} is not valid YAML: ${String(err.message).split('\n')[0]}`);
    process.exit(2);
  }
  process.stdout.write(renderContext(profile, { today, section }));
}
