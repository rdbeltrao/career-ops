import assert from "node:assert/strict";
import { test } from "node:test";
import { isModelAccessError, workerErrorMessage } from "../../src/lib/worker-error.mjs";

const sentence = "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
const guidance = "Open Config and choose an available model, then retry.";
const payload = { type: "error", status: 400, error: { type: "invalid_request_error", message: sentence, code: "model_not_found" } };

test("unwraps the reported Codex model error without its JSON transport", () => {
  assert.equal(workerErrorMessage(payload), `${sentence} ${guidance}`);
  assert.equal(workerErrorMessage(JSON.stringify(payload)), `${sentence} ${guidance}`);
  assert.equal(workerErrorMessage({ type: "error", message: JSON.stringify(payload) }), `${sentence} ${guidance}`);
  assert.equal(workerErrorMessage({ type: "turn.failed", error: { message: JSON.stringify(payload) } }), `${sentence} ${guidance}`);
});

test("model codes add recovery guidance even when the provider message is terse", () => {
  assert.equal(workerErrorMessage({ error: { code: "model_not_found", message: "Access denied." } }), `Access denied. ${guidance}`);
  assert.equal(workerErrorMessage("model unavailable"), `model unavailable ${guidance}`);
  assert.equal(workerErrorMessage(`${sentence} ${guidance}`), `${sentence} ${guidance}`, "guidance is not repeated");
});

test("truncated saved model JSON gets a safe specific diagnostic without exposing its raw body", () => {
  assert.equal(workerErrorMessage(JSON.stringify(payload).slice(0, 200)), `${sentence} ${guidance}`, "a complete compact payload still preserves its provider sentence");
  const truncated = JSON.stringify(payload).slice(0, 150);
  const nestedTruncated = JSON.stringify({ type: "error", message: JSON.stringify(payload) }).slice(0, 200);
  assert.equal(workerErrorMessage(truncated), `The selected model is not available for this account. ${guidance}`);
  assert.equal(workerErrorMessage(nestedTruncated), `The selected model is not available for this account. ${guidance}`);
  assert.equal(workerErrorMessage('{"error":{"code":"model_not_found","request":{"prompt":"private'), `The selected model is not available for this account. ${guidance}`);
  assert.equal(workerErrorMessage('{"error":{"message":"quota exceeded","request":{"prompt":"private'), "The AI worker failed before finishing.");
});

test("preserves quota, authentication and ordinary provider failures exactly", () => {
  for (const message of ["quota exceeded", "Invalid API key", "Reconnecting... (attempt 1)", "connection reset"]) {
    assert.equal(workerErrorMessage({ error: { message } }), message);
  }
  assert.equal(workerErrorMessage({ result: "CLI exited before finishing" }), "CLI exited before finishing");
});

test("never serializes arbitrary request bodies or unknown objects", () => {
  const fallback = "The AI worker failed before finishing.";
  assert.equal(workerErrorMessage({ request: { prompt: "private career facts" }, extra: "private" }), fallback);
  assert.equal(workerErrorMessage(JSON.stringify({ request: { message: "private request data" } })), fallback);
  assert.equal(workerErrorMessage({ type: "item.completed", item: { text: sentence } }), fallback);
  assert.equal(workerErrorMessage([]), fallback);
  assert.equal(workerErrorMessage(null), fallback);
  assert.equal(workerErrorMessage("{broken JSON"), fallback);
});

test("nested and cyclic payloads terminate within a bounded depth", () => {
  const cycle = {};
  cycle.error = cycle;
  assert.equal(workerErrorMessage(cycle), "The AI worker failed before finishing.");
  let nested = "quota exceeded";
  for (let n = 0; n < 20; n++) nested = { error: nested };
  assert.equal(workerErrorMessage(nested), "The AI worker failed before finishing.");
});

test("recognizes terminal model-access errors without treating ordinary model prose as failures", () => {
  assert.equal(isModelAccessError(payload), true);
  assert.equal(isModelAccessError(JSON.stringify(payload)), true);
  assert.equal(isModelAccessError(sentence), true);
  assert.equal(isModelAccessError("The model does not exist or you do not have access to it."), true);
  for (const message of ["Failed to parse author metadata", "The role involves model evaluation and authentication flows.", "Model training credentials are a requirement.", "Model selection updated successfully."]) {
    assert.equal(isModelAccessError(message), false);
  }
});
