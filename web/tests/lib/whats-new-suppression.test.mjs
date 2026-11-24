// Suppression for the Explore "new matches" supply loop must be per ROLE, not
// per employer (#3131).
//
// Keying on the company alone meant one evaluated role removed that employer's
// entire board from Explore, permanently, including postings first seen later.
// The scanner was working throughout — the rows were in scan-history.tsv, only
// the view hid them — and "no new matches" reads identically to "matches exist
// but are suppressed", which is what made it hard to notice.
//
// The normalizer is injected in production (the route resolves the CORE's
// normalizeTextKey from the user's own checkout so web dedup matches CLI
// dedup), so these tests inject the same Unicode-safe mirror the web ships as
// its fallback. Using a toy normalizer here would test a key helper that does
// not exist in production.
//
// Run:  node --test tests/lib/whats-new-suppression.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatedKeys, isEvaluated, suppressionKey } from "../../src/lib/whats-new-suppression.mjs";
import { normalizeTextKey as norm } from "../../src/lib/core/normalize-text-key.mjs";

const evaluatedAt = (...pairs) => evaluatedKeys(pairs.map(([company, role]) => ({ company, role })), norm);

test("a sibling role at an evaluated employer is NOT suppressed", () => {
  // The bug: evaluating one Google role hid every Google role forever.
  const keys = evaluatedAt(["Google", "Staff Software Engineer"]);
  assert.equal(isEvaluated(keys, norm, "Google", "Staff Software Engineer"), true, "the evaluated role should stay hidden");
  assert.equal(isEvaluated(keys, norm, "Google", "Senior Product Manager"), false, "a different role at the same employer was hidden");
  assert.equal(isEvaluated(keys, norm, "Google", "Engineering Manager, Search"), false);
});

test("the evaluated role itself is still suppressed on a repost", () => {
  // The guard: this is what the suppression is FOR. A fix that stopped
  // suppressing would pass the test above and break the feature.
  const keys = evaluatedAt(["Acme", "Staff Engineer"]);
  assert.equal(isEvaluated(keys, norm, "Acme", "Staff Engineer"), true);
  // Same role, cosmetic differences the core key folds away: case and
  // surrounding/interior whitespace.
  assert.equal(isEvaluated(keys, norm, "  acme  ", "STAFF   ENGINEER"), true);
  // NOT folded, and deliberately not asserted as such: the core key keeps
  // punctuation as a separator, so "Acme, Inc." keys as "acme inc" and does
  // not match "acme". That is unchanged from the company-only key this
  // replaces — the legal-suffix question is orthogonal to #3131, and pinning
  // it either way here would be inventing a contract this key never had.
  assert.equal(isEvaluated(keys, norm, "Acme, Inc.", "Staff Engineer"), false);
});

test("an unrelated employer is untouched", () => {
  const keys = evaluatedAt(["Acme", "Staff Engineer"]);
  assert.equal(isEvaluated(keys, norm, "Globex", "Staff Engineer"), false);
});

test("a role-less tracker row suppresses only a title-less scan row", () => {
  // Backfilled rows (#1799) carry no role. Under the old key they suppressed
  // the whole employer; they must now suppress just their own shape.
  const keys = evaluatedAt(["Initech", ""]);
  assert.equal(isEvaluated(keys, norm, "Initech", ""), true);
  assert.equal(isEvaluated(keys, norm, "Initech", "Staff Engineer"), false, "a backfilled row hid a real posting");
});

test("non-Latin companies and roles key distinctly (#2666 stays fixed)", () => {
  // The core key preserves script; an ASCII-only key would collapse all of
  // these to the empty string and make every pair collide.
  const keys = evaluatedAt(["日本電産", "ソフトウェアエンジニア"], ["Škoda", "Konstrukteur"]);
  assert.equal(isEvaluated(keys, norm, "日本電産", "ソフトウェアエンジニア"), true);
  assert.equal(isEvaluated(keys, norm, "日本電産", "プロダクトマネージャー"), false, "a sibling role was hidden");
  assert.equal(isEvaluated(keys, norm, "Škoda", "Konstrukteur"), true);
  assert.equal(isEvaluated(keys, norm, "Koda", "Konstrukteur"), false, "Škoda and Koda collided");
});

