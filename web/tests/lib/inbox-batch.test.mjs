// The inbox lists only the pending rows that need the user. Rows the
// background batch is evaluating, or will evaluate on its next run, are counted
// in one status line instead of being listed with a Score button that would
// evaluate them a second time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { batchStageOf, parseBatchState, splitInbox } from "../../src/lib/inbox-batch.mjs";

const HEADER = "id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries";
const stateRow = (url, status, error = "-", retries = 0) => `1\t${url}\t${status}\t2026-10-26\t-\t-\t-\t${error}\t${retries}`;
const job = (n, jev) => ({ url: `https://jobs.example.test/${n}`, company: "Acme", role: "EM", done: false, ...(jev ? { jev: { fit: 40, verdict: jev, reasons: "" } } : {}) });

test("parseBatchState keys rows by posting URL, the last row winning", () => {
  const states = parseBatchState([
    HEADER,
    stateRow("https://jobs.example.test/1?utm_source=x", "failed", "boom", 1),
    stateRow("https://jobs.example.test/1", "processing"),
    "",
  ].join("\n"));
  assert.equal(states.size, 1);
  assert.deepEqual(states.get("https://jobs.example.test/1"), { status: "processing", error: "", retries: 0 });
  assert.equal(parseBatchState("").size, 0);
});

test("each batch status maps to who has to act", () => {
  const states = parseBatchState([
    HEADER,
    stateRow("https://jobs.example.test/1", "processing"),
    stateRow("https://jobs.example.test/2", "needs_confirmation", "Which agency did this posting come through?"),
    stateRow("https://jobs.example.test/3", "failed", "worker exited cleanly but wrote no report", 2),
    stateRow("https://jobs.example.test/4", "failed", "rate limit", 1),
    stateRow("https://jobs.example.test/5", "skipped", "jev: 11 skip verdict-skip"),
    stateRow("https://jobs.example.test/6", "paused_rate_limit"),
    stateRow("https://jobs.example.test/7", "completed"),
  ].join("\n"));
  const running = { batchRunning: true };
  assert.deepEqual(batchStageOf(job(1, "maybe"), states, running), { stage: "evaluating" });
  assert.deepEqual(batchStageOf(job(1, "maybe"), states, { batchRunning: false }), { stage: "queued" }, "a crashed run's row is picked up again");
  assert.deepEqual(batchStageOf(job(2, "maybe"), states, running), { stage: "needs-you", detail: "Needs your answer: Which agency did this posting come through?" });
  assert.deepEqual(batchStageOf(job(3, "maybe"), states, running), { stage: "needs-you", detail: "Evaluation failed: worker exited cleanly but wrote no report" });
  assert.deepEqual(batchStageOf(job(4, "maybe"), states, running), { stage: "queued" }, "a retry is left");
  assert.deepEqual(batchStageOf(job(5, "maybe"), states, running), { stage: "skip" });
  assert.deepEqual(batchStageOf(job(6, "maybe"), states, running), { stage: "queued" });
  assert.deepEqual(batchStageOf(job(7, "maybe"), states, running), { stage: "evaluating" }, "the report is being filed");
  assert.deepEqual(batchStageOf(job(8, "maybe"), states, running), { stage: "queued" }, "not in the batch yet");
  assert.deepEqual(batchStageOf(job(8, "skip"), states, running), { stage: "skip" });
  assert.deepEqual(batchStageOf(job(8), states, running), { stage: "queued" }, "unscored rows are pre-screened, then evaluated");
});

test("splitInbox lists the rows that need the user and counts the rest", () => {
  const states = parseBatchState([
    HEADER,
    stateRow("https://jobs.example.test/1", "processing"),
    stateRow("https://jobs.example.test/2", "needs_confirmation", "Which agency?"),
  ].join("\n"));
  const split = splitInbox([job(1, "maybe"), job(2, "maybe"), job(3, "apply"), job(4, "skip")], states, { batchRunning: true });
  assert.deepEqual(split.listed.map((j) => j.url), ["https://jobs.example.test/2", "https://jobs.example.test/4"]);
  assert.equal(split.listed[0].batch.detail, "Needs your answer: Which agency?");
  assert.equal(split.listed[1].batch.stage, "skip");
  assert.equal(split.needsYou, 1);
  assert.deepEqual(split.background, { evaluating: 1, queued: 1 });
});
