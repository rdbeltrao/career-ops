const MODEL_GUIDANCE = "Open Config and choose an available model, then retry.";
const MODEL_CODES = new Set(["model_not_found", "model_not_supported", "model_unavailable", "unsupported_model", "invalid_model"]);
const MODEL_ACCESS_PATTERN = /\b(?:unknown|unavailable|unsupported|invalid) model\b|\bmodel(?:\s+['"][^'"]+['"]|\s+[a-z0-9._:/-]+)?\s+(?:(?:is|was)\s+)?(?:not (?:supported|available|found)|unavailable|does not exist)\b|\b(?:do not|don't|does not|doesn't) have access to (?:the )?model\b/i;
const MODEL_CODE_PATTERN = /"code"\s*:\s*"(?:model_not_found|model_not_supported|model_unavailable|unsupported_model|invalid_model)"/;

/**
 * Only traverse diagnostic fields. Request bodies and arbitrary objects must
 * never be serialized into an error label just because a provider returned them.
 * @param {unknown} value
 * @param {number} depth
 * @param {Set<object>} seen
 * @returns {{message:string, modelAccess:boolean}|null}
 */
function diagnostic(value, depth = 0, seen = new Set()) {
  if (depth > 8) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    if (/^[{\["]/.test(text)) {
      try { return diagnostic(JSON.parse(text), depth + 1, seen); }
      catch { return null; }
    }
    return { message: text, modelAccess: MODEL_ACCESS_PATTERN.test(text) };
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || seen.has(value)) return null;
  seen.add(value);
  // EVIDENCE: Codex can wrap a provider's {error:{message,code}} payload in its
  // own error.message JSON string. Whitelist the same fields at each level.
  for (const field of ["error", "message", "result"]) {
    const found = diagnostic(value[field], depth + 1, seen);
    if (found) return { ...found, modelAccess: found.modelAccess || MODEL_CODES.has(value.code) };
  }
  return null;
}

/** Classify terminal diagnostics only; never call this on successful AI text. */
export function isModelAccessError(value) {
  const found = diagnostic(value);
  if (found?.modelAccess) return true;
  // Saved labels from older runs may have truncated an otherwise-valid JSON
  // payload. Classification can recognize it without displaying the raw body.
  return typeof value === "string" && (MODEL_ACCESS_PATTERN.test(value) || MODEL_CODE_PATTERN.test(value));
}

/**
 * Extract a readable provider diagnostic, without exposing its JSON transport.
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function workerErrorMessage(value, fallback = "The AI worker failed before finishing.") {
  const found = diagnostic(value);
  // Older terminal labels were cut before their JSON closed. Recognize only
  // the failure class; a partial transport body is never safe display text.
  if (!found) return isModelAccessError(value)
    ? `The selected model is not available for this account. ${MODEL_GUIDANCE}`
    : fallback;
  if (!found.modelAccess || found.message.includes(MODEL_GUIDANCE)) return found.message;
  return `${found.message} ${MODEL_GUIDANCE}`;
}