test("a company that normalizes to nothing suppresses nothing", () => {
  // Otherwise one unkeyable tracker row would hide every scan row whose
  // company is also unkeyable — the empty-key collision from #2666, moved.
  const keys = evaluatedKeys([{ company: "!!!", role: "Staff Engineer" }], norm);
  assert.equal(keys.size, 0);
  assert.equal(isEvaluated(keys, norm, "???", "Staff Engineer"), false);
  assert.equal(isEvaluated(keys, norm, "", "Staff Engineer"), false);
});

test("the key separates the two fields", () => {
  // "ab" + "" and "a" + "b" must not produce one key.
  assert.notEqual(suppressionKey(norm, "ab", ""), suppressionKey(norm, "a", "b"));
});

test("missing rows and fields do not throw", () => {
  assert.equal(evaluatedKeys(undefined, norm).size, 0);
  assert.equal(evaluatedKeys([{}], norm).size, 0);
  const keys = evaluatedAt(["Acme", "Staff Engineer"]);
  assert.equal(isEvaluated(keys, norm, undefined, undefined), false);
});

// ── Posting-URL suppression ────────────────────────────────────────────────
// Company+role text alone missed most already-handled postings: the scanner
// stores the board slug ("crownholdings") while the tracker holds the display
// name ("Crown Holdings"), titles get reworded ("SW" vs "Software"), and a
// LinkedIn row with a hidden employer is tracked as "?". The posting URL is
// the deterministic key the tracker, the reports and pipeline.md all carry.

import { handledPostingKeys, isHandledPosting } from "../../src/lib/whats-new-suppression.mjs";

const GH = "https://job-boards.greenhouse.io/xometryeurope/jobs/5298035007";

test("a tracker row suppresses its posting even when company and role text differ", () => {
  const keys = handledPostingKeys({
    applications: [{ company: "Xometry Europe", role: "Senior Engineering Manager", url: `[greenhouse](${GH})` }],
  });
  assert.equal(isHandledPosting(keys, GH), true);
  assert.equal(isHandledPosting(keys, `${GH}?utm_source=linkedin`), true, "a tracking parameter broke the match");
  assert.equal(isHandledPosting(keys, "https://job-boards.greenhouse.io/xometryeurope/jobs/5298035008"), false, "a sibling posting was hidden");
});

test("a tracker row with a bare URL cell or a SKIP status still suppresses", () => {
  const keys = handledPostingKeys({ applications: [{ company: "?", role: "Head of Engineering", url: "https://www.linkedin.com/jobs/view/4484323485/" }] });
  assert.equal(isHandledPosting(keys, "https://www.linkedin.com/jobs/view/4484323485/"), true);
});

test("a processed pipeline row suppresses; a pending one does not", () => {
  // Pending rows are scanned but not evaluated yet: those ARE the new matches.
  const keys = handledPostingKeys({
    inbox: [
      { url: "https://jobs.lever.co/zeneducate/c3a5", done: true },
      { url: "https://jobs.ashbyhq.com/axmed/123", done: false },
    ],
  });
  assert.equal(isHandledPosting(keys, "https://jobs.lever.co/zeneducate/c3a5"), true);
  assert.equal(isHandledPosting(keys, "https://jobs.ashbyhq.com/axmed/123"), false);
});

test("empty and missing URL cells suppress nothing", () => {
  const keys = handledPostingKeys({ applications: [{ url: "" }, { url: "—" }, {}], inbox: [{ done: true }] });
  assert.equal(keys.size, 0);
  assert.equal(isHandledPosting(keys, ""), false);
  assert.equal(isHandledPosting(handledPostingKeys(), undefined), false);
});
