import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-ops-visual-pdf-'));
for (const directory of ['output', 'data', 'reports', 'modes']) fs.mkdirSync(path.join(root, directory));
fs.writeFileSync(path.join(root, '.visual-pdf-fixture'), 'fictional-only\n');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page {size:letter; margin:40pt} body{font:12pt Arial;color:#172434} h1{font-size:26pt;margin-bottom:8pt}
.section{margin-top:24pt}.section-title{font-size:15pt;font-weight:bold;border-bottom:1px solid #aab9c8;padding-bottom:5pt;margin-bottom:12pt}
.job-header{font-weight:bold} li{margin-top:14pt} p{margin-top:14pt} .next-page{break-before:page}
.role-summary{font:italic 10.5px "Helvetica Neue",Arial;line-height:1.55;text-align:justify;width:500px}
</style></head><body><h1>Fictional Candidate</h1><p>Fictional test CV — no personal data</p>
<div class="section"><div class="section-title">Professional Summary</div><p>Engineering leader building reliable products.</p></div>
<div class="section"><div class="section-title">Work Experience</div><div class="job"><div class="job-header"><span class="job-company">Fixture Alpha</span></div><p class="role-summary">Lead engineering across web and mobile products, working with <b>design teams</b> to improve delivery and build reliable services.</p><ul><li>Built reliable services with the product team.</li><li>Improved delivery practices across engineering.</li></ul></div></div>
<div class="section next-page"><div class="section-title">Education</div><p>Fictional education entry for a browser test.</p></div></body></html>`;
fs.writeFileSync(path.join(root, 'output/cv-fixture-alpha.html'), html);
fs.writeFileSync(path.join(root, 'cv.md'), '# Fictional Candidate\n\n## Summary\nEngineering leader building reliable products.\n\n## Experience\n### Fixture Alpha\n- Built reliable services with the product team.\n- Improved delivery practices across engineering.\n');
fs.writeFileSync(path.join(root, 'modes/_context.md'), '# Fictional candidate\n\nEngineering leader building reliable products. Built reliable services with the product team. Improved delivery practices across engineering.\n');
fs.writeFileSync(path.join(root, 'reports/011-fixture-alpha-2026-10-25.md'), '# Offer: Fixture Alpha — Engineer\n\nFictional report. Engineering leadership and reliable products.\n');
fs.writeFileSync(path.join(root, 'data/applications.md'), '# Fictional browser fixture\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 11 | 2026-10-25 | Fixture Alpha | Engineer | 4.2/5 | Evaluated | ✅ | [11](../reports/011-fixture-alpha-2026-10-25.md) | Fictional fixture only |\n');
fs.writeFileSync(path.join(root, 'data/pdf-index.tsv'), '# report\tpdf\thtml\tformat\tdate\tkind\n011\toutput/cv-fixture-alpha.pdf\toutput/cv-fixture-alpha.html\tletter\t2026-10-25\tcv\n');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(html);
  await page.pdf({ path: path.join(root, 'output/cv-fixture-alpha.pdf'), preferCSSPageSize: true });
} finally { await browser.close(); }
console.log(root);
