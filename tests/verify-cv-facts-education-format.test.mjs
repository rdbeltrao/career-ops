import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { verifyFacts } from '../verify-cv-facts.mjs';

test('education punctuation and focus phrasing do not change a supported degree', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'education-facts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'cv.md');
  fs.writeFileSync(source, '**BSc, Computer Sciences with a focus on Software Engineering** — Example University.');
  const verify = title => verifyFacts(`<div class="edu-title">${title}</div>`, { dataRoot: root, sourcePaths: [source], configPath: path.join(root, 'absent.json') });
  for (const title of ['BSc Computer Sciences (focus on Software Engineering)', 'BSc, Computer Sciences with a focus on Software Engineering', 'BSc Computer Sciences']) {
    assert.equal(verify(title).verdict, 'pass', title);
  }
  for (const title of ['MSc Computer Sciences (focus on Software Engineering)', 'BSc Computer Sciences (focus on Data Science)', 'BSc Computer Arts', 'Other University']) {
    assert.equal(verify(title).verdict, 'block', title);
  }
  assert.equal(verifyFacts('<div class="job-company">BSc Computer Sciences (focus on Software Engineering)</div>', { dataRoot: root, sourcePaths: [source], configPath: path.join(root, 'absent.json') }).verdict, 'block', 'education normalization never applies to employer names');
});
