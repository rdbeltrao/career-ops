import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payloadForTemplate } from '../ats-payload.mjs';

test('ATS template moves exact competencies into delimited Skills without changing facts', () => {
  const original = { candidate: { name: 'Sample Candidate' }, competencies: ['People leadership', 'Product delivery'], skills: [{ category: 'Languages', items: 'TypeScript, Go' }], experience: [{ company: 'Example', role: 'Manager', bullets: ['Built reliable services.'] }] };
  const before = structuredClone(original);
  const prepared = payloadForTemplate(original, 'templates/ats/cv-template.ats.html');
  assert.deepEqual(prepared.competencies, []);
  assert.ok(prepared.skills.some(item => item.items === 'People leadership, Product delivery'));
  assert.deepEqual(prepared.candidate, original.candidate);
  assert.deepEqual(prepared.experience, original.experience);
  assert.deepEqual(original, before);
  assert.deepEqual(payloadForTemplate(prepared, 'templates/ats/cv-template.ats.html'), prepared);
  assert.equal(payloadForTemplate(original, 'templates/cv-template.compact.html'), original);
});

test('ATS selection refuses a payload shape that would discard content', () => {
  assert.throws(() => payloadForTemplate({ competencies: ['Leadership'], skills: 'TypeScript' }, 'templates/ats/cv-template.ats.html'), /skills.*must be an array/);
});
