/**
 * answers-save.mjs - the request contract of /api/apply/answers.
 *
 * Plain .mjs with no imports so `node --test` can load it. The route writes into
 * a report and the user's data root, so every value it takes from the request is
 * checked here first; the route itself only resolves files and calls the core's
 * writers (application-answers.mjs and answer-bank.mjs).
 */

export const MAX_FIELDS = 300;
const STATES = new Set(["filled", "submitted"]);

function optionalString(body, key) {
  const v = body[key];
  if (v === undefined || v === null) return { ok: true, value: "" };
  if (typeof v !== "string") return { ok: false, error: `${key} must be a string` };
  return { ok: true, value: v.trim() };
}

/**
 * @param {unknown} body
 * @returns {{ ok: true, value: { state: "filled"|"submitted", application: string, company: string, title: string, url: string, sessionId: string, fields: {id: string, type: string, label: string}[], answers: Record<string, string> } } | { ok: false, error: string }}
 */
export function parseSaveBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad json" };
  const b = /** @type {Record<string, unknown>} */ (body);
  if (typeof b.state !== "string" || !STATES.has(b.state)) return { ok: false, error: "state must be filled or submitted" };

  const out = { state: b.state };
  for (const key of ["application", "company", "title", "url", "sessionId"]) {
    const r = optionalString(b, key);
    if (!r.ok) return r;
    out[key] = r.value;
  }
  if (out.application && !/^\d{1,6}$/.test(out.application)) return { ok: false, error: "application must be a tracker number" };
  if (out.url && !/^https?:\/\//i.test(out.url)) return { ok: false, error: "url must be http(s)" };

  const fields = b.fields;
  if (!Array.isArray(fields) || fields.length > MAX_FIELDS) return { ok: false, error: `fields must be an array of at most ${MAX_FIELDS}` };
  for (const f of fields) {
    if (!f || typeof f !== "object" || typeof f.id !== "string" || typeof f.type !== "string" || typeof (f.label ?? "") !== "string") {
      return { ok: false, error: "fields must be {id, type, label} objects" };
    }
  }
  const answers = b.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return { ok: false, error: "answers must be an object" };
  for (const v of Object.values(answers)) {
    if (typeof v !== "string") return { ok: false, error: "answers must map field ids to strings" };
  }
  return { ok: true, value: { ...out, fields, answers } };
}

/**
 * The company a save or a prefill is about. The tracker row's own company wins
 * over what the client sent, because the page sends the display label
 * (companyPresentation): every row with an unknown employer would otherwise be
 * banked as "Confidential employer" and look like one company. An unknown
 * employer ("?") is no company at all: no history, no same-company match.
 *
 * @param {{ trackerCompany?: string, clientCompany?: string }} input
 * @returns {string}
 */
export function resolveCompany({ trackerCompany, clientCompany } = {}) {
  const raw = trackerCompany !== undefined && trackerCompany !== null ? trackerCompany : clientCompany;
  const name = String(raw ?? "").trim();
  return name === "?" ? "" : name;
}
