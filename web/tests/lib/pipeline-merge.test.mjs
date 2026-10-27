import assert from "node:assert/strict";
import { test } from "node:test";
import { canMergeListings, mergeListings } from "../../src/lib/pipeline-merge.mjs";

const row = (n, extra = {}) => ({ n: String(n), company: "Fixture Alpha", role: "Engineering Manager (m/f/d)", date: "2026-10-27", report: "", status: "Evaluated", url: `https://www.linkedin.com/jobs/view/${n}`, ...extra });

test("merge selection requires one similar group with distinct valid tracker numbers", () => {
  assert.equal(canMergeListings([row(1), row(2)]), true);
  for (const rows of [[], [row(1)], [row(1), row(1)], [row(1), row("N/A")], [row(1), row(2, { company: "Fixture Beta" })], [row(1), row(2, { status: "Applied" })]]) {
    assert.equal(canMergeListings(rows), false);
  }
});

test("merge sends exactly selected rows and chosen retained number", async () => {
  const calls = [];
  const rows = [row(1), row(2), row(3)];
  const result = await mergeListings(rows, "2", async (url, init) => {
    calls.push([url, init.method, JSON.parse(init.body)]);
    return Response.json({ ok: true, kept: "2", merged: ["1", "3"], changed: true });
  });
  assert.deepEqual(calls, [["/api/tracker/merge", "POST", { keep: "2", nums: ["1", "2", "3"] }]]);
  assert.equal(result.kept, "2");
  assert.deepEqual(result.merged, ["1", "3"]);
});

test("invalid selection never makes a request", async () => {
  let calls = 0;
  const request = async () => { calls++; };
  await assert.rejects(mergeListings([row(1)], "1", request), /similar listings/);
  await assert.rejects(mergeListings([row(1), row(2)], "3", request), /retained listing/);
  assert.equal(calls, 0);
});

test("merge surfaces server and network failures without claiming success", async () => {
  await assert.rejects(mergeListings([row(1), row(2)], "1", async () => Response.json({ error: "Tracker changed; refresh first." }, { status: 409 })), /Tracker changed; refresh first\./);
  await assert.rejects(mergeListings([row(1), row(2)], "1", async () => new Response("broken", { status: 500 })), /Could not merge listings/);
  await assert.rejects(mergeListings([row(1), row(2)], "1", async () => Response.json({ ok: true })), /Could not merge listings/);
  await assert.rejects(mergeListings([row(1), row(2)], "1", async () => { throw new Error("offline"); }), /offline/);
});
