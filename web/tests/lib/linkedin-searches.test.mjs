// Tests for the LinkedIn section's portals.yml editor: listing, adding, editing
// and toggling the linkedin-browser searches.
//
// portals.yml is the user's own file, full of comments and commented-out
// companies, so every edit is a line edit that leaves every other byte alone,
// and an edit whose result does not parse to exactly the intended document is
// refused (null) rather than written.
//
// Run:  node --test tests/lib/linkedin-searches.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as yaml from "js-yaml";
import {
  addSearchText,
  applySearchOp,
  describeSearchUrl,
  listLinkedInSearches,
  updateSearchText,
  validateSearch,
} from "../../src/lib/linkedin-searches.mjs";

const SOURCE = `# My portals — hand-written comments must survive.
title_filter:
  positive:
    - "Engineering Manager"

tracked_companies:
  # ── ATS boards ──
  - name: Acme
    careers_url: https://job-boards.greenhouse.io/acme
    enabled: true

  # - name: Old Co   (commented out, keep me)
  #   careers_url: https://example.com

  - name: LinkedIn em-germany-7d
    provider: linkedin-browser
    search_url: "https://www.linkedin.com/jobs/search/?f_TPR=r604800&f_WT=2%2C3&geoId=101282230&keywords=Engineering%20Manager&sortBy=DD"
    max_pages: 3  # three pages is plenty
    enabled: true

  - name: "LinkedIn head-of-eng-berlin-30d"
    provider: linkedin-browser
    search_url: "https://www.linkedin.com/jobs/search/?f_TPR=r2592000&geoId=103035651&keywords=Head%20of%20Engineering"
    enabled: false

# ── Job boards ──
job_boards:
  - name: Remote board
    api: https://remote.example/api
`;

const DE_URL = "https://www.linkedin.com/jobs/search/?f_TPR=r86400&f_WT=2&geoId=101282230&keywords=Director%20of%20Engineering&sortBy=DD";

test("listLinkedInSearches: only linkedin-browser entries, with their options", () => {
  const list = listLinkedInSearches(yaml.load(SOURCE));
  assert.deepEqual(list.map((s) => [s.name, s.enabled, s.maxPages, s.maxApplyLookups]), [
    ["LinkedIn em-germany-7d", true, 3, null],
    ["LinkedIn head-of-eng-berlin-30d", false, null, null],
  ]);
  assert.match(list[0].searchUrl, /keywords=Engineering%20Manager/);
});

test("describeSearchUrl: keywords, location id, posted window and workplace in plain words", () => {
  assert.deepEqual(describeSearchUrl(DE_URL), { keywords: "Director of Engineering", geoId: "101282230", posted: "past 24 hours", workplace: ["remote"] });
  assert.deepEqual(describeSearchUrl("https://www.linkedin.com/jobs/search/?f_TPR=r2592000&f_WT=1%2C3&keywords=EM"), { keywords: "EM", geoId: "", posted: "past month", workplace: ["on-site", "hybrid"] });
  assert.equal(describeSearchUrl("https://www.linkedin.com/jobs/search/?keywords=x").posted, "any time");
  assert.equal(describeSearchUrl("not a url"), null);
});

