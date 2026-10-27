import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// JUDGMENT: sample content keeps previews useful without reading career facts or
// spending AI tokens. The canonical CLI builder owns every template/partial rule.
const SAMPLE = {
  lang: "en", page_format: "a4",
  candidate: { name: "Alex Example", title: "Engineering Manager", email: "alex@example.com", location: "Berlin, Germany" },
  summary: "Engineering leader helping teams build reliable products. This is fictional sample content for comparing CV layouts.",
  competencies: ["People leadership", "Product delivery", "Software architecture"],
  experience: [
    { company: "Example Company", role: "Engineering Manager", dates: "2022 - Present", location: "Berlin", bullets: ["Led a product engineering team and supported professional development.", "Worked with product and design partners to deliver reliable customer experiences."] },
    { company: "Sample Studio", role: "Senior Software Engineer", dates: "2018 - 2022", bullets: ["Built web services and improved automated testing."] },
  ],
  education: [{ title: "Computer Science", org: "Example University", year: "2018" }],
  skills: [{ category: "Engineering", items: "TypeScript, Node.js, automated testing" }],
};

/** Render a real installed template with strictly synthetic content. */
export async function renderCvTemplatePreview({ codeRoot, template, style = {} }) {
  const [preferences, templates, theme, pdf, ats] = await Promise.all([
    import(/* webpackIgnore: true */ pathToFileURL(path.join(codeRoot, "lib/cv-template-preferences.mjs")).href),
    import(/* webpackIgnore: true */ pathToFileURL(path.join(codeRoot, "cv-templates.mjs")).href),
    import(/* webpackIgnore: true */ pathToFileURL(path.join(codeRoot, "theme-style.mjs")).href),
    import(/* webpackIgnore: true */ pathToFileURL(path.join(codeRoot, "generate-pdf.mjs")).href),
    import(/* webpackIgnore: true */ pathToFileURL(path.join(codeRoot, "ats-payload.mjs")).href),
  ]);
  if (typeof template !== "string" || !template.trim()) throw new Error("Choose a CV template.");
  const selected = templates.resolveTemplate("cv", template, { dir: path.join(codeRoot, "templates") });
  const normalized = preferences.validateCvStyle(style);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "career-cv-preview-"));
  try {
    const input = path.join(scratch, "sample.json");
    const output = path.join(scratch, "sample.html");
    const profile = path.join(scratch, "profile.yml");
    await fs.writeFile(profile, "{}\n", "utf8");
    await fs.writeFile(input, JSON.stringify(ats.payloadForTemplate(SAMPLE, selected)), "utf8");
    await execFileAsync(process.execPath, [path.join(codeRoot, "build-cv-html.mjs"), input, output, selected], {
      cwd: codeRoot, env: {
        ...process.env, CAREER_OPS_ROOT: scratch, CAREER_OPS_DATA_DIR: scratch,
        CAREER_OPS_PROFILE: profile, CAREER_OPS_TRACKER: path.join(scratch, "data/applications.md"),
      },
      timeout: 15_000, maxBuffer: 1_000_000,
    });
    const html = await pdf.inlineLocalFonts(theme.injectThemeStyle(await fs.readFile(output, "utf8"), theme.styleTokensFrom(normalized)));
    // EVIDENCE: generate-pdf.mjs applies --page-margin through @page. Browsers
    // ignore @page on screen, so give the sample the same paper inset explicitly.
    // Screen-only rules leave the canonical template and printed output intact.
    const pageStyle = '<style id="career-ops-preview-page">@media screen { body { box-sizing: border-box; min-height: 297mm; margin: 0; padding: var(--page-margin, 0.6in); } }</style>';
    const preview = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => `${pageStyle}\n</head>`) : `${pageStyle}\n${html}`;
    // EVIDENCE: iframe sandbox/CSP prevent template scripts, links and remote
    // resources from acting in the application origin (MDN iframe sandbox).
    return preview.replace(/<head([^>]*)>/i, '<head$1><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; font-src data:; img-src data:; base-uri \'none\'; form-action \'none\'">');
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
