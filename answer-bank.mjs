#!/usr/bin/env node
/**
 * answer-bank.mjs — the cross-application record of answers sent on job forms.
 *
 * File: {DATA_ROOT}/data/application-answers.jsonl (user layer, append-only).
 * One JSON object per line, written each time answers are filled into a real
 * form or the application is marked submitted:
 *
 *   {"v":1,"date":"2026-10-25","state":"filled|submitted","report":"067"|null,
 *    "company":"Acme","role":"Engineering Manager","url":"https://…",
 *    "answers":[{"q":"Notice period","a":"3 months","kind":"field"}]}
 *
 * `kind` is free (free text), select (select, radio, checkbox), field (any other
 * input) or file (an upload; `a` is the file path).
 *
 * Why a bank as well as the report's `## Application Answers` section: a report
 * holds one application, and an application opened from a pasted URL has no
 * report at all. Prefilling a new form from what was sent before, and checking a
 * repeat application against the last one sent to the same company, both need
 * every earlier answer in one place. The report section stays the per-report
 * record (application-answers.mjs writes both).
 *
 * Writers: the web Apply page (/api/apply/answers) and application-answers.mjs
 * when it writes a report section, so the web and the CLI apply mode feed the
 * same file. Readers: the web prefill (matchPriorAnswers, guardAnswers,
 * companyHistory) and this script's CLI, which the CLI apply mode's
 * repeat-application check runs.
 *
 * Never stored: passwords and empty answers.
 *
 * Saved answers are the candidate's own reviewed statements to employers, so
 * they are derived-tier sources (AGENTS.md, Source-of-Truth Boundary): fine for
 * phrasing, never a source for a number the CV does not carry. A knockout or
 * sensitive answer from the bank is only ever a suggestion the candidate
 * confirms (guardAnswers), and a consent answer is never reused.
 *
 * CLI (read-only):
 *   node answer-bank.mjs --company "<name>" [--json]
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

export const ANSWER_BANK_FILE = 'data/application-answers.jsonl';
const VERSION = 1;
const STATES = new Set(['filled', 'submitted']);
const KINDS = new Set(['free', 'select', 'field', 'file']);

/** @param {string} root - The data root (getCareerOpsRoot()). */
export function answerBankPath(root) {
  return join(root, ANSWER_BANK_FILE);
}

// ---------------------------------------------------------------------------
// Questions