test("validateSearch: a good search is normalised; currentJobId is dropped from the URL", () => {
  const r = validateSearch({ name: "  LinkedIn director-de-24h ", searchUrl: `${DE_URL}&currentJobId=4480683016`, maxPages: "2", maxApplyLookups: "10", enabled: true }, { existingNames: ["Acme"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { name: "LinkedIn director-de-24h", searchUrl: DE_URL, maxPages: 2, maxApplyLookups: 10, enabled: true });
  const defaults = validateSearch({ name: "x", searchUrl: DE_URL }, { existingNames: [] });
  assert.deepEqual([defaults.value.maxPages, defaults.value.maxApplyLookups, defaults.value.enabled], [3, null, true]);
});

test("validateSearch: refuses what portals.yml or the crawl cannot use", () => {
  const bad = [
    [{ name: "", searchUrl: DE_URL }, /name/],
    [{ name: "a\nb", searchUrl: DE_URL }, /name/],
    [{ name: "x".repeat(81), searchUrl: DE_URL }, /name/],
    [{ name: "acme", searchUrl: DE_URL }, /already/],
    [{ name: "x", searchUrl: "https://www.linkedin.com/jobs/view/123" }, /search/],
    [{ name: "x", searchUrl: "https://linkedin.com.evil.example/jobs/search/?keywords=x" }, /LinkedIn/],
    [{ name: "x", searchUrl: "http://www.linkedin.com/jobs/search/?keywords=x" }, /https/],
    [{ name: "x", searchUrl: "javascript:alert(1)" }, /URL/],
    [{ name: "x", searchUrl: DE_URL, maxPages: 0 }, /pages/],
    [{ name: "x", searchUrl: DE_URL, maxPages: 11 }, /pages/],
    [{ name: "x", searchUrl: DE_URL, maxApplyLookups: 101 }, /lookups/],
    [{ name: "x", searchUrl: DE_URL, maxApplyLookups: -1 }, /lookups/],
    [{ name: "x", searchUrl: DE_URL, enabled: "yes" }, /enabled/],
  ];
  for (const [input, msg] of bad) {
    const r = validateSearch(input, { existingNames: ["Acme"] });
    assert.equal(r.ok, false, JSON.stringify(input).slice(0, 80));
    assert.match(r.error, msg);
  }
  assert.equal(validateSearch({ name: "Acme", searchUrl: DE_URL }, { existingNames: ["Acme"], editing: "Acme" }).ok, true, "keeping its own name while editing");
});

test("addSearchText: appends after the last LinkedIn search, every other line untouched", () => {
  const added = { name: "LinkedIn director-de-24h", searchUrl: DE_URL, maxPages: 2, maxApplyLookups: 10, enabled: true };
  const text = addSearchText(SOURCE, added);
  assert.ok(text, "the edit was refused");
  for (const line of SOURCE.split("\n")) assert.ok(text.includes(line), `lost line: ${line}`);
  const doc = yaml.load(text);
  const names = doc.tracked_companies.map((c) => c.name);
  assert.deepEqual(names, ["Acme", "LinkedIn em-germany-7d", "LinkedIn head-of-eng-berlin-30d", "LinkedIn director-de-24h"]);
  assert.deepEqual(doc.tracked_companies[3], { name: "LinkedIn director-de-24h", provider: "linkedin-browser", search_url: DE_URL, max_pages: 2, max_apply_lookups: 10, enabled: true });
  assert.ok(text.indexOf("director-de-24h") < text.indexOf("# ── Job boards ──"), "inside tracked_companies, before the next section");
  assert.match(text, /\n {4}provider: linkedin-browser\n {4}search_url:/, "provider written bare, like hand-written entries");
});

test("addSearchText: works when there is no LinkedIn search yet, and when there is no tracked_companies", () => {
  const noLinkedIn = "tracked_companies:\n  - name: Acme\n    careers_url: https://x.example\n\njob_boards: []\n";
  const a = yaml.load(addSearchText(noLinkedIn, { name: "L", searchUrl: DE_URL, maxPages: 3, maxApplyLookups: null, enabled: true }));
  assert.deepEqual(a.tracked_companies.map((c) => c.name), ["Acme", "L"]);
  assert.equal("max_apply_lookups" in a.tracked_companies[1], false, "the default is left out");
  const empty = yaml.load(addSearchText("title_filter:\n  positive: []\n", { name: "L", searchUrl: DE_URL, maxPages: 3, maxApplyLookups: null, enabled: true }));
  assert.equal(empty.tracked_companies[0].provider, "linkedin-browser");
});

test("updateSearchText: toggles, edits and renames one search, keeping its comment and every other line", () => {
  const toggled = updateSearchText(SOURCE, "LinkedIn head-of-eng-berlin-30d", { enabled: true });
  assert.equal(yaml.load(toggled).tracked_companies[2].enabled, true);
  assert.equal(toggled.split("\n").length, SOURCE.split("\n").length);

  const edited = updateSearchText(SOURCE, "LinkedIn em-germany-7d", { name: "LinkedIn em-germany-24h", searchUrl: DE_URL, maxPages: 2, maxApplyLookups: 0 });
  const entry = yaml.load(edited).tracked_companies[1];
  assert.deepEqual(entry, { name: "LinkedIn em-germany-24h", provider: "linkedin-browser", search_url: DE_URL, max_pages: 2, enabled: true, max_apply_lookups: 0 });
  assert.match(edited, /max_pages: 2  # three pages is plenty/, "a trailing comment on an edited line stays");
  assert.match(edited, /# - name: Old Co {3}\(commented out, keep me\)/);
  assert.equal(yaml.load(edited).tracked_companies[0].name, "Acme", "other entries untouched");

  const cleared = updateSearchText(edited, "LinkedIn em-germany-24h", { maxApplyLookups: null });
  assert.equal("max_apply_lookups" in yaml.load(cleared).tracked_companies[1], false, "back to the default removes the line");
});

test("updateSearchText: refuses a search that is not there, and a non-LinkedIn entry", () => {
  assert.equal(updateSearchText(SOURCE, "LinkedIn nope", { enabled: false }), null);
  assert.equal(updateSearchText(SOURCE, "Acme", { enabled: false }), null);
});

test("edits refuse a file whose shape the line editor does not handle", () => {
  const flow = 'tracked_companies: [{ name: "LinkedIn x", provider: linkedin-browser, search_url: "https://www.linkedin.com/jobs/search/?keywords=x" }]\n';
  assert.equal(updateSearchText(flow, "LinkedIn x", { enabled: false }), null);
  assert.equal(addSearchText(flow, { name: "L", searchUrl: DE_URL, maxPages: 3, maxApplyLookups: null, enabled: true }), null);
});

test("applySearchOp: add, edit and toggle from a request body, with validation", () => {
  const added = applySearchOp(SOURCE, { op: "add", search: { name: "LinkedIn director-de-24h", searchUrl: DE_URL, maxPages: 2 } });
  assert.equal(added.ok, true);
  assert.equal(yaml.load(added.text).tracked_companies.at(-1).name, "LinkedIn director-de-24h");

  const toggled = applySearchOp(SOURCE, { op: "toggle", name: "LinkedIn em-germany-7d", enabled: false });
  assert.equal(yaml.load(toggled.text).tracked_companies[1].enabled, false);

  const edited = applySearchOp(SOURCE, { op: "update", name: "LinkedIn em-germany-7d", search: { name: "LinkedIn em-de", searchUrl: DE_URL, maxPages: 1, maxApplyLookups: "", enabled: true } });
  assert.equal(edited.ok, true);
  const e = yaml.load(edited.text).tracked_companies[1];
  assert.deepEqual([e.name, e.max_pages, "max_apply_lookups" in e], ["LinkedIn em-de", 1, false]);
});

test("applySearchOp: refusals carry a status the route can return", () => {
  const cases = [
    [{ op: "nope" }, 400],
    [{ op: "add", search: { name: "Acme", searchUrl: DE_URL } }, 400],
    [{ op: "add", search: { name: "x", searchUrl: "https://example.com" } }, 400],
    [{ op: "toggle", name: "LinkedIn missing", enabled: true }, 404],
    [{ op: "toggle", name: "LinkedIn em-germany-7d", enabled: "no" }, 400],
    [{ op: "update", name: "LinkedIn missing", search: { name: "y", searchUrl: DE_URL } }, 404],
    [{ op: "update", name: "LinkedIn em-germany-7d", search: { name: "LinkedIn head-of-eng-berlin-30d", searchUrl: DE_URL } }, 400],
  ];
  for (const [body, status] of cases) {
    const r = applySearchOp(SOURCE, body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.status, status, JSON.stringify(body));
    assert.ok(r.error);
  }
  const flow = 'tracked_companies: [{ name: "LinkedIn x", provider: linkedin-browser, search_url: "https://www.linkedin.com/jobs/search/?keywords=x" }]\n';
  assert.equal(applySearchOp(flow, { op: "toggle", name: "LinkedIn x", enabled: false }).status, 409);
});
