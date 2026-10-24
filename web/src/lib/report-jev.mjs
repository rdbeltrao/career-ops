/**
 * report-jev.mjs — the Jev pre-screen of an evaluated posting, read back from
 * what the pipeline already stores.
 *
 * Jev is the typed decision model every posting goes through before an agent
 * ever reads it (jev-rank.mjs, or the feeder that wrote the row). Its verdict
 * is the single source of truth for whether a posting deserves an evaluation;
 * the A-G report's 1-5 score is the agent's reading of fit on top of it. The
 * tracker (data/applications.md) has no Jev column, so a tracker row learns its
 * Jev from two places:
 *
 *  - the report header line the evaluation writes, e.g.
 *    `**Jev:** 3.7/5 (fit 68, maybe)` — Jev's own 1-5, the 0-100 fit and the verdict;
 *  - the posting's `jev:` segment in data/pipeline.md (`jev: 68 maybe — seniority
 *    match, location yes, …`), which carries the reasons.
 *
 * Plain .mjs with no I/O so `node --test` exercises the real parsers; the
 * file reads stay in career-ops.ts.
 */

const VERDICTS = new Set(["apply", "maybe", "skip"]);
const JEV_LINE = /^\*\*Jev:\*\*[ \t]*(.+)$/m;
const URL_LINE = /^\*\*URL:\*\*[ \t]*(\S+)/m;

/**
 * Parse the value of a report's `**Jev:**` header line.
 * Accepts `3.7/5 (fit 68, maybe)`, `fit 68, maybe`, `68 maybe` and the same
 * with the verdict first; null when neither a fit nor a verdict is readable.
 *
 * @param {string | null | undefined} value
 * @returns {{ fit: number | null, score: number | null, verdict: "apply" | "maybe" | "skip" | null } | null}
 */
export function parseJevField(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const scoreMatch = text.match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
  const fitMatch = text.match(/fit\s*[:=]?\s*(\d{1,3})/i) || text.match(/(?:^|[\s(])(\d{1,3})(?=\s*(?:,|\s)\s*(?:apply|maybe|skip)\b)/i);
  const verdictMatch = text.match(/\b(apply|maybe|skip)\b/i);
  const fit = fitMatch ? Number(fitMatch[1]) : null;
  const verdict = verdictMatch ? verdictMatch[1].toLowerCase() : null;
  if (fit === null && !verdict) return null;
  return {
    fit: fit !== null && fit >= 0 && fit <= 100 ? fit : null,
    score: scoreMatch ? Number(scoreMatch[1]) : null,
    verdict: verdict && VERDICTS.has(verdict) ? /** @type {"apply"|"maybe"|"skip"} */ (verdict) : null,
  };
}

/**
 * The Jev header and posting URL of a report, from its first lines.
 * @param {string | null | undefined} head - The report's leading text (the header is within the first ~20 lines).
 * @returns {{ url: string | null, jev: ReturnType<typeof parseJevField> }}
 */
export function readJevHead(head) {
  const text = String(head ?? "");
  const url = text.match(URL_LINE)?.[1] ?? null;
  const jev = parseJevField(text.match(JEV_LINE)?.[1]);
  return { url: url && /^https?:\/\//i.test(url) ? url : null, jev };
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
 * @param {(row: Row) => string | null} readHead - The report's leading text for a row, null when unreadable.
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
    const { url, jev } = readJevHead(head);
    const postingUrl = url ?? firstHttpUrl(app.url);
    const fromInbox = postingUrl ? byUrl.get(key(postingUrl)) : undefined;
    if (!jev && !fromInbox) return { ...app, jev: null };
    const verdict = jev?.verdict ?? (fromInbox && VERDICTS.has(fromInbox.verdict) ? fromInbox.verdict : null);
    return {
      ...app,
      jev: {
        fit: jev?.fit ?? fromInbox?.fit ?? null,
        score: jev?.score ?? null,
        verdict,
        reasons: fromInbox?.reasons ?? "",
      },
    };
  });
}

function firstHttpUrl(cell) {
  const m = String(cell ?? "").match(/https?:\/\/[^\s)|]+/);
  return m ? m[0] : null;
}
