// The Explore Ignore button hides a card at once but writes the permanent
// scan-history row only when the undo window closes, because that file is
// append-only and an Undo could not take the row back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createIgnoreQueue, postIgnore } from "../../src/lib/explore-ignore.mjs";

/** A manual clock: timers run only when the test says so. */
function manualTimers() {
  const timers = new Map();
  let next = 1;
  return {
    schedule: (fn) => { const id = next++; timers.set(id, fn); return id; },
    cancel: (id) => { timers.delete(id); },
    runAll: () => { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn(); },
    get size() { return timers.size; },
  };
}

const offer = { url: "https://jobs.ashbyhq.com/acme/1", title: "Engineering Lead", company: "Acme" };

test("nothing is written until the undo window closes", async () => {
  const clock = manualTimers();
  const written = [];
  const queue = createIgnoreQueue({ commit: async (o) => { written.push(o.url); }, ...clock });
  queue.add(offer);
  assert.deepEqual(written, []);
  assert.equal(queue.has(offer.url), true);
  clock.runAll();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(written, [offer.url]);
  assert.equal(queue.has(offer.url), false);
});

test("Undo inside the window writes nothing", async () => {
  const clock = manualTimers();
  const written = [];
  const queue = createIgnoreQueue({ commit: async (o) => { written.push(o.url); }, ...clock });
  queue.add(offer);
  assert.equal(queue.undo(offer.url), true);
  assert.equal(clock.size, 0);
  clock.runAll();
  await queue.flush();
  assert.deepEqual(written, []);
});

test("Undo after the write reports that it is too late", async () => {
  const clock = manualTimers();
  const queue = createIgnoreQueue({ commit: async () => {}, ...clock });
  queue.add(offer);
  await queue.flush();
  assert.equal(queue.undo(offer.url), false);
});

test("flush sends every pending ignore once, and a second add of one URL is a no-op", async () => {
  const clock = manualTimers();
  const written = [];
  const queue = createIgnoreQueue({ commit: async (o) => { written.push(o.url); }, ...clock });
  const other = { ...offer, url: "https://jobs.ashbyhq.com/acme/2" };
  queue.add(offer);
  queue.add(offer);
  queue.add(other);
  await queue.flush();
  clock.runAll();
  await queue.flush();
  assert.deepEqual(written.sort(), [offer.url, other.url]);
});

test("a failing commit does not break the queue", async () => {
  const clock = manualTimers();
  const queue = createIgnoreQueue({ commit: async () => { throw new Error("disk full"); }, ...clock });
  queue.add(offer);
  await queue.flush();
  assert.equal(queue.has(offer.url), false);
});

test("postIgnore sends the offers with keepalive and returns the recorded count", async () => {
  let sent;
  const request = async (url, init) => { sent = { url, init }; return Response.json({ ignored: 1 }); };
  assert.equal(await postIgnore([offer], request), 1);
  assert.equal(sent.url, "/api/explore/ignore");
  assert.equal(sent.init.method, "POST");
  assert.equal(sent.init.keepalive, true);
  assert.deepEqual(JSON.parse(sent.init.body), { offers: [offer] });
});

test("postIgnore throws the server's error message", async () => {
  const request = async () => Response.json({ ignored: 0, error: "scan.mjs is too old" }, { status: 500 });
  await assert.rejects(postIgnore([offer], request), /scan\.mjs is too old/);
});

test("postIgnore rejects an answer it cannot read", async () => {
  const request = async () => new Response("<html>", { status: 200 });
  await assert.rejects(postIgnore([offer], request), /Could not save the ignore/);
});
