export const OPEN_MARK = "<<cv-json>>";
export const CLOSE_MARK = "<</cv-json>>";
const MAX_OUTPUT = 256_000;

export const CV_PAYLOAD_INSTRUCTION = `Do NOT save or edit any file. Emit compact JSON in the build-cv-html.mjs schema supplied below, between marker lines containing only \`${OPEN_MARK}\` and \`${CLOSE_MARK}\`. Emit exactly one envelope. Set page_format to a4 or letter using the supplied profile setting and job market. Do not emit HTML, CSS, Markdown fences, narration, a score, a VERDICT, or a success claim. The backend builds the selected template, checks facts, renders the PDF and reports the outcome.`;

/** @typedef {{ok:true,payload:Record<string,any>,format:'a4'|'letter',warnings:string[]}} CvPayloadEnvelope */

/** @returns {CvPayloadEnvelope | {ok:false,error:string}} */
export function parseCvPayloadEnvelope(text) {
  if (typeof text !== "string" || text.length > MAX_OUTPUT) return { ok: false, error: "CV JSON output is missing or exceeds its size limit." };
  const normalized = text.replace(/\r\n/g, "\n");
  const openers = [...normalized.matchAll(/^<<cv-json>>[ \t]*$/gm)];
  const closers = [...normalized.matchAll(/^<<\/cv-json>>[ \t]*$/gm)];
  if (openers.length !== 1 || closers.length !== 1 || closers[0].index <= openers[0].index) {
    return { ok: false, error: "Expected exactly one complete <<cv-json>> envelope." };
  }
  try {
    const payload = JSON.parse(normalized.slice(openers[0].index + openers[0][0].length, closers[0].index));
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !payload.candidate?.name?.trim()) {
      return { ok: false, error: "CV JSON must be an object with candidate.name." };
    }
    if (payload.page_format !== "a4" && payload.page_format !== "letter") return { ok: false, error: "CV JSON must choose page_format a4 or letter." };
    return { ok: true, payload, format: payload.page_format, warnings: [] };
  } catch {
    return { ok: false, error: "The CV envelope contains invalid JSON." };
  }
}

/** Hold all draft output; only the backend may announce verified PDF success. */
export function createCvPayloadEnvelopeFilter() {
  let raw = "";
  let oversized = false;
  return {
    push(chunk) {
      if (!oversized) {
        raw += String(chunk ?? "");
        oversized = raw.length > MAX_OUTPUT;
        if (oversized) raw = "";
      }
      return "";
    },
    flush: () => "",
    result: () => oversized ? { ok: /** @type {const} */ (false), error: "CV JSON output exceeds its size limit." } : parseCvPayloadEnvelope(raw),
  };
}
