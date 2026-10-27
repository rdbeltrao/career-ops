import { test } from "node:test";
import assert from "node:assert/strict";
import { pdfButtonState } from "../../src/lib/pdf-button-state.mjs";

const reason = "This run didn't produce a tailored CV to render, so no PDF was generated — re-run it to verify. (The agent emitted no <<cv-html>> envelope, so there is no CV to render.)";
const failed = {
  id: "job-7",
  status: "error",
  steps: [
    { kind: "status", label: "Starting…" },
    { kind: "tool", label: "read_file" },
    { kind: "status", label: reason },
  ],
};

test("a failed run with no earlier CV shows the reason next to Generate", () => {
  assert.deepEqual(pdfButtonState(failed, false), { kind: "idle", failure: { jobId: "job-7", reason } });
});

test("a failed regenerate keeps the earlier CV link and still shows the reason", () => {
  assert.deepEqual(pdfButtonState(failed, true), { kind: "ready", failure: { jobId: "job-7", reason } });
});

test("a failed run with no status step still names a failure", () => {
  assert.deepEqual(pdfButtonState({ id: "job-8", status: "error", steps: [] }, false), {
    kind: "idle",
    failure: { jobId: "job-8", reason: "The run stopped before it finished." },
  });
});

test("a finished run is ready with no failure", () => {
  assert.deepEqual(pdfButtonState({ id: "job-9", status: "done", steps: [] }, false), { kind: "ready", failure: null });
});

test("a running job links to its log", () => {
  assert.deepEqual(pdfButtonState({ id: "job-10", status: "running", steps: [] }, true), { kind: "running", jobId: "job-10" });
});

test("no job and no tracker CV is the plain Generate button", () => {
  assert.deepEqual(pdfButtonState(undefined, false), { kind: "idle", failure: null });
});

test("saved Codex model errors display a readable recovery message instead of JSON", () => {
  const message = "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
  const label = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message, code: "model_not_found" } });
  const state = pdfButtonState({ id: "old-job", status: "error", steps: [{ kind: "status", label }] }, false);
  assert.equal(state.failure.reason, `${message} Open Config and choose an available model, then retry.`);
  assert.equal(state.kind, "idle", "an account-access error never marks the CV ready");
});
