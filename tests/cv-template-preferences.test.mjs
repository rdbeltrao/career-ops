import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadYaml } from '../lib/yaml-document.mjs';
import { CV_PALETTES, PALETTE_COLOR_KEYS, applyCvPalette } from '../lib/cv-palettes.mjs';
import {
  getCvTemplateState, saveCvTemplatePreferences, chooseCvTemplate, validateCvStyle,
} from '../lib/cv-template-preferences.mjs';

const normalizedStyle = style => Object.fromEntries([...PALETTE_COLOR_KEYS, 'font_family', 'font_size'].map(key => [key, style[key] ?? '']));

function fixture(t, profile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-template-preferences-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'templates');
  fs.mkdirSync(path.join(dir, 'ats'), { recursive: true });
  const html = '<!-- career-ops-template\nname: A readable CV\ndescription: Plain example layout.\n-->\n{{NAME}}{{EXPERIENCE}}{{EDUCATION}}';
  for (const file of ['cv-template.html', 'cv-template.modern.html', 'ats/cv-template.ats.html']) fs.writeFileSync(path.join(dir, file), html);
  const profilePath = path.join(root, 'profile.yml');
  if (profile !== undefined) fs.writeFileSync(profilePath, profile);
  return { dir, profilePath };
}

function save(options, preferences, revision = getCvTemplateState(options).revision) {
  return saveCvTemplatePreferences({ ...options, preferences, revision, write: fs.writeFileSync });
}

test('missing profile uses standard and discovers flat templates and packs', t => {
  const state = getCvTemplateState(fixture(t));
  assert.deepEqual(state.preferences, { template: 'standard', useAtsGuidance: false, atsTemplates: {}, style: normalizedStyle({}) });
  assert.deepEqual(state.templates.map(item => item.name), ['ats', 'modern', 'standard']);
  assert.equal(state.templates[0].displayName, 'A readable CV');
  assert.equal(state.templates[0].description, 'Plain example layout.');
  assert.ok(state.vendors.some(item => item.id === 'greenhouse' && item.label === 'Greenhouse'));
  assert.equal(typeof state.revision, 'string');
});

test('saved preferences preserve unrelated settings and remove only owned empty style values', t => {
  const options = fixture(t, 'candidate:\n  full_name: Example\ncv:\n  template: standard\n  sections: [skills, education]\nstyle:\n  accent_color: "#111111"\n  margin: 0.4in\nprivate_setting: keep\n');
  const previous = getCvTemplateState(options);
  const preferences = { ...previous.preferences, template: 'modern', atsTemplates: { greenhouse: 'ats', ashby: 'modern' }, style: { accent_color: '', font_family: 'Georgia, serif', font_size: '11pt' } };
  const saved = save(options, preferences);
  assert.notEqual(saved.revision, previous.revision);
  assert.deepEqual(saved.preferences, { ...preferences, style: normalizedStyle(preferences.style) });
  const doc = loadYaml(fs.readFileSync(options.profilePath, 'utf8'));
  assert.equal(doc.candidate.full_name, 'Example');
  assert.equal(doc.private_setting, 'keep');
  assert.deepEqual(doc.cv.sections, ['skills', 'education']);
  assert.equal(doc.style.margin, '0.4in');
  assert.equal(Object.hasOwn(doc.style, 'accent_color'), false);
  assert.deepEqual(doc.cv.ats_templates, { greenhouse: 'ats', ashby: 'modern' });
});

test('first save writes a missing profile using the injected writer', t => {
  const options = fixture(t);
  const original = getCvTemplateState(options);
  assert.equal(save(options, original.preferences).preferences.template, 'standard');
  assert.equal(fs.existsSync(options.profilePath), true);
});

test('revision checks reject stale profile snapshots without invoking writer', t => {
  const options = fixture(t, 'cv:\n  template: modern\n');
  const state = getCvTemplateState(options);
  fs.appendFileSync(options.profilePath, 'another_setting: changed\n');
  let writes = 0;
  assert.throws(() => saveCvTemplatePreferences({ ...options, preferences: state.preferences, revision: state.revision, write: () => writes++ }), /changed|reload/i);
  assert.equal(writes, 0);
  assert.throws(() => saveCvTemplatePreferences({ ...options, preferences: state.preferences, write: () => writes++ }), /revision|reload/i);
  assert.equal(writes, 0);
});

test('malformed and nonmapping existing profile fields never become defaults', t => {
  for (const text of ['', '# comment only\n', 'cv: [broken', '- example\n', 'cv: modern\n', 'cv: []\n', 'style: blue\n', 'cv:\n  ats_templates: []\n', 'cv:\n  ats_guidance: yes\n']) {
    const options = fixture(t, text);
    assert.throws(() => getCvTemplateState(options), undefined, text);
    assert.equal(fs.readFileSync(options.profilePath, 'utf8'), text);
  }
});

