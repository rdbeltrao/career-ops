import assert from "node:assert/strict";
import { test } from "node:test";
import { groupSimilarApplications } from "../../src/lib/pipeline-groups.mjs";

function row(n, overrides = {}) {
  return { n: String(n), company: "Fixture Alpha", role: "Engineering Manager - EU", date: "2026-10-25", report: "", status: "Evaluated", location: "", via: "", url: `https://www.linkedin.com/jobs/view/${n}/`, ...overrides };
}

test("groups LinkedIn reposts and the employer listing without losing any source row", () => {
  const rows = [row(185), row(340), row(71, { role: "Engineering Manager, EU", url: "https://jobs.ashbyhq.com/fixture/opening-one" })];
  const before = structuredClone(rows);
  const groups = groupSimilarApplications(rows);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].rows, rows);
  assert.equal(groups[0].rows[0], rows[0]);
  assert.deepEqual(rows, before);
});

test("case, spacing and gender tags are display noise", () => {
  const groups = groupSimilarApplications([row(1, { role: "Engineering Manager (m/f/d)" }), row(2, { role: "  engineering   manager " })]);
  assert.equal(groups.length, 1);
});

test("seniority, team, geography, channel and status keep separate rows", () => {
  const rows = [row(1), ...[
    { role: "Senior Engineering Manager - EU" },
    { role: "Engineering Manager - US" },
    { role: "Engineering Manager - Data Platform" },
    { location: "Berlin" },
    { location: "Paris" },
    { via: "Fixture Recruiter" },
    { status: "Applied" },
    { status: "Rejected" },
  ].map((overrides, i) => row(i + 2, overrides))];
  assert.equal(groupSimilarApplications(rows).length, rows.length);
});

test("placeholder employers, roles and URLs never imply a match", () => {
  for (const overrides of [{ company: "?" }, { company: "" }, { role: "(see report)" }, { role: "N/A" }, { role: "" }, { url: "" }, { url: "—" }]) {
    assert.equal(groupSimilarApplications([row(1, overrides), row(2, overrides)]).length, 2);
  }
});

test("different employer requisitions stay separate even with a LinkedIn bridge", () => {
  const first = row(1, { url: "https://jobs.ashbyhq.com/fixture/opening-one" });
  const second = row(2, { url: "https://jobs.ashbyhq.com/fixture/opening-two" });
  for (const rows of [[first, row(3), second], [row(3), first, second], [first, second, row(3)]]) {
    const groups = groupSimilarApplications(rows);
    assert.equal(groups.length, 2);
    assert.ok(groups.every(({ rows }) => !(rows.includes(first) && rows.includes(second))));
    assert.equal(groups.flatMap(({ rows }) => rows).length, 3);
  }
});

test("same employer URL ignores campaign parameters but preserves functional queries", () => {
  const first = row(1, { url: "https://careers.example.com/job?gh_jid=1&utm_source=one" });
  const same = row(2, { url: "[posting](https://careers.example.com/job?utm_source=two&gh_jid=1)" });
  const other = row(3, { url: "https://careers.example.com/job?gh_jid=2" });
  assert.deepEqual(groupSimilarApplications([first, same, other]).map(({ rows }) => rows.map(({ n }) => n)), [["1", "2"], ["3"]]);
});

test("technical title symbols remain meaningful", () => {
  const groups = groupSimilarApplications([row(1, { role: "C++ Engineering Manager" }), row(2, { role: "C# Engineering Manager" })]);
  assert.equal(groups.length, 2);
});
