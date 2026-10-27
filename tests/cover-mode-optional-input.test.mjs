import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const mode = fs.readFileSync(new URL('../modes/cover.md', import.meta.url), 'utf8');

test('cover mode drafts from Context and JD without mandatory questions or confirmations', () => {
  assert.match(mode, /## Step 6 — Optional direction/);
  assert.match(mode, /Do not wait for\s+brief answers/i);
  assert.doesNotMatch(mode, /All four answers are required|Wait for all four|Four prompts \(mandatory|Wait for confirmation|Wait for the user to confirm|Wait for the user's answers/);
  assert.match(mode, /unattended runs[\s\S]*draft from.*Context.*JD/i);
  assert.match(mode, /omit.*unsupported.*details/i);
});

test('cover mode defines a concise supported opening, evidence and close', () => {
  assert.match(mode, /200–300 words/);
  assert.match(mode, /three short paragraphs/);
  assert.match(mode, /one or two.*examples/i);
  assert.doesNotMatch(mode, /350-420|Select 4-5|at least one metric per bullet/);
  assert.match(mode, /Metrics are\s+optional/);
  assert.match(mode, /https:\/\/careerservices\.fas\.harvard\.edu\//);
});

test('optional direction preserves evidence, uncertainty, and explicit PDF approval boundaries', () => {
  assert.match(mode, /Run `node context-evidence.mjs` first/);
  assert.match(mode, /facts.*pages/i);
  assert.match(mode, /preferences.*never\s+supply evidence/is);
  assert.match(mode, /past.experience claims.*require.*evidence/is);
  assert.match(mode, /Do NOT generate any PDF until the user explicitly approves/);
  assert.match(mode, /Never submit, send, or attach/i);
  assert.match(mode, /user_inputs/);
});

test('PDF instructions keep current Context authoritative through the fact gate', () => {
  const pdf = mode.split('## Step 9 — Generate PDF')[1].split('## Step 10')[0];
  assert.match(pdf, /current Context facts pages/);
  assert.match(pdf, /only when no library exists/);
  assert.doesNotMatch(pdf, /Career evidence belongs in `cv\.md`/);
});
