import fs from 'node:fs';import path from 'node:path';
import { reviewReceipt } from '../../lib/cv-publication.mjs';

// A receipt fixture for tracker bookkeeping tests; PDF extraction has separate
// real-Chromium integration coverage. This deliberately does not simulate a parser.
export function reviewedCvFixture(root, reportNum, pdfPath = path.join(root, 'output', `${reportNum}.pdf`), { payload = {} } = {}) {
  fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  const html = `${pdfPath}.html`, payloadFile = `${pdfPath}.payload.json`, reportFile = path.join(root, 'reports', `${reportNum}-fixture.md`);
  fs.writeFileSync(pdfPath, '%PDF-1.7\nFixture for tracker bookkeeping');
  fs.writeFileSync(html, '<p>Example work</p>');fs.writeFileSync(payloadFile, JSON.stringify(payload));fs.writeFileSync(reportFile, '# Fixture job description\n');
  const receipt = reviewReceipt({ pdf: pdfPath, html, payloadFile, reportFile, dataRoot: root, reportNum, review: { pages: [{ page: 1, words: 100 }], textSha256: 'fixture' }, gaps: [] });
  fs.writeFileSync(`${pdfPath}.review.json`, JSON.stringify(receipt));
  return { pdf: pdfPath, html, payloadFile, reportFile };
}
