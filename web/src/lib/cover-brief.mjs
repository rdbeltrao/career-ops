/**
 * cover-brief.mjs — the cover letter request a web user sends from the report page.
 *
 * Context and the job description supply the drafting inputs. The candidate
 * may add direction, but an empty brief must not prevent a draft.
 */
import path from "node:path";
import { COVER_TONES } from "./cover-tones.mjs";

export { COVER_TONES };

const MAX_INSTRUCTIONS = 3000;

/**
 * @typedef {{instructions: string}} CoverBrief
 */

/**
 * @param {{input: string, brief: unknown, root: string, findReportFile: (n: string) => string | null}} args
 * @returns {{ok: true, reportFile: string, brief: CoverBrief} | {ok: false, error: string}}
 */
export function parseCoverRequest({ input, brief, root, findReportFile }) {
  if (typeof input !== "string") {
    return { ok: false, error: "Invalid report selector: expected a report number string." };
  }
  if (!/^\d+$/.test(input)) return { ok: false, error: `Invalid report selector: "${input}"` };

  if (brief != null && (typeof brief !== "object" || Array.isArray(brief))) {
    return { ok: false, error: "Invalid cover letter brief: expected an object." };
  }
  const rawInstructions = brief?.instructions;
  if (rawInstructions !== undefined && typeof rawInstructions !== "string") {
    return { ok: false, error: "Additional instructions must be text." };
  }
  const instructions = (rawInstructions ?? "").trim();
  // JUDGMENT: one prompt keeps the former three answers' combined space.
  if (instructions.length > MAX_INSTRUCTIONS) return { ok: false, error: `Keep additional instructions to ${MAX_INSTRUCTIONS} characters or fewer.` };

  const reportFile = findReportFile(input);
  if (!reportFile) return { ok: false, error: `No report #${input} found. Evaluate this posting first.` };

  return {
    ok: true,
    reportFile: path.relative(root, reportFile).split(path.sep).join("/"),
    brief: { instructions },
  };
}
