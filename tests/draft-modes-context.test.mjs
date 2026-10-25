// tests/draft-modes-context.test.mjs — the draft modes read the candidate
// context and the writing layer carries the outreach rules.
//
// Three things pinned, one per task of the drafts track:
//
//   C1  modes/_writing.md has the outreach and comment rules and the interests
//       rule; templates/outreach.md and templates/posts.md ship the message and
//       post structures, and neither template carries an email address or a
//       phone number (they are structures, not anyone's facts).
//   C2  cover, email, contacto, interview-prep and followup name
//       modes/_context.md; contacto builds its messages from
//       templates/outreach.md.
//   C3  apply classifies form fields (knockout-prone among them) and reads
//       data-static/ats-notes.md, which has a row per documented ATS.
//
// Run:  node --test tests/draft-modes-context.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8').replace(/\r\n/g, '\n');
const hasHeading = (text, heading) => new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(text);

// ── C1: writing layer ───────────────────────────────────────────────────────

test('_writing.md carries the outreach and comment rules', () => {
  const writing = read('modes/_writing.md');
  assert.ok(hasHeading(writing, '## Outreach and comment rules'), 'missing ## Outreach and comment rules');
  const section = writing.split('## Outreach and comment rules')[1].split('\n## ')[0];
  for (const rule of ['90 to 140 words', '300 characters', 'one number', 'i hope this finds you well', 'current employer']) {
    assert.ok(section.toLowerCase().includes(rule), `outreach rules do not mention "${rule}"`);
  }
  assert.match(section, /never ask for a job/i);
});

test('_writing.md carries the interests rule with the staleness gate', () => {
  const writing = read('modes/_writing.md');
  assert.ok(hasHeading(writing, '## Interests in candidate-facing text'), 'missing ## Interests in candidate-facing text');
  const section = writing.split('## Interests in candidate-facing text')[1].split('\n## ')[0];
  for (const token of ['modes/_context.md', 'config/profile.yml', 'interests', 'confirmed_on', 'render-context.mjs', '90 days']) {
    assert.ok(section.includes(token), `interests rule does not mention "${token}"`);
  }
  assert.match(section, /the source of truth about the candidate/, 'the context file must be named as the source of truth about the candidate');
  assert.match(section, /preference, deal-breaker and match-signal sections are \*\*targeting only\*\*/, 'the preference sections must stay targeting only');
  assert.match(section, /held for confirmation, approximate, conflicting or "not a claim"/, 'a figure the context flags must stay out of candidate-facing text');
  assert.ok(!/never supplies a fact, a number or a claim/.test(section), 'the drafts may take facts from the context file now');
});

test('templates/outreach.md has the four message structures', () => {
  const outreach = read('templates/outreach.md');
  for (const heading of ['## Recruiter or hiring manager', '## Referral', '## Networking', '## Connection note']) {
    assert.ok(outreach.includes(heading), `templates/outreach.md is missing "${heading}"`);
  }
});

test('templates/posts.md has the comment shapes, the repost and the Open to work post', () => {
  const posts = read('templates/posts.md');
  for (const heading of ['## Comment shapes', '## Repost with a take', '## Open to work post']) {
    assert.ok(posts.includes(heading), `templates/posts.md is missing "${heading}"`);
  }
  const shapes = posts.split('## Comment shapes')[1].split('\n## ')[0];
  for (const shape of ['experience', 'counterpoint', 'concrete example', 'question']) {
    assert.ok(shapes.toLowerCase().includes(shape), `comment shapes do not include "${shape}"`);
  }
});

test('the templates carry no email address or phone number', () => {
  for (const rel of ['templates/outreach.md', 'templates/posts.md']) {
    const text = read(rel);
    assert.ok(!text.includes('@'), `${rel} contains "@"`);
    assert.ok(!text.includes('+49'), `${rel} contains "+49"`);
  }
});

// ── C2: draft modes read the context ────────────────────────────────────────

const DRAFT_MODES = ['modes/cover.md', 'modes/email.md', 'modes/contacto.md', 'modes/interview-prep.md', 'modes/followup.md'];

for (const rel of DRAFT_MODES) {
  test(`${rel} reads modes/_context.md and the interests block`, () => {
    const text = read(rel);
    assert.ok(text.includes('modes/_context.md'), `${rel} does not name modes/_context.md`);
    assert.ok(text.includes('interests'), `${rel} does not name the interests block`);
    assert.ok(text.includes('modes/_writing.md'), `${rel} does not name modes/_writing.md`);
  });
}

test('contacto.md builds its messages from templates/outreach.md and has the referral and networking variants', () => {
  const text = read('modes/contacto.md');
  assert.ok(text.includes('templates/outreach.md'), 'contacto.md does not name templates/outreach.md');
  for (const heading of ['## Referral variant', '## Networking variant']) {
    assert.ok(text.includes(heading), `contacto.md is missing "${heading}"`);
  }
  // The existing variants and personas stay: other suites pin them.
  for (const kept of ['## LinkedIn power move (default)', '## Greeting variant', 'Internal Referral', 'contact-lookup.mjs']) {
    assert.ok(text.includes(kept), `contacto.md lost "${kept}"`);
  }
});

test('contacto.md applies the outreach rules from _writing.md', () => {
  const text = read('modes/contacto.md');
  assert.ok(text.includes('Outreach and comment rules'), 'contacto.md does not point at the outreach rules');
});

// ── C3: application field classes and ATS notes ─────────────────────────────

test('apply.md classifies form fields and reads the ATS notes', () => {
  const apply = read('modes/apply.md');
  assert.ok(apply.includes('knockout-prone'), 'apply.md has no knockout-prone field class');
  assert.ok(apply.includes('data-static/ats-notes.md'), 'apply.md does not read data-static/ats-notes.md');
  const step6 = apply.split('## Step 6 — Analyze form questions')[1].split('\n## ')[0];
  for (const cls of ['Identity and contact', 'Knockout-prone', 'Personal and sensitive', 'Experience facts', 'Free text', 'Uploads', 'Consent and legal']) {
    assert.ok(step6.includes(cls), `Step 6 has no "${cls}" field class`);
  }
  for (const item of ['notice period', 'earliest start', 'on-site days', 'relocation', 'years of experience', 'language level', 'driving licence']) {
    assert.ok(step6.toLowerCase().includes(item), `Step 6 confirmation list does not name "${item}"`);
  }
  assert.ok(apply.includes('modes/_context.md'), 'apply.md does not name modes/_context.md for the why-this-role answers');
});

test('data-static/ats-notes.md has a quick-reference row per documented ATS', () => {
  const notes = read('data-static/ats-notes.md');
  for (const ats of ['Greenhouse', 'Workday', 'Personio', 'Lever', 'Ashby', 'SmartRecruiters', 'JOIN', 'softgarden', 'Recruitee', 'Teamtailor', 'SAP SuccessFactors']) {
    assert.ok(new RegExp(`^\\| ${ats} \\|`, 'm').test(notes), `no quick-reference row for ${ats}`);
    assert.ok(new RegExp(`^### ${ats}.*\\(checked \\d{4}-\\d{2}-\\d{2}\\)`, 'm').test(notes), `no dated source section for ${ats}`);
  }
  assert.ok(!/notion\.(so|com)/i.test(notes), 'the notes carry a Notion link');
  assert.ok(!notes.includes('@') && !notes.includes('+49'), 'the notes carry an email address or phone number');
});
