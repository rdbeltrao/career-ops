/**
 * jd-store.mjs — the feeder's JD store and its index (contract C6).
 *
 * The job-hunt feeder (`python -m jobs pipeline --data-root ...`) writes a
 * pipeline row per new opening and, next to it, the full job object it
 * fetched, so `jev-rank.mjs` can score the row without opening the posting
 * again. This module is the Node side of that contract: the same file layout,
 * readable by both and writable by both (a later Node port of the feeder, and
 * tests).
 *
 *   {DATA_ROOT}/jds/feeder/{source}-{source_id}.json   the job object of
 *       jev-score.mjs's --job plus `source`, `source_id`, `first_seen`,
 *       `search_name`
 *   {DATA_ROOT}/data/jd-index.tsv                       `url\tpath\tsource\t
 *       source_id\tfirst_seen`, `path` relative to the data root, append-only,
 *       one row per URL
 *
 * Reads match the URL exactly first, then with a trailing slash added or
 * removed; nothing else is normalised, because the index is what the feeder
 * wrote and a looser match would hide a duplicate row instead of showing it.
 * Everything here is user-layer data under the data root, never the checkout.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { localToday } from './local-today.mjs';

export const INDEX_RELATIVE_PATH = join('data', 'jd-index.tsv');
export const FEEDER_DIR = join('jds', 'feeder');
export const INDEX_HEADER = 'url\tpath\tsource\tsource_id\tfirst_seen';

const asText = (v) => (v == null ? '' : String(v));

/** A TSV cell: tabs and line breaks become one space. */
const cell = (v) => asText(v).replace(/[\t\r\n]+/g, ' ').trim();

/**
 * A filename piece: anything that is not a letter, digit, `.`, `_` or `-`
 * becomes `-`, and a piece that is only dots (`..`) becomes `_`, so a crafted
 * `source_id` cannot leave `jds/feeder/`. The feeder's ids (alphanumeric, `-`,
 * `_`) pass through unchanged, which is what keeps both writers on one path.
 */
function filePiece(value, name) {
  const raw = asText(value).trim();
  if (!raw) throw new Error(`jd-store: job has no ${name}`);
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|-+$/g, '');
  return safe === '' ? '_' : safe;
}

/**
 * `jds/feeder/{source}-{source_id}.json`, always with forward slashes so the
 * index row reads the same on every platform.
 */
export function jdRelativePath(job) {
  return `${FEEDER_DIR.split(sep).join('/')}/${filePiece(job?.source, 'source')}-${filePiece(job?.source_id, 'source_id')}.json`;
}

function indexPath(dataRoot) {
  return join(dataRoot, INDEX_RELATIVE_PATH);
}

/**
 * The index as a map keyed by the URL exactly as written. A malformed line is
 * skipped; a missing file is an empty map.
 *
 * @param {string} dataRoot
 * @returns {Map<string, { url: string, path: string, source: string, source_id: string, first_seen: string }>}
 */
export function readIndex(dataRoot) {
  const out = new Map();
  const path = indexPath(dataRoot);
  if (!existsSync(path)) return out;
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line === INDEX_HEADER) continue;
    const parts = line.split('\t');
    if (parts.length < 5) continue;
    const [url, relPath, source, sourceId, firstSeen] = parts.map((p) => p.trim());
    if (!url || !relPath || out.has(url)) continue;
    out.set(url, { url, path: relPath, source, source_id: sourceId, first_seen: firstSeen });
  }
  return out;
}

/** The index row for a URL: exact, then with a trailing slash toggled. */
function findRow(index, url) {
  const exact = index.get(url);
  if (exact) return exact;
  const toggled = url.endsWith('/') ? url.replace(/\/+$/, '') : `${url}/`;
  return index.get(toggled) ?? null;
}

/**
 * True when `candidate` stays inside `root` after resolution. `relative()`
 * answers with a `..` prefix for a path outside the root, and with an absolute
 * path for another Windows drive; both are refused.
 */
function insideRoot(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * The stored job object for a URL, or null when the index has no row for it,
 * the file is missing or unreadable, or its path points outside the data root.
 *
 * @param {string} url
 * @param {{ dataRoot: string }} opts
 * @returns {object|null}
 */
export function readJdForUrl(url, { dataRoot } = {}) {
  if (!dataRoot || !asText(url).trim()) return null;
  const row = findRow(readIndex(dataRoot), asText(url).trim());
  if (!row) return null;
  const file = resolve(dataRoot, row.path);
  if (!insideRoot(dataRoot, file)) return null;
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write the JD file and append its index row when the URL is new. The JSON is
 * rewritten on every call (a newer fetch wins); the index keeps its first row,
 * so a second write for the same URL reports `appended: false`.
 *
 * @param {object} job - The C1 job object plus `source` and `source_id`
 *   (`first_seen` and `search_name` optional).
 * @param {{ dataRoot: string, today?: string }} opts
 * @returns {{ path: string, appended: boolean }} `path` relative to the data root.
 */
export function writeJd(job, { dataRoot, today } = {}) {
  if (!dataRoot) throw new Error('jd-store: dataRoot is required');
  const url = asText(job?.url).trim();
  if (!url) throw new Error('jd-store: job has no url');
  const relPath = jdRelativePath(job);
  const firstSeen = asText(job.first_seen).trim() || today || localToday();
  const body = {
    ...job,
    url,
    source: asText(job.source),
    source_id: asText(job.source_id),
    first_seen: firstSeen,
    search_name: asText(job.search_name),
  };

  const file = join(dataRoot, ...relPath.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf-8');

  const index = readIndex(dataRoot);
  if (index.has(url)) return { path: relPath, appended: false };

  const path = indexPath(dataRoot);
  mkdirSync(dirname(path), { recursive: true });
  const row = [url, relPath, cell(body.source), cell(body.source_id), cell(firstSeen)].join('\t');
  if (!existsSync(path)) {
    writeFileSync(path, `${INDEX_HEADER}\n${row}\n`, 'utf-8');
  } else {
    const existing = readFileSync(path, 'utf-8');
    const prefix = existing === '' ? `${INDEX_HEADER}\n` : (existing.endsWith('\n') ? '' : '\n');
    appendFileSync(path, `${prefix}${row}\n`, 'utf-8');
  }
  return { path: relPath, appended: true };
}
