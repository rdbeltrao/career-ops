import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxKey, pendingInbox } from "../../src/lib/inbox-pending.mjs";

test("pendingInbox drops done postings and repeated URLs", () => {
  const inbox = [
    { url: "https://jobs.example.test/a", done: false, role: "First" },
    { url: "https://jobs.example.test/b", done: true, role: "Done" },
    { url: "https://jobs.example.test/a", done: false, role: "Repeat" },
    { url: "https://jobs.example.test/c", done: false, role: "Third" },
  ];
  assert.deepEqual(pendingInbox(inbox).map((j) => j.role), ["First", "Third"]);
});

test("pendingInbox keys by posting URL and hides postings that already have a report", () => {
  const inbox = [
    { url: "https://jobs.example.test/a/", done: false, role: "First" },
    { url: "http://jobs.example.test/a?utm_source=li", done: false, role: "Repeat by key" },
    { url: "https://jobs.example.test/b?gh_jid=1", done: false, role: "Evaluated" },
    { url: "https://jobs.example.test/c", done: false, role: "Third" },
    { url: "local:jds/d.md", done: false, role: "Local" },
  ];
  const evaluated = new Set([inboxKey("https://jobs.example.test/b/?gh_jid=1&utm_medium=x"), inboxKey("local:jds/d.md")]);
  assert.deepEqual(pendingInbox(inbox, evaluated).map((j) => j.role), ["First", "Third"]);
  assert.deepEqual(pendingInbox(inbox, [...evaluated]).map((j) => j.role), ["First", "Third"], "an iterable works too");
  assert.equal(inboxKey("https://jobs.example.test/a/"), inboxKey("http://jobs.example.test/a?utm_source=li"));
  assert.notEqual(inboxKey("https://jobs.example.test/b?gh_jid=1"), inboxKey("https://jobs.example.test/b"));
});