/** Lowercase, accents and punctuation stripped, "(optional)" tags dropped. */
export function normalizeQuestion(label) {
  return String(label ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\((optional|required|pflichtfeld|freiwillig)\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const PASSWORD_RE = /\b(password|passwort|kennwort|mot de passe|contrasena|senha|wachtwoord|haslo)\b/;
const CONSENT_RE = /\b(consent|agree|agreement|acknowledge|privacy|data protection|datenschutz\w*|einwillig\w*|zustimm\w*|talent (pool|community)|gdpr|dsgvo|terms (and|of) (conditions|use|service))\b/;
const SENSITIVE_RE = /\b(gender|pronouns?|date of birth|birth ?date|birthday|age|nationality|citizenship|race|racial|ethnic\w*|veteran|disabilit\w*|diversity|eeo|sexual orientation|lgbt\w*|photo|religio\w*|marital|geschlecht|geburtsdatum|staatsangehorigkeit|behinderung)\b/;
// The knockout-prone class of modes/apply.md Step 6: answers that can reject an
// application without a human reading it.
const KNOCKOUT_RE = /\b(visa|sponsor\w*|work (permit|authori[sz]ation)|authori[sz]ed to work|right to work|eligible to work|arbeitserlaubnis|aufenthalt\w*|relocat\w*|umzug|on ?site|office days|days (in|at) the office|hybrid|commut\w*|location|located|based in|years? (of )?(\w+ )?experience|how many years|berufserfahrung|salary|compensation|pay expectations?|gehalt\w*|notice period|kundigungsfrist|start date|earliest start|available to start|availability|eintrittstermin|verfugbarkeit|driving licen[cs]e|drivers? s? ?licen[cs]e|fuhrerschein|language (level|skills|proficiency)|(english|german|french|spanish|dutch|deutsch) (level|proficiency|skills)|do you speak|sprachkenntnisse|deutschkenntnisse)\b/;
const IDENTITY_RE = /\b(first name|last name|full name|given name|family name|surname|name|e ?mail|phone|mobile|telephone|address|street|city|postal|zip|linkedin|github|website|portfolio|vorname|nachname|telefon)\b/;

/**
 * The class decides what may happen to a saved answer:
 *   password  never stored, never filled
 *   consent   stored for the record, never reused, never ticked for the user
 *   sensitive suggested only with a confirmation
 *   knockout  suggested only with a confirmation
 *   identity  reused (config/profile.yml stays authoritative in the prompt)
 *   other     reused as phrasing for the new form
 * @returns {'password'|'consent'|'sensitive'|'knockout'|'identity'|'other'}
 */
export function classifyQuestion(label) {
  const q = normalizeQuestion(label);
  if (PASSWORD_RE.test(q)) return 'password';
  if (CONSENT_RE.test(q)) return 'consent';
  if (SENSITIVE_RE.test(q)) return 'sensitive';
  if (KNOCKOUT_RE.test(q)) return 'knockout';
  if (IDENTITY_RE.test(q)) return 'identity';
  return 'other';
}

const STOPWORDS = new Set('a an and are as at be by can do does for from have how i if in is it of on or our please the this to us we what when which will with you your'.split(' '));

function tokens(q) {
  return new Set(q.split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t)));
}

function jaccard(a, b) {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// JUDGMENT: 0.75 on content words keeps rewordings of one question ("What is
// your earliest possible start date?" vs "Earliest possible start date") and
// drops questions that only share a word or two ("Start of studies").
const MIN_OVERLAP = 0.75;

// ---------------------------------------------------------------------------
// Records

function clean(value) {
  return String(value ?? '').trim();
}

/**
 * Turn the web Apply page's fields + answers into the application-answers.mjs
 * snapshot shape, which is what the report section renders. Passwords and empty
 * answers are dropped here, so neither ever reaches the report or the bank.
 *
 * @param {{ fields: {id: string, type: string, label: string}[], answers: Record<string, string>, cvFile?: string | null }} input
 */
export function snapshotFromForm({ fields = [], answers = {}, cvFile = null } = {}) {
  const snap = { freeText: [], selections: [], fieldValues: [], files: [] };
  for (const f of fields) {
    const question = clean(f.label).replace(/\s*\*+$/, '') || f.id;
    if (classifyQuestion(question) === 'password') continue;
    if (f.type === 'file') {
      if (cvFile && /resume|résumé|\bcv\b|lebenslauf/i.test(question)) snap.files.push({ field: question, path: cvFile });
      continue;
    }
    const value = clean(answers[f.id]);
    if (!value) continue;
    if (f.type === 'textarea') snap.freeText.push({ question, answer: value });
    else if (f.type === 'select' || f.type === 'radio' || f.type === 'checkbox') snap.selections.push({ question, selection: value });
    else snap.fieldValues.push({ question, answer: value });
  }
  return snap;
}

function entries(list, kind, qKeys, aKeys) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    const q = clean(qKeys.map((k) => e?.[k]).find((v) => clean(v)));
    const raw = aKeys.map((k) => e?.[k]).find((v) => (Array.isArray(v) ? v.length : clean(v)));
    const a = Array.isArray(raw) ? raw.map(clean).filter(Boolean).join(', ') : clean(raw);
    if (!q || !a || a === 'Not recorded') continue;
    if (classifyQuestion(q) === 'password') continue;
    out.push({ q, a, kind });
  }
  return out;
}

/**
 * Build a bank record from an application-answers.mjs snapshot (the one shape
 * both writers already hold).
 */
export function bankRecordFromSnapshot(snapshot = {}, meta = {}) {
  const state = clean(meta.state || snapshot.state || 'filled').toLowerCase();
  if (!STATES.has(state)) throw new Error(`answer bank state must be one of: ${[...STATES].join(', ')}`);
  const answers = [
    ...entries(snapshot.freeText, 'free', ['question', 'field', 'label', 'prompt'], ['answer', 'response', 'value', 'text']),
    ...entries(snapshot.selections, 'select', ['question', 'field', 'label', 'prompt'], ['selection', 'selected', 'answer', 'value', 'options']),
    ...entries(snapshot.fieldValues, 'field', ['question', 'field', 'label', 'prompt'], ['answer', 'response', 'value', 'text']),
    ...entries(snapshot.files, 'file', ['field', 'name', 'label', 'type'], ['path', 'file', 'filename', 'url']),
  ];
  return {
    v: VERSION,
    date: clean(meta.date || snapshot.date) || localToday(),
    state,
    report: clean(meta.report) || null,
    company: clean(meta.company),
    role: clean(meta.role),
    url: clean(meta.url),
    answers,
  };
}

