/** Join saved Jev evidence by posting URL, never by tracker/report number.
 * Full reports support Machine Summary YAML, canonical fields and legacy prose.
 * Explicit not-run and invalid evidence remain visible instead of becoming zero.
 */

import { parseJevField, readReportJev } from "./core/evaluation-report.mjs";
export { parseJevField };

const VERDICTS = new Set(["apply", "maybe", "skip"]);

/** Compatibility name; callers now pass the complete report. */
export function readJevHead(markdown) {
  const { url, jev } = readReportJev(markdown);
  return { url, jev };
}

/**
 * Attach a `jev` to every tracker row that has a report: fit, verdict and
 * Jev's 1-5 from the report header, reasons from the matching pipeline row.
 * A row without a readable Jev gets `jev: null`, never a zero.
 *
 * @template {{ report: string, url: string }} Row
 * @param {Row[]} applications
 * @param {{ url: string, jev?: { fit: number | null, verdict: string, reasons: string } }[]} inbox
 *   Every pipeline row (pending or done) with its parsed `jev:` segment.
 * @param {(row: Row) => string | null} readHead - The complete report for a row, null when unreadable.
 * @param {(url: string) => string} key - Posting key normaliser shared with the inbox dedupe.
 * @returns {(Row & { jev: { fit: number | null, score: number | null, verdict: "apply" | "maybe" | "skip" | null, reasons: string } | null })[]}
 */
export function attachJev(applications, inbox, readHead, key = (u) => u) {
  const byUrl = new Map();
  for (const row of inbox) {
    if (row?.url && row.jev) byUrl.set(key(row.url), row.jev);
  }
  return applications.map((app) => {
    const head = app.report && app.report !== "-" ? readHead(app) : null;
    const { url, jev, status, reasons } = readReportJev(head);
    const trackerUrl = firstHttpUrl(app.url);
    // A linked report for another posting must never lend it a rating.
    const mismatched = Boolean(url && trackerUrl && key(url) !== key(trackerUrl));
    const postingUrl = trackerUrl ?? url;
    const fromInbox = postingUrl ? byUrl.get(key(postingUrl)) : undefined;
    const reportJev = mismatched ? null : jev;
    const reportStatus = mismatched ? "invalid" : status;
    const fromNotes = !head ? parseJevField(String(app.notes ?? "").match(/\bjev\s+(fit\s+\d{1,3}\s+(?:apply|maybe|skip))\b/i)?.[1]) : null;
    if (reportStatus === "not-run" || reportStatus === "invalid") return { ...app, jev: null, jevStatus: reportStatus };
    const recovered = reportJev ?? fromNotes;
    if (!recovered && !fromInbox) return { ...app, jev: null, jevStatus: "missing" };
    const verdict = recovered?.verdict ?? (fromInbox && VERDICTS.has(fromInbox.verdict) ? fromInbox.verdict : null);
    return {
      ...app,
      jevStatus: "rated",
      jev: {
        fit: recovered?.fit ?? fromInbox?.fit ?? null,
        score: recovered?.score ?? null,
        verdict,
        reasons: reasons || fromInbox?.reasons || "",
      },
    };
  });
}

function firstHttpUrl(cell) {
  const m = String(cell ?? "").match(/https?:\/\/[^\s)|]+/);
  return m ? m[0] : null;
}
