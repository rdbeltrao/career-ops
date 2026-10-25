/**
 * linkedin-searches.mjs - list, add, edit and toggle the LinkedIn searches
 * (provider: linkedin-browser) in portals.yml, for the web LinkedIn page.
 *
 * portals.yml is the user's own file, with comments and commented-out
 * companies, so every edit changes only the lines of the one entry it touches
 * (the same reason portals-config.mjs edits the filter lists as text). Each
 * edit is then checked: the new text must parse to exactly the document the
 * edit intends, or the edit returns null and nothing is written.
 *
 * Plain .mjs (js-yaml and node:util only) so `node --test` can load it.
 */
import { isDeepStrictEqual } from "node:util";
import * as yaml from "js-yaml";

export const LINKEDIN_PROVIDER = "linkedin-browser";
export const DEFAULT_MAX_PAGES = 3;

const isMapping = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isNote = (line) => line.trim() === "" || line.trim().startsWith("#");
const indentOf = (line) => line.length - line.trimStart().length;
const isTopLevelKey = (line) => /^[^\s#-]/.test(line);

/**
 * @typedef {{ name: string, searchUrl: string, maxPages: number|null, maxApplyLookups: number|null, enabled: boolean, resolveApplyUrl?: boolean }} LinkedInSearch
 */

// The crawl reads these with Number() (providers.local/linkedin-browser.mjs
// resolveMaxPages / resolveApplyLookups), so "6" counts as 6 there and here.
function crawlInt(v, min) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= min ? n : null;
}

/** @returns {LinkedInSearch[]} */
export function listLinkedInSearches(doc) {
  const list = Array.isArray(doc?.tracked_companies) ? doc.tracked_companies : [];
  return list
    .filter((c) => isMapping(c) && c.provider === LINKEDIN_PROVIDER && typeof c.name === "string")
    .map((c) => ({
      name: c.name.trim(),
      searchUrl: typeof c.search_url === "string" ? c.search_url : "",
      maxPages: crawlInt(c.max_pages, 1),
      maxApplyLookups: crawlInt(c.max_apply_lookups, 0),
      enabled: c.enabled !== false,
      resolveApplyUrl: c.resolve_apply_url !== false,
    }));
}

const POSTED = { r86400: "past 24 hours", r604800: "past week", r2592000: "past month" };
const WORKPLACE = { 1: "on-site", 2: "remote", 3: "hybrid" };

/** A LinkedIn search URL in plain words, or null when it is not a URL. */
export function describeSearchUrl(url) {
  let u;
  try {
    u = new URL(String(url ?? ""));
  } catch {
    return null;
  }
  const tpr = u.searchParams.get("f_TPR") ?? "";
  return {
    keywords: u.searchParams.get("keywords") ?? "",
    geoId: u.searchParams.get("geoId") ?? "",
    posted: POSTED[tpr] ?? (tpr ? "custom window" : "any time"),
    workplace: (u.searchParams.get("f_WT") ?? "").split(",").map((w) => WORKPLACE[w.trim()]).filter(Boolean),
  };
}

function intIn(raw, lo, hi) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? { ok: true, value: n } : { ok: false };
}

/**
 * Check and normalise a search from the form.
 * @param {{ name?: unknown, searchUrl?: unknown, maxPages?: unknown, maxApplyLookups?: unknown, enabled?: unknown }} input
 * @param {{ existingNames: string[], editing?: string }} ctx every tracked_companies name, and the name being edited
 * @returns {{ ok: true, value: LinkedInSearch & { maxPages: number } } | { ok: false, error: string }}
 */