test('invalid names, vendors and style values are rejected before writes', t => {
  const options = fixture(t);
  const { preferences, revision } = getCvTemplateState(options);
  const changes = [
    { template: '../outside' }, { template: 'missing' }, { useAtsGuidance: 'yes' },
    { atsTemplates: { unknown: 'ats' } }, { atsTemplates: { greenhouse: 'missing' } },
    { style: { ...preferences.style, accent_color: 'red;display:none' } },
    { style: { ...preferences.style, font_family: 'Arial; color:red' } },
    { style: { ...preferences.style, font_family: 'url(https://example.com/font)' } },
    { style: { ...preferences.style, font_size: '10pt;display:none' } },
  ];
  for (const change of changes) {
    let writes = 0;
    assert.throws(() => saveCvTemplatePreferences({ ...options, preferences: { ...preferences, ...change }, revision, write: () => writes++ }));
    assert.equal(writes, 0);
  }
});

test('existing CSS style values remain readable, selectable and saveable without conversion', t => {
  const styles = [
    { accent_color: 'hsl(222 47% 34%)', font_family: '"Fira Code", monospace', font_size: '10px' },
    { accent_color: '#abc', font_family: "'Font & Co', Georgia, serif", font_size: '0.8rem' },
    { accent_color: 'rebeccapurple', font_family: 'var(--cv-font, Inter), sans-serif', font_size: 'calc(1rem - 2px)' },
    { accent_color: 'var(--cv-accent, #abc)', font_family: 'Arial, sans-serif', font_size: 'var(--cv-size, 10pt)' },
    { accent_color: 'rgb(15 23 42 / 95%)', font_family: 'system-ui', font_size: 'clamp(8pt, 1vw, 20pt)' },
  ];
  for (const style of styles) {
    const options = fixture(t, JSON.stringify({ cv: { template: 'modern' }, style: { ...style, margin: '0.6in', tag_color: '#abc' } }));
    const state = getCvTemplateState(options);
    assert.deepEqual(state.preferences.style, normalizedStyle({ ...style, tag_color: '#abc' }));
    assert.equal(chooseCvTemplate(options).name, 'modern');
    assert.deepEqual(validateCvStyle(style), normalizedStyle(style), 'previews accept the same style values');
    const saved = save(options, { ...state.preferences, template: 'ats' });
    assert.deepEqual(saved.preferences.style, normalizedStyle({ ...style, tag_color: '#abc' }));
    assert.deepEqual(loadYaml(fs.readFileSync(options.profilePath, 'utf8')).style, { ...style, margin: '0.6in', tag_color: '#abc' });
  }
});

test('all coordinated palette colors save and reload through the canonical profile', t => {
  const options = fixture(t, 'cv:\n  template: modern\nstyle:\n  margin: 0.4in\n  font_family: Georgia, serif\n  font_size: 10px\n');
  for (const palette of CV_PALETTES) {
    const state = getCvTemplateState(options);
    const preferences = { ...state.preferences, style: applyCvPalette(state.preferences.style, palette.id) };
    const saved = save(options, preferences, state.revision);
    assert.deepEqual(saved.preferences.style, preferences.style);
    assert.deepEqual(getCvTemplateState(options).preferences, saved.preferences);
    const doc = loadYaml(fs.readFileSync(options.profilePath, 'utf8'));
    for (const key of PALETTE_COLOR_KEYS) assert.equal(doc.style[key], palette.colors[key]);
    assert.equal(doc.style.margin, '0.4in');
    assert.equal(doc.style.font_family, 'Georgia, serif');
    assert.equal(doc.style.font_size, '10px');
  }
});

test('older clients changing three style controls do not erase advanced color tokens', t => {
  const initial = { ...CV_PALETTES[0].colors, font_family: 'Georgia, serif', font_size: '10px', margin: '0.4in' };
  const options = fixture(t, JSON.stringify({ cv: { template: 'modern' }, style: initial }));
  const state = getCvTemplateState(options);
  const next = { accent_color: '', font_family: 'Arial, sans-serif', font_size: '11pt' };
  const saved = save(options, { ...state.preferences, style: next });
  const doc = loadYaml(fs.readFileSync(options.profilePath, 'utf8'));
  assert.equal(Object.hasOwn(doc.style, 'accent_color'), false);
  for (const key of PALETTE_COLOR_KEYS.filter(key => key !== 'accent_color')) {
    assert.equal(doc.style[key], initial[key]);
    assert.equal(saved.preferences.style[key], initial[key]);
  }
  assert.equal(doc.style.margin, initial.margin);
  assert.equal(doc.style.font_family, next.font_family);
});

