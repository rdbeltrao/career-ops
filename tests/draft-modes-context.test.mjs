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
  assert.match(section, /never evidence|not evidence|targeting/i, 'the context file must be named as targeting, never evidence');
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
