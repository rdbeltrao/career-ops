// The inbox's Jev verdict chips. A row Jev marked "skip" used to be counted and
// shown as "maybe", so the contractor and wrong-stack roles Jev had ruled out
// sat in "Fresh — worth a look". Skip rows now have their own chip and stay
// out of the list until that chip is pressed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JEV_FACETS, jevFacetOf, passesJevFacet } from "../../src/lib/inbox-jev-facet.mjs";

const row = (verdict) => ({ url: `https://x.test/${verdict}`, company: "Acme", role: "EM", done: false, ...(verdict ? { jev: { fit: 10, verdict, reasons: "" } } : {}) });

test("each Jev verdict maps to its own facet", () => {
  assert.deepEqual(JEV_FACETS, ["apply", "maybe", "skip", "unscored"]);
  assert.equal(jevFacetOf(row("apply")), "apply");
  assert.equal(jevFacetOf(row("maybe")), "maybe");
  assert.equal(jevFacetOf(row("skip")), "skip");
  assert.equal(jevFacetOf(row(null)), "unscored");
});

test("skip rows are hidden unless the skip chip is on", () => {
  const none = new Set();
  assert.equal(passesJevFacet(row("skip"), none), false);
  assert.equal(passesJevFacet(row("maybe"), none), true);
  assert.equal(passesJevFacet(row("apply"), none), true);
  assert.equal(passesJevFacet(row(null), none), true);

  assert.equal(passesJevFacet(row("skip"), new Set(["skip"])), true);
  assert.equal(passesJevFacet(row("maybe"), new Set(["skip"])), false);
  assert.equal(passesJevFacet(row("skip"), new Set(["maybe"])), false);
});
