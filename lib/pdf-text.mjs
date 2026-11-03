/** Text extraction for archived PDFs, including synchronous CLI consumers. */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main-module.mjs';

export async function extractPdfText(file) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
  try {
    const document = await task.promise;
    const pages = [];
    for (let i = 1; i <= document.numPages; i++) {
      const { items } = await (await document.getPage(i)).getTextContent();
      pages.push(items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : ' ')).join(''));
    }
    const text = pages.join('\n\n').trim();
    if (!text) throw new Error('The archived PDF has no extractable text; provide a text job description.');
    return text;
  } finally { await task.destroy(); }
}

export function readPdfTextSync(file) {
  try {
    return execFileSync(process.execPath, [fileURLToPath(import.meta.url), file], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`Could not extract the archived PDF job description: ${String(error.stderr || error.message).trim()}`, { cause: error });
  }
}

if (isMainModule(import.meta.url)) {
  const file = process.argv[2];
  if (file === '--help' || file === '-h') {
    console.log('Usage: node lib/pdf-text.mjs <file.pdf>\nExtract archived PDF text to stdout.');
  } else {
    extractPdfText(file).then(text => process.stdout.write(text)).catch(error => {
      console.error(error.message); process.exitCode = 1;
    });
  }
}
