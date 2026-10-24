// Provider registry — loading and routing shared by the scanner and the portal
// health check. Files prefixed with _ are never loaded as providers by scan.mjs,
// so this helper module lives safely alongside the provider plugins.
//
// Extracted from scan.mjs (#1451-era inline definitions) so verify-portals.mjs
// can route non-ATS boards through the SAME provider layer the scanner uses,
// without importing scan.mjs itself (which has top-level side effects and would
// form an import cycle via classifyFetchError).

import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

// Fork-local providers (rdbeltrao/career-ops). Upstream refuses some sources by
// design (LinkedIn scraping), so a fork keeps those modules in providers.local/
// next to the shipped providers/ and never offers them upstream. The ids below
// are the optional modules a fork may supply there: a portals.yml entry naming
// one while the file is missing is a feature that is off, reported once as a
// skip, not an unknown-provider error. Loaded by loadLocalProviders().
export const LOCAL_PROVIDERS_DIRNAME = 'providers.local';
export const LOCAL_PROVIDER_IDS = new Set(['linkedin-browser']);

/**
 * Load every provider plugin in a directory into an id→provider Map.
 *
 * Alphabetical order so detect() priority is deterministic across machines.
 * Malformed modules (wrong shape, duplicate id, import error) are logged and
 * skipped, never fatal.
 *
 * @param {string} dir - Absolute path to the providers directory.
 * @returns {Promise<Map<string, object>>}
 */
export async function loadProviders(dir) {
  const providers = new Map();
  if (!existsSync(dir)) return providers;
  const entries = readdirSync(dir)
    .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
    .sort();
  for (const file of entries) {
    const full = path.join(dir, file);
    let mod;
    try {
      mod = await import(pathToFileURL(full).href);
    } catch (err) {
      console.error(`⚠️  ${file}: failed to load — ${err.message}`);
      continue;
    }
    const p = mod.default;
    if (!p || typeof p.fetch !== 'function' || !p.id) {
      console.error(`⚠️  ${file}: skipping — default export must be { id, fetch }`);
      continue;
    }
    if (providers.has(p.id)) {
      console.error(`⚠️  ${file}: duplicate provider id "${p.id}" — keeping first`);
      continue;
    }
    providers.set(p.id, p);
  }
  return providers;
}

/**
 * Merge a fork's own providers from `providers.local/` into the shipped set.
 *
 * The directory is optional: when it is absent the map comes back untouched
 * and nothing is printed. Each module is loaded by loadProviders() with the
 * same forgiveness (a broken module is a warning, never a crash); a local id
 * that collides with a shipped provider is skipped with a warning and the
 * shipped one stays, so a fork cannot silently shadow an upstream provider.
 *
 * @param {string} dir - Absolute path to the providers.local directory.
 * @param {Map<string, object>} providers - The map from loadProviders(), mutated.
 * @returns {Promise<Map<string, object>>} The same map.
 */
export async function loadLocalProviders(dir, providers) {
  if (!existsSync(dir)) return providers;
  const local = await loadProviders(dir);
  for (const [id, p] of local) {
    if (providers.has(id)) {
      console.error(`⚠️  ${LOCAL_PROVIDERS_DIRNAME}/${id}.mjs: id "${id}" is already a shipped provider — keeping the shipped one`);
      continue;
    }
    providers.set(id, p);
  }
  return providers;
}

/**
 * Resolve which provider handles a portals.yml entry (tracked_companies or job_boards).
 *   1. Explicit `provider:` field wins (skips detect()).
 *   2. local-parser when parser.command + script are configured (before API detect).
 *   3. Otherwise each provider's detect() runs in load order; first hit wins.
 *
 * @param {object} entry - portals.yml entry (tracked_companies or job_boards).
 * @param {Map<string, object>} providers - id→provider Map from loadProviders().
 * @param {{skipIds?: string[]}} [opts] - Provider ids to skip (e.g. 'local-parser'
 *   so a network-only health check never execs a configured local command). A
 *   skipped id is skipped however the entry reached it: an explicit `provider:`
 *   naming one resolves as if the field were absent, the same way the same
 *   entry resolves when it relies on detect().
 * @returns {{provider: object}|{error: string}|{skipped: string}|null} `skipped`
 *   names a fork-local provider (LOCAL_PROVIDER_IDS) whose module is not on
 *   disk: the caller skips the entry and says so once, as it would for an
 *   entry no provider claims.
 */
export function resolveProvider(entry, providers, { skipIds = [] } = {}) {
  if (entry.provider && !skipIds.includes(entry.provider)) {
    const p = providers.get(entry.provider);
    if (!p) {
      if (LOCAL_PROVIDER_IDS.has(entry.provider)) {
        return { skipped: `provider "${entry.provider}" is fork-local and ${LOCAL_PROVIDERS_DIRNAME}/${entry.provider}.mjs is not installed` };
      }
      return { error: `unknown provider: ${entry.provider}` };
    }
    return { provider: p };
  }

  const localParser = providers.get('local-parser');
  if (localParser && !skipIds.includes('local-parser')) {
    try {
      const hit = localParser.detect?.(entry);
      if (hit) return { provider: localParser };
    } catch (err) {
      console.error(`⚠️  local-parser: detect() threw for "${entry.name}" — ${err.message}`);
    }
  }

  for (const p of providers.values()) {
    if (skipIds.includes(p.id)) continue;
    let hit;
    try {
      hit = p.detect?.(entry);
    } catch (err) {
      console.error(`⚠️  ${p.id}: detect() threw for "${entry.name}" — ${err.message}`);
      continue;
    }
    if (hit) return { provider: p };
  }
  return null;
}