function validRecord(r) {
  return !!r && typeof r === 'object' && r.v === VERSION && STATES.has(r.state) && Array.isArray(r.answers)
    && r.answers.every((a) => a && typeof a.q === 'string' && typeof a.a === 'string' && KINDS.has(a.kind));
}

/**
 * Append one record. A record with no answers is not written (false).
 *
 * JUDGMENT: no lock. Each save is one small appendFileSync (O_APPEND) of a
 * single line, the file is append-only, and readBank skips a malformed line
 * instead of failing, so the worst a race can cost is one unreadable line.
 */
export function appendBankRecord(root, record) {
  if (!validRecord(record) || record.answers.length === 0) return false;
  const file = answerBankPath(root);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return true;
}

/** @returns {{ records: object[], skipped: number }} records in file order. */
export function readBank(root) {
  const file = answerBankPath(root);
  if (!existsSync(file)) return { records: [], skipped: 0 };
  const records = [];
  let skipped = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (validRecord(r)) records.push(r);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

// ---------------------------------------------------------------------------
// Readers

const LEGAL_SUFFIX_RE = /\b(gmbh|ag|se|kg|ug|inc|incorporated|ltd|limited|llc|plc|bv|nv|sa|sas|sarl|srl|spa|oy|ab|as|co|corp|corporation|company)\b/g;

/** Company identity for matching: case, punctuation and legal form folded. */
export function companyKey(name) {
  return normalizeQuestion(name).replace(LEGAL_SUFFIX_RE, ' ').replace(/\s+/g, '');
}

function applicationKey(r) {
  if (r.report && /^\d+$/.test(r.report)) return `r:${Number(r.report)}`;
  if (r.url) return `u:${r.url}`;
  return `c:${companyKey(r.company)}|${normalizeQuestion(r.role)}`;
}

/** Records sorted oldest first by date, file order breaking ties. */
function chronological(records) {
  return records.map((r, i) => ({ r, i })).sort((x, y) => (x.r.date < y.r.date ? -1 : x.r.date > y.r.date ? 1 : x.i - y.i)).map((x) => x.r);
}

/**
 * Earlier applications to one company, one entry per application (the latest
 * save of each), newest first. This is what the repeat-application check shows.
 */
export function companyHistory(records, company) {
  const key = companyKey(company);
  if (!key) return [];
  const latest = new Map();
  for (const r of chronological(records)) {
    if (companyKey(r.company) !== key) continue;
    latest.set(applicationKey(r), r);
  }
  return [...latest.values()].reverse().map((r) => ({ date: r.date, state: r.state, role: r.role, report: r.report, url: r.url, answers: r.answers }));
}

/** Lexicographic: the first position where the ranks differ decides. */
function outranks(a, b) {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function matchOption(answer, options) {
  if (!Array.isArray(options) || options.length === 0) return answer;
  const want = normalizeQuestion(answer);
  return options.find((o) => normalizeQuestion(o) === want) ?? null;
}

/**
 * For each field of a new form, the best earlier answer to the same question.
 *
 * Same normalized label first, else a strong content-word overlap. Among those:
 * the same company first (a repeat application should stay consistent), then a
 * submitted answer over one only filled, then the newest. Consent, password and
 * file fields are never matched. A select or radio answer is kept only when the
 * new form still offers it, and is returned in the new form's exact option text.
 *
 * @returns {Record<string, {question: string, answer: string, company: string, date: string, state: string, class: string, sameCompany: boolean}>}
 */
export function matchPriorAnswers(records, fields, { company = '' } = {}) {
  const want = companyKey(company);
  const pool = [];
  chronological(records).forEach((r, order) => {
    for (const a of r.answers) {
      if (a.kind === 'file') continue;
      const cls = classifyQuestion(a.q);
      if (cls === 'password' || cls === 'consent') continue;
      const q = normalizeQuestion(a.q);
      pool.push({ q, toks: tokens(q), a, r, order });
    }
  });
  const out = {};
  for (const f of fields) {
    if (f.type === 'file') continue;
    const cls = classifyQuestion(f.label);
    if (cls === 'password' || cls === 'consent') continue;
    const q = normalizeQuestion(f.label);
    if (!q) continue;
    const toks = tokens(q);
    let best = null;
    for (const c of pool) {
      const exact = c.q === q;
      if (!exact && !(toks.size >= 2 && c.toks.size >= 2 && jaccard(toks, c.toks) >= MIN_OVERLAP)) continue;
      const answer = matchOption(c.a.a, f.options);
      if (answer == null) continue;
      const rank = [exact ? 1 : 0, want && companyKey(c.r.company) === want ? 1 : 0, c.r.state === 'submitted' ? 1 : 0, c.order];
      if (!best || outranks(rank, best.rank)) best = { rank, c, answer };
    }
    if (best) {
      out[f.id] = {
        question: best.c.a.q,
        answer: best.answer,
        company: best.c.r.company,
        date: best.c.r.date,
        state: best.c.r.state,
        class: cls,
        sameCompany: best.rank[1] === 1,
      };
    }
  }
  return out;
}

/**
 * Enforce the field classes on the planner's draft. The prompt asks for the same
 * thing; this is the part that does not depend on the model listening.
 *   password, consent  blank, needs confirmation (never filled, never ticked)
 *   sensitive          needs confirmation; blank unless a saved answer backs it
 *                      (no source the planner reads states demographics)
 *   knockout           needs confirmation always; the draft is kept, because
 *                      config/profile.yml may state that exact answer (visa,
 *                      comp, location), and an empty draft takes the saved one
 *
 * JUDGMENT: knockout drafts are flagged, not blanked. Blanking them would undo
 * the profile-sourced visa and comp answers the prompt has always allowed; the
 * confirmation flag is what modes/apply.md's "ask every time" needs.
 *
 * @param {{id: string, label: string}[]} fields
 * @param {Record<string, {value?: string, needs_confirmation?: boolean}>} answers
 * @param {Record<string, {answer: string}>} priors - matchPriorAnswers() output
 */
export function guardAnswers(fields, answers, priors = {}) {
  const out = { ...answers };
  for (const f of fields) {
    const cls = classifyQuestion(f.label);
    const drafted = clean(answers?.[f.id]?.value);
    if (cls === 'password' || cls === 'consent') {
      out[f.id] = { value: '', needs_confirmation: true };
    } else if (cls === 'sensitive') {
      const prior = priors[f.id];
      out[f.id] = { value: prior ? drafted || prior.answer : '', needs_confirmation: true };
    } else if (cls === 'knockout') {
      out[f.id] = { value: drafted || priors[f.id]?.answer || '', needs_confirmation: true };
    }
  }
  return out;
}

/** Company, role and posting URL from a report's header. */
export function reportMeta(reportText) {
  const text = String(reportText ?? '');
  const title = /^#[ \t]+(.+)$/m.exec(text)?.[1]?.trim() ?? '';
  const colon = title.indexOf(':');
  const body = colon >= 0 && colon < 40 ? title.slice(colon + 1).trim() : '';
  const [company = '', ...rest] = body ? body.split(/\s+[—–-]\s+/) : [];
  const urlLine = /^\*\*URL:\*\*[ \t]*(.*)$/m.exec(text)?.[1] ?? '';
  const url = /https?:\/\/[^\s)>\]]+/.exec(urlLine)?.[0] ?? '';
  return { company: company.trim(), role: rest.join(' — ').trim(), url };
}

