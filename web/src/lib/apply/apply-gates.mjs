/**
 * apply-gates.mjs - the application-time gates the Apply flow checks before it
 * fills a form, in a plain .mjs so `node --test` can load them.
 *
 * A diagnostic of sent applications found three records nobody kept: 41 of 45
 * went out against an evaluation verdict other than Apply with no recorded
 * reason, 42 of 45 never recorded which CV file was uploaded, and no form
 * answer was stored at all. The gates here are the contract behind
 * /api/apply/fill and the Apply page: what counts as an Apply verdict, what an
 * override must carry, and the exact tracker-note text each record is written
 * as, so the note a later diagnostic parses is written by one function.
 */

/** Shortest reason that counts as an override (characters, trimmed). */
export const MIN_OVERRIDE_REASON = 12;

/** Longest note the gates write into the tracker's Notes cell. */
export const MAX_NOTE_LENGTH = 240;

/** Machine-readable refusal codes /api/apply/fill answers 409 with. */
export const GATE_CODES = Object.freeze({
  verdict: "verdict-override-required",
  stale: "cv-stale",
  unverifiedRole: "cv-unverified-role",
  noCv: "cv-not-found",
});

/**
 * The verdict as the Machine Summary spells it, folded for comparison:
 * "research_first", "Research first" and "RESEARCH-FIRST" are one value.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeDecision(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

/** True only for the one verdict that needs no reason: `final_decision: Apply`. */
export function isApplyVerdict(raw) {
  return normalizeDecision(raw) === "apply";
}

/**
 * A note value that cannot break the tracker row: one line, no pipes, bounded.
 * set-status.mjs applies its own cell() sanitiser too; this keeps the text the
 * gate reports back to the user identical to the text written.
 * @param {unknown} text
 * @returns {string}
 */
export function trackerNoteText(text, max = MAX_NOTE_LENGTH) {
  const oneLine = String(text ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s*\|\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}

/**
 * The verdict gate. An Apply verdict passes as it is. Anything else - Consider,
 * Research first, Skip, or a report with no readable final_decision - passes
 * only with an override reason of at least MIN_OVERRIDE_REASON characters,
 * and then carries the tracker note recording it.
 *
 * @param {{ decision?: unknown, overrideReason?: unknown, permit?: string | null }} input
 * @returns {{ ok: true, decision: string, override: false }
 *         | { ok: true, decision: string, override: true, reason: string, note: string }
 *         | { ok: false, decision: string, code: string, error: string }}
 */
export function verdictGate({ decision, overrideReason, permit = null } = {}) {
  const verdict = String(decision ?? "").trim();
  const permitOpen = typeof permit === "string" && permit.trim() ? permit.trim() : null;
  if (isApplyVerdict(verdict) && !permitOpen) return { ok: true, decision: verdict, override: false };
  const reason = typeof overrideReason === "string" ? trackerNoteText(overrideReason, MAX_NOTE_LENGTH) : "";
  const shown = verdict || "missing";
  if (reason.length < MIN_OVERRIDE_REASON) {
    let error;
    if (permitOpen && isApplyVerdict(verdict)) error = `A work-permit question is open for this role (${permitOpen}). Ask the recruiter first, or give a reason of at least ${MIN_OVERRIDE_REASON} characters to apply anyway; it is recorded in the tracker.`;
    else if (verdict) error = `The evaluation verdict is "${shown}", not Apply. Give a reason of at least ${MIN_OVERRIDE_REASON} characters to apply anyway; it is recorded in the tracker.`;
    else error = `This report has no readable final_decision. Give a reason of at least ${MIN_OVERRIDE_REASON} characters to apply anyway; it is recorded in the tracker.`;
    return { ok: false, decision: verdict, code: GATE_CODES.verdict, error };
  }
  return { ok: true, decision: verdict, override: true, reason, note: overrideNote(reason, verdict, permitOpen) };
}

/**
 * `override: <reason> (verdict <final_decision>)`, the note a later diagnostic
 * parses; `; permit question open` is appended inside the parenthesis when the
 * override also waives an unanswered work-permit question.
 */
export function overrideNote(reason, decision, permit = null) {
  const tail = typeof permit === "string" && permit.trim() ? "; permit question open" : "";
  return trackerNoteText(`override: ${reason} (verdict ${String(decision ?? "").trim() || "missing"}${tail})`, MAX_NOTE_LENGTH + 80);
}

/**
 * `cv: <basename> sha256:<first 12 hex> report:<n>` - which file went out, for
 * which requisition. `report` is the report number, or "unknown" when the fill
 * had none (a confirmed upload always has one).
 * @param {{ file: string, sha256: string, report?: string | number | null }} input
 */
export function cvProvenanceNote({ file, sha256, report }) {
  const base = String(file ?? "").split(/[\\/]/).pop() || "cv.pdf";
  const hash = String(sha256 ?? "").toLowerCase().slice(0, 12);
  const n = report === null || report === undefined || String(report).trim() === "" ? "unknown" : String(report).trim();
  return trackerNoteText(`cv: ${base} sha256:${hash} report:${n}`);
}

/** A parsed `override:` or `cv:` note, for the diagnostic that reads them back. */
export function parseGateNote(note) {
  const text = String(note ?? "").trim();
  const override = /^override:\s*(.+?)\s*\(verdict\s+([^);]*?)\s*(;\s*permit question open)?\)$/i.exec(text);
  if (override) return { kind: "override", reason: override[1], decision: override[2].trim(), permit: !!override[3] };
  const cv = /^cv:\s*(\S+)\s+sha256:([0-9a-f]{6,64})\s+report:(\S+)$/i.exec(text);
  if (cv) return { kind: "cv", file: cv[1], sha256: cv[2], report: cv[3] === "unknown" ? null : cv[3] };
  return null;
}