export function validateSearch(input, { existingNames = [], editing } = {}) {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80 || /[\r\n]/.test(name)) return { ok: false, error: "The name must be one line of 1 to 80 characters." };
  const taken = existingNames.some((n) => n.trim().toLowerCase() === name.toLowerCase() && n.trim().toLowerCase() !== String(editing ?? "").trim().toLowerCase());
  if (taken) return { ok: false, error: `A portals.yml entry named "${name}" already exists.` };

  const raw = String(input?.searchUrl ?? "").trim();
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "The search URL is not a URL. Copy it from the browser's address bar on a LinkedIn job search." };
  }
  if (u.protocol !== "https:") return { ok: false, error: "The search URL must start with https://." };
  if (!/(^|\.)linkedin\.com$/.test(u.hostname)) return { ok: false, error: "The search URL must be on LinkedIn (linkedin.com)." };
  if (!/^\/jobs\/search(-results)?\/?$/.test(u.pathname)) return { ok: false, error: "That is not a LinkedIn job search URL. Run the search on LinkedIn and copy the address of the results page." };
  // A clicked result rides along in the address bar; it is not part of the
  // search. Removed from the text itself, so the rest of the URL keeps the
  // exact bytes the user pasted (URLSearchParams would rewrite %20 as +).
  const searchUrl = raw
    .replace(/([?&])currentJobId=[^&#]*&/, "$1")
    .replace(/[?&]currentJobId=[^&#]*(?=#|$)/, "");
  if (searchUrl.length > 2000) return { ok: false, error: "The search URL is too long." };

  const pages = intIn(input?.maxPages, 1, 10);
  if (!pages.ok) return { ok: false, error: "Result pages must be a whole number from 1 to 10." };
  const lookups = intIn(input?.maxApplyLookups, 0, 100);
  if (!lookups.ok) return { ok: false, error: "Employer-link lookups must be a whole number from 0 to 100." };
  if (input?.enabled !== undefined && typeof input.enabled !== "boolean") return { ok: false, error: "enabled must be true or false." };
  return { ok: true, value: { name, searchUrl, maxPages: pages.value ?? DEFAULT_MAX_PAGES, maxApplyLookups: lookups.value, enabled: input?.enabled ?? true } };
}

// ---------------------------------------------------------------- text edits

const FIELD = { name: "name", searchUrl: "search_url", maxPages: "max_pages", maxApplyLookups: "max_apply_lookups", enabled: "enabled" };
const fmt = (v) => (typeof v === "string" ? JSON.stringify(v) : String(v));

/**
 * Split what follows "key:" into its value and a trailing comment. A quoted
 * value is matched as a whole string, so a " #" inside the quotes is part of
 * the value, not a comment.
 * @returns {{ value: string, comment: string }}
 */
function splitValue(rest) {
  const quoted = /^"(?:[^"\\]|\\.)*"|^'(?:[^']|'')*'/.exec(rest);
  if (quoted) {
    const tail = rest.slice(quoted[0].length);
    return { value: quoted[0], comment: /^\s+#/.test(tail) ? tail : "" };
  }
  const hash = rest.search(/\s+#/);
  return hash < 0 ? { value: rest, comment: "" } : { value: rest.slice(0, hash), comment: rest.slice(hash) };
}

/** The tracked_companies section and its entry blocks, or null for a shape this editor does not handle. */
function sections(lines, doc) {
  const head = lines.findIndex((l) => /^tracked_companies:\s*(#.*)?$/.test(l));
  if (head < 0) return lines.some((l) => l.startsWith("tracked_companies:")) ? null : { head: -1 };
  let end = head + 1;
  while (end < lines.length && !isTopLevelKey(lines[end])) end++;
  const firstEntry = lines.findIndex((l, i) => i > head && i < end && !isNote(l) && l.trimStart().startsWith("- "));
  const entryIndent = firstEntry >= 0 ? indentOf(lines[firstEntry]) : 2;
  const blocks = [];
  for (let i = head + 1; i < end; i++) {
    const l = lines[i];
    if (isNote(l) || indentOf(l) !== entryIndent || !l.trimStart().startsWith("- ")) continue;
    let last = i;
    for (let j = i + 1; j < end; j++) {
      if (isNote(lines[j])) continue;
      if (indentOf(lines[j]) <= entryIndent) break;
      last = j;
    }
    blocks.push({ start: i, last });
  }
  const raw = doc?.tracked_companies;
  if (raw !== null && raw !== undefined && !Array.isArray(raw)) return null; // a mapping or a scalar: not a list of entries
  const list = Array.isArray(raw) ? raw : [];
  if (blocks.length !== list.length) return null;
  return { head, end, entryIndent, fieldIndent: entryIndent + 2, blocks };
}

function entryFor(search) {
  const e = { name: search.name, provider: LINKEDIN_PROVIDER, search_url: search.searchUrl, max_pages: search.maxPages ?? DEFAULT_MAX_PAGES };
  if (search.maxApplyLookups !== null && search.maxApplyLookups !== undefined) e.max_apply_lookups = search.maxApplyLookups;
  e.enabled = search.enabled !== false;
  return e;
}

function blockLines(search, entryIndent, fieldIndent) {
  const e = entryFor(search);
  const pad = " ".repeat(fieldIndent);
  // The provider id is a plain word; written bare, the way hand-written entries have it.
  const value = (k, v) => (k === "provider" ? v : fmt(v));
  return Object.entries(e).map(([k, v], i) => (i === 0 ? `${" ".repeat(entryIndent)}- ${k}: ${value(k, v)}` : `${pad}${k}: ${value(k, v)}`));
}

function verified(source, lines, expected) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const text = lines.join(eol);
  try {
    return isDeepStrictEqual(yaml.load(text), expected) ? text : null;
  } catch {
    return null;
  }
}

/**
 * portals.yml text with one LinkedIn search added after the last one (or at the
 * end of tracked_companies), or null when the file's shape is not handled.
 * @param {string} source
 * @param {LinkedInSearch} search a validateSearch() value
 */
export function addSearchText(source, search) {
  let doc;
  try {
    doc = yaml.load(source) ?? {};
  } catch {
    return null;
  }
  if (!isMapping(doc)) return null;
  const lines = source.split(/\r?\n/);
  const s = sections(lines, doc);
  if (!s) return null;
  const expected = structuredClone(doc);
  if (s.head < 0) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", "tracked_companies:", ...blockLines(search, 2, 4), "");
    expected.tracked_companies = [entryFor(search)];
    return verified(source, lines, expected);
  }
  const list = expected.tracked_companies ?? [];
  let at = -1;
  list.forEach((c, i) => {
    if (isMapping(c) && c.provider === LINKEDIN_PROVIDER) at = i;
  });
  const afterIndex = at >= 0 ? at : list.length - 1;
  const insertAfterLine = afterIndex >= 0 ? s.blocks[afterIndex].last : s.head;
  const block = blockLines(search, s.entryIndent, s.fieldIndent);
  lines.splice(insertAfterLine + 1, 0, ...(afterIndex >= 0 ? ["", ...block] : block));
  if (!Array.isArray(expected.tracked_companies)) expected.tracked_companies = [];
  expected.tracked_companies.splice(afterIndex + 1, 0, entryFor(search));
  return verified(source, lines, expected);
}

/**
 * portals.yml text with one LinkedIn search changed, or null when there is no
 * such LinkedIn search or the file's shape is not handled. `patch` keys are
 * LinkedInSearch fields; maxApplyLookups: null removes the line (the default).
 * @param {string} source
 * @param {string} name the search's current name
 * @param {Partial<LinkedInSearch>} patch
 */
export function updateSearchText(source, name, patch) {
  let doc;
  try {
    doc = yaml.load(source);
  } catch {
    return null;
  }
  if (!isMapping(doc)) return null;
  const lines = source.split(/\r?\n/);
  const s = sections(lines, doc);
  if (!s || s.head < 0) return null;
  const index = doc.tracked_companies.findIndex((c) => isMapping(c) && c.provider === LINKEDIN_PROVIDER && typeof c.name === "string" && c.name.trim() === name);
  if (index < 0) return null;
  const expected = structuredClone(doc);
  const entry = expected.tracked_companies[index];
  let { start, last } = s.blocks[index];
  const pad = " ".repeat(s.fieldIndent);

  for (const [field, value] of Object.entries(patch)) {
    const key = FIELD[field];
    if (!key || value === undefined) continue;
    const leadRe = new RegExp(`^(\\s*(?:- )?${key}:\\s*)`);
    let lineAt = -1;
    for (let i = start; i <= last; i++) {
      if (isNote(lines[i])) continue;
      const own = i === start ? lines[i].slice(s.entryIndent + 2) : lines[i].slice(s.fieldIndent);
      const sameLevel = i === start || indentOf(lines[i]) === s.fieldIndent;
      if (sameLevel && own.startsWith(`${key}:`)) {
        lineAt = i;
        break;
      }
    }
    if (value === null) {
      if (key === "name") return null;
      if (lineAt >= 0) {
        if (lineAt === start) return null;
        const lead = leadRe.exec(lines[lineAt])?.[1] ?? "";
        const { comment } = splitValue(lines[lineAt].slice(lead.length));
        // A trailing comment outlives its line, as a comment line of its own.
        if (comment.trim()) lines[lineAt] = `${pad}${comment.trim()}`;
        else {
          lines.splice(lineAt, 1);
          last -= 1;
        }
      }
      delete entry[key];
      continue;
    }
    if (lineAt >= 0) {
      const lead = leadRe.exec(lines[lineAt])?.[1];
      if (lead === undefined) return null;
      const { comment } = splitValue(lines[lineAt].slice(lead.length));
      lines[lineAt] = `${lead}${fmt(value)}${comment}`;
    } else {
      lines.splice(last + 1, 0, `${pad}${key}: ${fmt(value)}`);
      last += 1;
    }
    entry[key] = value;
  }
  return verified(source, lines, expected);
}

const SHAPE_ERROR = "portals.yml has a layout this page cannot edit safely. Edit that entry by hand, or ask the assistant.";

/**
 * One request from the LinkedIn page, as a portals.yml edit.
 *   { op: "add", search }                       a new search
 *   { op: "update", name, search }              replace one search's fields
 *   { op: "toggle", name, enabled }             switch one search on or off
 * @param {string} source portals.yml text
 * @param {unknown} body
 * @returns {{ ok: true, text: string } | { ok: false, status: number, error: string }}
 */
export function applySearchOp(source, body) {
  let doc;
  try {
    doc = yaml.load(source) ?? {};
  } catch (err) {
    return { ok: false, status: 409, error: `portals.yml does not parse: ${err.message}` };
  }
  const names = (Array.isArray(doc?.tracked_companies) ? doc.tracked_companies : []).filter((c) => isMapping(c) && typeof c.name === "string").map((c) => c.name);
  const searches = listLinkedInSearches(doc);
  const op = isMapping(body) ? body.op : undefined;

  if (op === "add") {
    const v = validateSearch(body.search, { existingNames: names });
    if (!v.ok) return { ok: false, status: 400, error: v.error };
    const text = addSearchText(source, v.value);
    return text ? { ok: true, text } : { ok: false, status: 409, error: SHAPE_ERROR };
  }

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (op === "toggle" || op === "update") {
    if (!searches.some((s) => s.name === name)) return { ok: false, status: 404, error: `There is no LinkedIn search named "${name}" in portals.yml.` };
  }
  if (op === "toggle") {
    if (typeof body.enabled !== "boolean") return { ok: false, status: 400, error: "enabled must be true or false." };
    const text = updateSearchText(source, name, { enabled: body.enabled });
    return text ? { ok: true, text } : { ok: false, status: 409, error: SHAPE_ERROR };
  }
  if (op === "update") {
    const v = validateSearch(body.search, { existingNames: names, editing: name });
    if (!v.ok) return { ok: false, status: 400, error: v.error };
    const text = updateSearchText(source, name, v.value);
    return text ? { ok: true, text } : { ok: false, status: 409, error: SHAPE_ERROR };
  }
  return { ok: false, status: 400, error: "op must be add, update or toggle." };
}
