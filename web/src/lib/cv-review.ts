import fs from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Whether a tailored CV's final-review receipt (`<pdf>.review.json`, written by
 * publish-cv.mjs through lib/cv-publication.mjs) still vouches for the file.
 *
 * The receipt pins the PDF, its HTML, the report and the payload by hash, plus
 * a hash of the career evidence the review ran against. When any of them moved
 * - the report was re-evaluated, the Context changed, the PDF was regenerated
 * without a review - the receipt is stale and the file is no longer a reviewed
 * CV, however fresh its mtime looks. Before this check, /api/apply/fill
 * attached such a file as if it were current.
 *
 * The rule itself is the core's assertCurrentCvReview, loaded from the code
 * checkout the way answer-bank.mjs is (`modulePath` is rootScript("lib/cv-publication"));
 * the web never re-implements it. A root whose checkout cannot run the check
 * reports why rather than passing the file, because "could not check" and
 * "checked and current" must not read the same.
 *
 * No `@/lib/career-ops` import here: career-ops.ts calls this from
 * pdfPathStatusForReport and passes its own root and script path, so the two
 * modules do not import each other.
 */
export type CvReviewStatus = { current: true } | { current: false; reason: string };

type CvPublicationModule = {
  assertCurrentCvReview(pdf: string, opts: { dataRoot: string; reportNum: string }): unknown;
};

export async function cvReviewStatus(pdfPath: string, reportNum: string, { dataRoot, modulePath }: { dataRoot: string; modulePath: string }): Promise<CvReviewStatus> {
  if (!fs.existsSync(`${pdfPath}.review.json`)) {
    return { current: false, reason: "no final-review receipt beside the PDF; publish it again" };
  }
  let mod: CvPublicationModule;
  try {
    mod = (await import(/* webpackIgnore: true */ pathToFileURL(modulePath).href)) as CvPublicationModule;
  } catch (e) {
    return { current: false, reason: `final-review check unavailable: ${e instanceof Error ? e.message.slice(0, 120) : "the core checkout could not be loaded"}` };
  }
  try {
    mod.assertCurrentCvReview(pdfPath, { dataRoot, reportNum });
    return { current: true };
  } catch (e) {
    const message = e instanceof Error ? e.message.replace(/^Final-PDF review is stale:\s*/i, "").replace(/\.\s*$/, "").trim() : "";
    return { current: false, reason: message || "final review is stale" };
  }
}