/**
 * Every `override:` and `cv:` note inside a tracker Notes cell. set-status.mjs
 * appends notes with "; ", so a real cell reads "job id 123; Re-eval …; cv: …;
 * override: …" and parseGateNote alone, anchored to the whole string, finds
 * nothing in it. The override reason itself never contains "; " (trackerNoteText
 * folds it), so the split is safe.
 */
export function parseGateNotes(cell) {
  return String(cell ?? "").split(/;\s+/).map(parseGateNote).filter(Boolean);
}

/**
 * Whether a fill may attach the CV it resolved, from the resolution the server
 * produced (resolveSessionCv / resolveConfirmedCv in cv.ts). Pure, so the
 * decision the route makes and the one the page previews are the same rule.
 *
 * @param {{ status: string, path?: string, reason?: string, report?: string | null }} cv
 * @param {{ confirmReport?: unknown }} [input]
 * @returns {{ attach: true, path: string, report: string | null }
 *         | { attach: false, code: string | null, error: string | null }}
 */
export function attachDecision(cv, { confirmReport } = {}) {
  const confirmed = typeof confirmReport === "string" && /^\d{1,6}$/.test(confirmReport.trim());
  if (!cv || cv.status === "none") {
    // The user named the report whose CV to attach and it has none: refuse,
    // rather than quietly sending the application with no CV. Filling without
    // one is the explicit `skipCv` choice, which the route resolves before this.
    if (confirmed) return { attach: false, code: GATE_CODES.noCv, error: `Report ${confirmReport.trim()} has no indexed tailored CV${cv?.reason ? ` (${cv.reason})` : ""}. Generate it, or tick "Fill without attaching a CV".` };
    return { attach: false, code: null, error: null };
  }
  if (cv.status === "ready") return { attach: true, path: cv.path, report: cv.report ?? null };
  if (cv.status === "stale") {
    return {
      attach: false,
      code: GATE_CODES.stale,
      error: `The tailored CV is stale (${cv.reason || "its final review no longer matches"}). Regenerate it before filling this form.`,
    };
  }
  if (cv.status === "unverified-role") {
    return {
      attach: false,
      code: GATE_CODES.unverifiedRole,
      error: confirmed
        ? `Report ${confirmReport.trim()} has no indexed tailored CV, so nothing can be attached.`
        : "This CV was matched by company name only, so it is not known which requisition it targets. Confirm the report number of the CV to attach.",
    };
  }
  return { attach: false, code: null, error: null };
}
