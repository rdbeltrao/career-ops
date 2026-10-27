/** Shared CV presentation preferences. Template discovery remains in the core registry. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import { loadYaml } from './yaml-document.mjs';
import { getProfilePath } from '../path-resolver.mjs';
import { kebab, listTemplates, resolveTemplate } from '../cv-templates.mjs';
import { atsVendorOf, KNOWN_ATS_VENDORS } from '../ats-vendor.mjs';
import { PALETTE_COLOR_KEYS } from './cv-palettes.mjs';

const STYLE_KEYS = [...PALETTE_COLOR_KEYS, 'font_family', 'font_size'];
const VENDOR_LABELS = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workday: 'Workday',
  icims: 'iCIMS', successfactors: 'SAP SuccessFactors', dayforce: 'Dayforce',
  ultipro: 'UKG Pro', taleo: 'Taleo', bamboohr: 'BambooHR',
  smartrecruiters: 'SmartRecruiters', csod: 'Cornerstone', oraclecloud: 'Oracle Cloud',
};

export class CvTemplatePreferenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CvTemplatePreferenceError';
    this.code = code;
  }
}

function invalid(message) {
  throw new CvTemplatePreferenceError('invalid-preferences', message);
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireMapping(value, name) {
  if (!isMapping(value)) invalid(`${name} must contain named settings, not a list or single value.`);
  return value;
}

function readProfile(profilePath) {
  let text;
  try {
    text = readFileSync(profilePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { document: {}, revision: 'missing' };
    throw error;
  }
  let document;
  try {
    document = loadYaml(text);
  } catch (error) {
    invalid(`The profile is not valid YAML. Fix it before changing CV templates. ${error.message}`);
  }
  requireMapping(document, 'The profile');
  if (document.cv !== undefined) requireMapping(document.cv, 'cv');
  if (document.style !== undefined) requireMapping(document.style, 'style');
  return { document, revision: createHash('sha256').update(text).digest('hex') };
}

/** Validate the presentation controls shared by settings and synthetic previews. */
export function validateCvStyle(style = {}) {
  requireMapping(style, 'CV style');
  for (const key of Object.keys(style)) {
    if (!STYLE_KEYS.includes(key)) invalid(`Unknown CV style setting: ${key}.`);
  }
  const normalized = {};
  for (const key of STYLE_KEYS) {
    const value = style[key] ?? '';
    if (typeof value !== 'string') invalid(`CV style ${key} must be text.`);
    // EVIDENCE: theme-style.mjs treats tokens as CSS values, rather than a
    // fixed color/unit/font vocabulary. Preserve existing hsl(), var(), calc()
    // and user font lists. Keep its CSS/HTML breakout guard and additionally
    // reject remote-resource syntax, escapes and control characters here.
    if (value.length > 512 || /[;{}<>\\\u0000-\u001f\u007f-\u009f]/.test(value)
      || /url\s*\(|@import\b/i.test(value)) {
      invalid(`CV style ${key} must be a CSS value without commands, URLs or control characters (up to 512 characters).`);
    }
    normalized[key] = value.trim();
  }
  return normalized;
}

function templateName(value, dir) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9 -]*$/i.test(value.trim())) {
    invalid('CV template must name an available template.');
  }
  // EVIDENCE: cv-templates.mjs owns discovery, collision detection and declared
  // partial validation; routing through it keeps CLI and dashboard in agreement.
  resolveTemplate('cv', value, { dir, fallback: false });
  return kebab(value);
}

function normalizePreferences(preferences, dir) {
  requireMapping(preferences, 'CV preferences');
  if (typeof preferences.useAtsGuidance !== 'boolean') invalid('ATS guidance must be enabled or disabled.');
  const atsTemplates = requireMapping(preferences.atsTemplates, 'ATS template overrides');
  const normalizedOverrides = {};
  for (const [vendor, name] of Object.entries(atsTemplates)) {
    if (!KNOWN_ATS_VENDORS.includes(vendor)) invalid(`Unknown ATS vendor: ${vendor}.`);
    normalizedOverrides[vendor] = templateName(name, dir);
  }
  return {
    template: templateName(preferences.template, dir),
    useAtsGuidance: preferences.useAtsGuidance,
    atsTemplates: normalizedOverrides,
    style: validateCvStyle(preferences.style),
  };
}

