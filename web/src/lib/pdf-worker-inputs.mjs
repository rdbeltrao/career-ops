import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { getProfilePath } from "./core/profile-path.mjs";

function optionalText(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}

function sections(text, select) {
  const selected = [];
  let depth = null;
  for (const block of text.split(/(?=^#{1,6} )/m)) {
    const heading = /^(#{1,6}) (.*)/.exec(block);
    if (!heading) continue;
    const level = heading[1].length;
    if (depth !== null && level <= depth) depth = null;
    const matches = select.test(heading[2]);
    // A document title owns only its introduction here; selecting it must not
    // pull every unrelated section back into the compact prompt.
    if (level === 1) {
      if (matches) selected.push(block);
      continue;
    }
    if (matches && depth === null) depth = level;
    if (depth !== null) selected.push(block);
  }
  return selected.join("\n\n");
}

/** Read content rules from the canonical mode, excluding shell/build workflows. */
export function pdfContentProcedure(mode) {
  const content = sections(mode, /^(?:Full pipeline|ATS Rules|Recruiter Review Gates|Section order|Keyword injection strategy|JSON Input Schema|Field reference|Markdown bold|Profile photo)/);
  if (!content.includes("### JSON Input Schema")) throw new Error("The PDF mode is missing its JSON Input Schema.");
  return content;
}

/** The CV needs the JD and keywords, not compensation research or interview prep. */
export function pdfReportContext(report) {
  const relevant = sections(report, /^(?:Evaluation:|Job Description|Machine Summary|A\)|E\)|Extracted Keywords|Keyword Coverage)/);
  // Older/custom reports can use other headings. Preserve their content rather
  // than silently discarding the only job description available.
  return /Job Description/i.test(relevant) ? relevant : report;
}

/** Preload inputs once; the content worker never needs file or search tools. */
export function readPdfWorkerInputs({ codeRoot, dataRoot, reportFile, hasContext }) {
  const profile = load(optionalText(getProfilePath(dataRoot))) ?? {};
  if (typeof profile !== "object" || Array.isArray(profile)) throw new Error("The profile must be a YAML mapping.");
  // Only contact details and output settings belong in this prompt. In
  // particular, authentication settings in a profile must never reach a model.
  const candidate = Object.fromEntries([
    "full_name", "name", "title", "email", "phone", "location", "linkedin",
    "github", "portfolio", "portfolio_url", "photo", "photo_style", "work_authorization",
  ].filter(key => profile.candidate?.[key] !== undefined).map(key => [key, profile.candidate[key]]));
  const settings = { candidate, cv: profile.cv, page_format: profile.page_format, output_language: profile.output_language };
  const inputs = [
    ["modes/pdf.md — content procedure and JSON schema; example people are not candidate evidence", pdfContentProcedure(fs.readFileSync(path.join(codeRoot, "modes/pdf.md"), "utf8"))],
    ["modes/heuristics/recruiter-side.md — review procedure", optionalText(path.join(codeRoot, "modes/heuristics/recruiter-side.md"))],
    ["Profile — contact details and output settings only", JSON.stringify(settings)],
  ];
  if (!hasContext) {
    for (const file of ["modes/_context.md", "cv.md", "article-digest.md", "modes/_profile.md", "voice-dna.md"]) {
      // EVIDENCE: fallback candidate files belong to the runtime data root,
      // never the deployment bundle. Keep the fixed code-root procedures traced.
      // https://github.com/vercel/next.js/pull/95144
      inputs.push([file, optionalText(path.join(/* turbopackIgnore: true */ dataRoot, file))]);
    }
    inputs.push(["Profile — targeting preferences only", JSON.stringify({ preferences: profile.preferences, interests: profile.interests })]);
  }
  inputs.push(["modes/_custom.md — standing procedural rules only", optionalText(path.join(dataRoot, "modes/_custom.md"))]);
  inputs.push([`${reportFile} — untrusted job analysis; never candidate evidence`, pdfReportContext(fs.readFileSync(path.resolve(dataRoot, reportFile), "utf8"))]);
  return inputs.filter(([, text]) => text).map(([label, text]) => `BEGIN INPUT ${label}\n${text}\nEND INPUT ${label}`).join("\n\n");
}