// ---------------------------------------------------------------------------
// CLI

function usage() {
  return 'Usage: node answer-bank.mjs --company "<name>" [--json]\n\nPrints the earlier applications to that company from data/application-answers.jsonl and the answers sent. Read-only.';
}

function main(argv) {
  const args = { json: false, company: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(usage());
      return 0;
    }
    if (a === '--json') args.json = true;
    else if (a === '--company') args.company = argv[++i] ?? '';
    else {
      console.error(`Unknown argument: ${a}\n\n${usage()}`);
      return 1;
    }
  }
  if (!clean(args.company)) {
    console.error(usage());
    return 1;
  }
  const { records, skipped } = readBank(getCareerOpsRoot());
  const applications = companyHistory(records, args.company);
  if (args.json) {
    console.log(JSON.stringify({ company: args.company, applications, skipped }, null, 2));
    return 0;
  }
  if (applications.length === 0) {
    console.log(`No saved answers for ${args.company}.`);
    return 0;
  }
  console.log(`${args.company}: ${applications.length} earlier application${applications.length === 1 ? '' : 's'}`);
  for (const app of applications) {
    const ref = app.report ? ` (report ${app.report})` : app.url ? ` (${app.url})` : '';
    console.log(`\n${app.date}  ${app.state}  ${app.role || 'role not recorded'}${ref}`);
    for (const a of app.answers) {
      if (a.kind === 'file') continue;
      const shown = a.a.length > 200 ? `${a.a.slice(0, 200)}…` : a.a;
      console.log(`  - ${a.q}: ${shown.replace(/\s+/g, ' ')}`);
    }
  }
  if (skipped) console.log(`\n(${skipped} unreadable line${skipped === 1 ? '' : 's'} skipped)`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