function preferencesFrom(document, dir) {
  const cv = document.cv ?? {};
  const style = document.style ?? {};
  return normalizePreferences({
    template: cv.template === undefined ? 'standard' : cv.template,
    useAtsGuidance: cv.ats_guidance === undefined ? false : cv.ats_guidance,
    atsTemplates: cv.ats_templates === undefined ? {} : cv.ats_templates,
    style: Object.fromEntries(STYLE_KEYS.map(key => [key, style[key] ?? ''])),
  }, dir);
}

function stateFrom(document, revision, dir) {
  return {
    templates: listTemplates('cv', { dir }).map(item => ({
      name: item.name, displayName: item.displayName,
      description: item.meta.description || `${item.displayName} CV layout.`,
    })),
    preferences: preferencesFrom(document, dir),
    vendors: KNOWN_ATS_VENDORS.map(id => ({ id, label: VENDOR_LABELS[id] ?? id })),
    revision,
  };
}

export function getCvTemplateState({ profilePath = getProfilePath(), dir } = {}) {
  const { document, revision } = readProfile(profilePath);
  return stateFrom(document, revision, dir);
}

/** Merge only the controls this surface owns; the caller supplies the backed-up atomic writer. */
export function saveCvTemplatePreferences({ profilePath = getProfilePath(), dir, preferences, revision, write }) {
  const current = readProfile(profilePath);
  if (typeof revision !== 'string' || revision !== current.revision) {
    throw new CvTemplatePreferenceError('stale-revision', 'The profile changed. Reload CV template settings before saving again.');
  }
  if (typeof write !== 'function') throw new TypeError('A backed-up atomic profile writer is required.');
  const normalized = normalizePreferences(preferences, dir);
  const document = { ...current.document, cv: { ...current.document.cv } };
  document.cv.template = normalized.template;
  document.cv.ats_guidance = normalized.useAtsGuidance;
  document.cv.ats_templates = normalized.atsTemplates;
  const style = { ...document.style };
  for (const key of STYLE_KEYS) {
    // Older clients submit only accent/font/size. Omitted advanced colors are
    // not a reset request; palette clients send all five color keys explicitly.
    if (!Object.hasOwn(preferences.style ?? {}, key)) continue;
    if (normalized.style[key]) style[key] = normalized.style[key];
    else delete style[key];
  }
  if (Object.keys(style).length) document.style = style;
  else delete document.style;
  const text = yaml.dump(document, { lineWidth: 100, noRefs: true });
  write(profilePath, text);
  return stateFrom(document, createHash('sha256').update(text).digest('hex'), dir);
}

/** Select without modifying preferences or allowing a posting to issue instructions. */
export function chooseCvTemplate({ profilePath = getProfilePath(), dir, template, url } = {}) {
  const state = getCvTemplateState({ profilePath, dir });
  const { preferences } = state;
  const detected = atsVendorOf(url);
  const ats = KNOWN_ATS_VENDORS.includes(detected) ? detected : null;
  let name = preferences.template;
  let source = 'default';
  let guidance = null;
  if (template !== undefined && template !== null && template !== '') {
    name = templateName(template, dir);
    source = 'explicit';
  } else if (ats && Object.hasOwn(preferences.atsTemplates, ats)) {
    name = preferences.atsTemplates[ats];
    source = 'ats-override';
  } else if (preferences.useAtsGuidance && ats === 'greenhouse' && state.templates.some(item => item.name === 'ats')) {
    // EVIDENCE: Greenhouse documents columns, graphics and complex formatting
    // as possible parse failures. This is opt-in guidance, never a guarantee.
    // https://support.greenhouse.io/hc/en-us/articles/200989175-Unsuccessful-resume-parse
    name = 'ats';
    source = 'ats-guidance';
    guidance = {
      text: 'Greenhouse identifies columns, graphics and complex layouts as possible parsing risks. A simple text layout is recommended; parsing is not guaranteed.',
      url: 'https://support.greenhouse.io/hc/en-us/articles/200989175-Unsuccessful-resume-parse',
    };
  }
  return { name, path: resolveTemplate('cv', name, { dir, fallback: false }), source, ats, guidance };
}