test('template-default palette explicitly clears every coordinated color while keeping other styling', t => {
  const options = fixture(t, JSON.stringify({ cv: { template: 'modern' }, style: { ...CV_PALETTES[0].colors, font_family: 'Georgia, serif', font_size: '10px', margin: '0.4in' } }));
  const state = getCvTemplateState(options);
  const preferences = { ...state.preferences, style: applyCvPalette(state.preferences.style, 'template') };
  save(options, preferences);
  const doc = loadYaml(fs.readFileSync(options.profilePath, 'utf8'));
  assert.deepEqual(doc.style, { font_family: 'Georgia, serif', font_size: '10px', margin: '0.4in' });
});

test('CSS controls, HTML controls, remote resources and oversized values remain rejected', () => {
  for (const value of [
    'red; color: blue', 'red}', '<style>', 'url(https://example.com/font)',
    'URL ("https://example.com/font")', '@import "https://example.com/font"',
    'red\nblue', 'red\u0000blue', '\\75rl(https://example.com/font)', 'x'.repeat(513),
  ]) {
    for (const key of ['accent_color', 'font_family', 'font_size']) {
      assert.throws(() => validateCvStyle({ [key]: value }), undefined, `${key}: ${value}`);
    }
  }
});

test('template resolution follows explicit, vendor override, guidance, then preferred default', t => {
  const options = fixture(t, 'cv:\n  template: modern\n  ats_guidance: true\n  ats_templates:\n    greenhouse: modern\n    lever: ats\n');
  const url = 'https://boards.greenhouse.io/example/jobs/1';
  const explicit = chooseCvTemplate({ ...options, template: 'ats', url });
  assert.equal(explicit.name, 'ats');
  assert.equal(explicit.source, 'explicit');
  assert.equal(explicit.ats, 'greenhouse');
  const override = chooseCvTemplate({ ...options, url });
  assert.equal(override.name, 'modern');
  assert.equal(override.source, 'ats-override');
  assert.equal(chooseCvTemplate({ ...options, url: 'https://jobs.lever.co/example/1' }).name, 'ats');
  assert.equal(chooseCvTemplate({ ...options, url: 'https://jobs.ashbyhq.com/example/1' }).name, 'modern');
  assert.equal(chooseCvTemplate({ ...options, url: 'https://careers.example.com/job' }).source, 'default');
});

test('guidance is opt-in and applies only to documented Greenhouse formatting concerns', t => {
  const options = fixture(t, 'cv:\n  template: modern\n');
  const url = 'https://boards.greenhouse.io/example/jobs/1';
  assert.equal(chooseCvTemplate({ ...options, url }).name, 'modern');
  const state = getCvTemplateState(options);
  save(options, { ...state.preferences, useAtsGuidance: true });
  const guided = chooseCvTemplate({ ...options, url });
  assert.equal(guided.name, 'ats');
  assert.equal(guided.source, 'ats-guidance');
  assert.match(JSON.stringify(guided.guidance), /support\.greenhouse\.io/);
  assert.equal(chooseCvTemplate({ ...options, url: 'https://company.myworkdayjobs.com/job/1' }).name, 'modern');
  assert.equal(chooseCvTemplate({ ...options, url: 'https://greenhouse.io.evil.example/job/1' }).name, 'modern');
});

test('missing ATS template leaves guidance on the saved default', t => {
  const options = fixture(t, 'cv:\n  template: modern\n  ats_guidance: true\n');
  fs.rmSync(path.join(options.dir, 'ats/cv-template.ats.html'));
  assert.equal(chooseCvTemplate({ ...options, url: 'https://boards.greenhouse.io/example/jobs/1' }).name, 'modern');
});

test('missing configured or explicitly selected template is an actionable error', t => {
  const options = fixture(t, 'cv:\n  template: vanished\n');
  assert.throws(() => getCvTemplateState(options), /vanished|not found/i);
  assert.throws(() => chooseCvTemplate({ ...options, template: 'modern' }), /vanished|not found/i);
  const clean = fixture(t);
  assert.throws(() => chooseCvTemplate({ ...clean, template: 'missing' }), /missing|not found/i);
});

test('existing display-name template preferences retain core normalization', t => {
  const options = fixture(t, 'cv:\n  template: Modern\n  ats_templates:\n    greenhouse: ATS\n');
  assert.equal(getCvTemplateState(options).preferences.template, 'modern');
  assert.equal(chooseCvTemplate({ ...options, template: 'Standard' }).name, 'standard');
  assert.equal(chooseCvTemplate({ ...options, url: 'https://boards.greenhouse.io/example/jobs/1' }).name, 'ats');
});

test('writer failures propagate and never report saved preferences', t => {
  const options = fixture(t);
  const state = getCvTemplateState(options);
  assert.throws(() => saveCvTemplatePreferences({ ...options, ...state, write: () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(fs.existsSync(options.profilePath), false);
});
