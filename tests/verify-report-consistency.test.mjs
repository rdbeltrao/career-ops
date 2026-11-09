// tests/verify-report-consistency.test.mjs — verify-report-consistency.mjs
// flags a report whose Machine Summary disagrees with its own Block B table,
// header or Verdict: a work_auth tier that ignores a posting location outside
// authorized_in for a candidate who needs sponsorship, a Jev required_mismatch
// beside all-Strong stack rows, an Apply beside hard stops or an open permit
// question, and a "without {noun}" strength no Evidence cell supports. It
// never edits anything.
//
// Run:  node --test tests/verify-report-consistency.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  checkReport, clauseEvidenced, countryOf, daysBetween, headerDate, headerWorkAuth, isAuthorized, readProfileLocation, verdictText, verifyReportConsistency, withoutClauses,
} from '../verify-report-consistency.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'verify-report-consistency.mjs');

const PROFILE = `name: "Test Person"
location:
  country: "Germany"
  city: "Berlin"
  visa_status: "EU Blue Card holder working in Germany"
  authorized_in: ["Germany"]
  needs_sponsorship: true
`;

const BLUE_CARD = { authorizedIn: ['Germany'], needsSponsorship: true };

/**
 * A minimal report: header, Machine Summary, Block B, Verdict.
 * @param {object} o
 */
function report({
  workAuthHeader = '➖ Not needed',
  yaml = {},
  rows = [],
  verdict = '**Consider.** Fit is good; comp is unknown.',
} = {}) {
  const ms = {
    company: 'Acme', role: 'Engineering Manager', score: 3.5,
    jev: { model: 'typesafe/jev-1.13', fit: 60, score: 3.4, verdict: 'apply', blocking: [], reasons: { seniority_match: 'match', location_ok: 'yes', language_blocker: 'none', team_type: 'product', stack_fit: 'stack_agnostic' } },
    legitimacy_tier: 'High Confidence', archetype: 'EM', final_decision: 'Consider', hard_stops: [], soft_gaps: [], top_strengths: [],
    work_auth: 'not_needed', posting_location: null,
    ...yaml,
  };
  const yamlText = toYaml(ms);
  const tableRows = rows.map((r) => `| ${r.requirement} | ${r.importance ?? 'high (stated)'} | ${r.match} | ${r.signal ?? '"quoted"'} | ${r.evidence ?? ''} |`).join('\n');
  return `# Evaluation: Acme — Engineering Manager

**Date:** 2026-11-01
**URL:** https://example.com/jobs/1
**Score:** 3.5/5
**Decision:** ${ms.final_decision}
**Legitimacy:** High Confidence
**Work Auth:** ${workAuthHeader}
**PDF:** pending

---

## Machine Summary

\`\`\`yaml
${yamlText}
\`\`\`

## A) Role Summary

| Field | Value |
|---|---|
| **Company** | Acme |

## B) Match with CV

| Requirement | Importance | Match | JD signal | Evidence / gap |
|---|---|---|---|---|
${tableRows}

### Gaps

None.

## C) Level and Strategy

Senior.

## G) Posting Legitimacy

High Confidence.

## Verdict (lead)

${verdict}

## Risk Summary

| Signal | Status |
|--------|--------|
| Posting legitimacy | ✅ High Confidence |
`;
}

/** Tiny YAML writer for the fixture shapes used here (scalars, lists of strings, nested maps). */
function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const [k, v] of Object.entries(value)) {
    if (Array.isArray(v)) {
      if (!v.length) lines.push(`${pad}${k}: []`);
      else { lines.push(`${pad}${k}:`); for (const item of v) lines.push(`${pad}  - ${JSON.stringify(item)}`); }
    } else if (v && typeof v === 'object') {
      lines.push(`${pad}${k}:`);
      lines.push(toYaml(v, indent + 2));
    } else {
      lines.push(`${pad}${k}: ${v === null ? 'null' : JSON.stringify(v)}`);
    }
  }
  return lines.join('\n');
}

const kinds = (r) => r.findings.map((f) => f.kind).sort();

test('countryOf reads the country a posting location names and nothing from a bare city', () => {
  assert.equal(countryOf('Barcelona, Spain'), 'Spain');
  assert.equal(countryOf('Madrid, Community of Madrid, Spain'), 'Spain');
  assert.equal(countryOf('Berlin, Berlin, Germany'), 'Germany');
  assert.equal(countryOf('Remote (US)'), 'United States');
  assert.equal(countryOf('Austria'), 'Austria', '"us" must not match inside Austria');
  assert.equal(countryOf('Munich'), null);
  assert.equal(countryOf('Remote'), null);
  assert.equal(countryOf(null), null);
});

test('isAuthorized covers a country by name, alias or bloc entry, and a national permit never expands to the EU', () => {
  assert.equal(isAuthorized('Germany', ['Germany']), true);
  assert.equal(isAuthorized('Germany', ['Deutschland']), true);
  assert.equal(isAuthorized('Spain', ['Germany']), false, 'a German permit does not authorize Spain');
  assert.equal(isAuthorized('Spain', ['EU']), true, 'an EU entry (citizenship) covers every member state');
  assert.equal(isAuthorized('Norway', ['EU']), false);
  assert.equal(isAuthorized('Norway', ['EEA']), true);
  assert.equal(isAuthorized('Spain', []), false);
});

test('work-auth-location: not_needed or unstated for a Spain role with a German permit and needs_sponsorship true', () => {
  for (const workAuth of ['not_needed', 'unstated']) {
    const r = checkReport(report({ yaml: { work_auth: workAuth, posting_location: 'Barcelona, Spain' }, workAuthHeader: workAuth === 'unstated' ? '⚠️ Unstated' : '➖ Not needed' }), { profile: BLUE_CARD });
    assert.deepEqual(kinds(r), ['work-auth-location'], `work_auth ${workAuth}`);
    assert.match(r.findings[0].detail, /Spain/);
    assert.match(r.findings[0].detail, /permit_question/);
    assert.match(r.findings[0].detail, /free movement/);
  }
});

test('work-auth-location: permit_question for the same role is consistent, and so is a German role marked not_needed', () => {
  const spain = checkReport(report({ yaml: { work_auth: 'permit_question', final_decision: 'Consider', posting_location: 'Barcelona, Spain' }, workAuthHeader: '⚠️ Permit needed — ask before applying' }), { profile: BLUE_CARD });
  assert.deepEqual(kinds(spain), []);
  const berlin = checkReport(report({ yaml: { work_auth: 'not_needed', posting_location: 'Berlin, Germany' } }), { profile: BLUE_CARD });
  assert.deepEqual(kinds(berlin), []);
});

test('work-auth-location: permit_question for a role inside authorized_in is flagged the other way', () => {
  const r = checkReport(report({ yaml: { work_auth: 'permit_question', posting_location: 'Munich, Germany' }, workAuthHeader: '⚠️ Permit needed' }), { profile: BLUE_CARD });
  assert.deepEqual(kinds(r), ['work-auth-location']);
  assert.match(r.findings[0].detail, /expected not_needed/);
});

test('work-auth check is skipped without a profile, when needs_sponsorship is not true, when the location is null, or names no country', () => {
  const spainReport = report({ yaml: { work_auth: 'not_needed', posting_location: 'Barcelona, Spain' } });
  assert.deepEqual(kinds(checkReport(spainReport, { profile: null })), []);
  assert.deepEqual(kinds(checkReport(spainReport, { profile: { authorizedIn: ['Germany'], needsSponsorship: false } })), []);
  assert.deepEqual(kinds(checkReport(spainReport, { profile: { authorizedIn: ['Germany'], needsSponsorship: null } })), []);
  assert.deepEqual(kinds(checkReport(report({ yaml: { work_auth: 'not_needed', posting_location: null } }), { profile: BLUE_CARD })), []);
  assert.deepEqual(kinds(checkReport(report({ yaml: { work_auth: 'not_needed', posting_location: 'Remote' } }), { profile: BLUE_CARD })), []);
});

test('work-auth-header: the header tier and the YAML value must agree; permit_question has its own header label', () => {
  const r = checkReport(report({ yaml: { work_auth: 'unstated' }, workAuthHeader: '➖ Not needed' }));
  assert.deepEqual(kinds(r), ['work-auth-header']);
  assert.equal(headerWorkAuth('**Work Auth:** ⚠️ Permit needed — ask before applying'), 'permit_question');
  assert.equal(headerWorkAuth('**Work Auth:** ⛔ No sponsorship'), 'no_sponsorship');
  assert.equal(headerWorkAuth('**Work Auth:** ✅ Sponsors'), 'sponsors');
  assert.equal(headerWorkAuth('no header here'), null);
});

test('work-auth-value: an invented enum value is a finding', () => {
  const r = checkReport(report({ yaml: { work_auth: 'not_needed_eu_but_spain_requires_transfer' } }));
  assert.deepEqual(kinds(r), ['work-auth-header', 'work-auth-value']);
});

test('stack-fit-contradiction: required_mismatch beside an all-Strong required stack row', () => {
  const rows = [
    { requirement: 'Hands-on experience with C#/.NET, Java/JVM, JavaScript/Node, or Go', importance: 'critical (stated)', match: '✅ Strong', evidence: 'Node.js at Acme (_context.md)' },
    { requirement: 'Leads teams using React, Swift/Kotlin, Python/ML frameworks', importance: 'preferred (structural)', match: '⚠️ Partial', evidence: 'React Strong; Swift/Kotlin not evidenced' },
    { requirement: 'Runs 1:1s and growth plans', importance: 'high (structural)', match: '✅ Strong', evidence: 'growth framework (_context.md)' },
  ];
  const jev = { model: 'typesafe/jev-1.13', fit: 49, score: 3.0, verdict: 'apply', blocking: ['stack_fit=required_mismatch'], reasons: { seniority_match: 'match', location_ok: 'yes', language_blocker: 'none', team_type: 'product', stack_fit: 'required_mismatch' } };
  const r = checkReport(report({ yaml: { jev }, rows }));
  assert.deepEqual(kinds(r), ['stack-fit-contradiction']);
  assert.match(r.findings[0].detail, /C#\/\.NET/);
  assert.doesNotMatch(r.findings[0].detail, /Swift\/Kotlin/, 'a preferred-tier row does not enter the required-tier set');
});

test('stack-fit-contradiction: a Partial or Missing required stack row reconciles the mismatch; stack_agnostic never fires', () => {
  const jev = { model: 'typesafe/jev-1.13', fit: 49, score: 3.0, verdict: 'maybe', blocking: [], reasons: { seniority_match: 'match', location_ok: 'yes', language_blocker: 'none', team_type: 'product', stack_fit: 'required_mismatch' } };
  const rows = [
    { requirement: 'Hands-on Go and Kubernetes', importance: 'critical (stated)', match: '❌ Missing', evidence: 'No Go in any primary file' },
    { requirement: 'Node.js services', importance: 'high (stated)', match: '✅ Strong', evidence: 'Node.js at Acme' },
  ];
  assert.deepEqual(kinds(checkReport(report({ yaml: { jev }, rows }))), []);
  const agnostic = report({ rows: [{ requirement: 'Python and Docker', importance: 'critical (stated)', match: '✅ Strong', evidence: 'Python at Acme' }] });
  assert.deepEqual(kinds(checkReport(agnostic)), []);
  const noStackRows = report({ yaml: { jev }, rows: [{ requirement: 'Hands-on in technical and design discussions', match: '✅ Strong', evidence: 'RFC reviews' }] });
  assert.deepEqual(kinds(checkReport(noStackRows)), [], 'a habit is not a stack row');
});

test('apply-with-hard-stops and apply-with-permit-question', () => {
  const hard = checkReport(report({ yaml: { final_decision: 'Apply', hard_stops: ['JD requires 18 direct reports; context records 9'] } }));
  assert.deepEqual(kinds(hard), ['apply-with-hard-stops']);
  assert.match(hard.findings[0].detail, /Research first/);
  const permit = checkReport(report({ yaml: { final_decision: 'Apply', work_auth: 'permit_question', posting_location: 'Lisbon, Portugal' }, workAuthHeader: '⚠️ Permit needed' }), { profile: BLUE_CARD });
  assert.deepEqual(kinds(permit), ['apply-with-permit-question']);
  const consider = checkReport(report({ yaml: { final_decision: 'Consider', hard_stops: ['one'] } }));
  assert.deepEqual(kinds(consider), []);
  const emptyStrings = checkReport(report({ yaml: { final_decision: 'Apply', hard_stops: [''] } }));
  assert.deepEqual(kinds(emptyStrings), [], 'a blank entry is not a hard stop');
});

test('withoutClauses: "without" plus a noun, not a verb-led or article-led description', () => {
  assert.deepEqual(withoutClauses('Delivery improved without headcount growth').map((c) => c.nouns), [['headcount']]);
  assert.deepEqual(withoutClauses('shipped faster without adding people').map((c) => c.nouns), [['people']]);
  assert.deepEqual(withoutClauses('coordinated work without owning all priorities'), []);
  assert.deepEqual(withoutClauses('led without being the bottleneck'), []);
  assert.deepEqual(withoutClauses('stable without a fundamental change'), []);
  assert.deepEqual(withoutClauses('no such word here'), []);
});

test('without-clause-unsupported: a strength says "without headcount growth" and no Evidence cell mentions headcount', () => {
  const rows = [
    { requirement: 'Measurably improved delivery without adding headcount', importance: 'critical (stated)', match: '✅ Strong', evidence: '_context.md: throughput 63 to 165 issues a month, CI p50 24 to 5.5 minutes' },
  ];
  const r = checkReport(report({ yaml: { top_strengths: ['Delivery materially improved without headcount growth'] }, rows }));
  assert.deepEqual(kinds(r), ['without-clause-unsupported']);
  assert.match(r.findings[0].detail, /top_strengths/);
  assert.match(r.findings[0].detail, /"headcount"/);
});

test('without-clause-unsupported: the Requirement cell never evidences the clause; an Evidence cell naming the noun or a synonym does', () => {
  const strengths = { top_strengths: ['Delivery materially improved without headcount growth'] };
  const evidenced = report({ yaml: strengths, rows: [{ requirement: 'Improved delivery', match: '✅ Strong', evidence: '_context.md: throughput 2.6x through process changes, not headcount growth' }] });
  assert.deepEqual(kinds(checkReport(evidenced)), []);
  const synonym = report({ yaml: strengths, rows: [{ requirement: 'Improved delivery', match: '✅ Strong', evidence: '_context.md: constant team size throughout, throughput 2.6x' }] });
  assert.deepEqual(kinds(checkReport(synonym)), [], 'team size is a synonym of headcount');
  // "people" and "hiring" appear in every engineering-manager report, so they never evidence the claim (report 583).
  const people = report({ yaml: strengths, rows: [{ requirement: 'Improved delivery', match: '✅ Strong', evidence: '_context.md: people round with the CTO, owns hiring' }] });
  assert.deepEqual(kinds(checkReport(people)), ['without-clause-unsupported']);
  const onlyInRequirement = report({ yaml: strengths, rows: [{ requirement: 'Improved delivery without headcount growth', match: '✅ Strong', evidence: '_context.md: throughput 2.6x' }] });
  assert.deepEqual(kinds(checkReport(onlyInRequirement)), ['without-clause-unsupported']);
});

test('without-clause-unsupported: the Verdict (lead) block is read too', () => {
  const r = checkReport(report({ verdict: '**Apply.** Scaled delivery without adding people, which the JD leads with.', rows: [{ requirement: 'Delivery', match: '✅ Strong', evidence: '_context.md: throughput 2.6x' }] }));
  assert.deepEqual(kinds(r), ['without-clause-unsupported']);
  assert.match(r.findings[0].detail, /Verdict \(lead\)/);
  assert.equal(verdictText('## Veredicto (lead)\n\n**Aplicar.** Razón.\n\n## Risk Summary\n\nx').trim(), '**Aplicar.** Razón.');
  assert.equal(clauseEvidenced({ nouns: ['headcount'] }, null), false);
});

test('a report without a Machine Summary is unverified, never a pass', () => {
  const r = checkReport('# Evaluation: Acme\n\n## B) Match with CV\n\n| Requirement | Importance | Match | JD signal | Evidence / gap |\n|---|---|---|---|---|\n| x | high (stated) | ✅ Strong | "x" | y |\n');
  assert.equal(r.status, 'unverified');
  assert.deepEqual(r.findings, []);
});

test('readProfileLocation reads authorized_in and needs_sponsorship, and returns null for a missing file or location block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vrc-profile-'));
  try {
    const p = join(dir, 'profile.yml');
    writeFileSync(p, PROFILE);
    assert.deepEqual(readProfileLocation(p), { authorizedIn: ['Germany'], needsSponsorship: true });
    writeFileSync(p, 'name: "x"\n');
    assert.equal(readProfileLocation(p), null);
    assert.equal(readProfileLocation(join(dir, 'absent.yml')), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- CLI ----

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'vrc-root-'));
  mkdirSync(join(root, 'config'));
  mkdirSync(join(root, 'reports'));
  writeFileSync(join(root, 'config', 'profile.yml'), PROFILE);
  writeFileSync(join(root, 'reports', '001-spain-2026-11-01.md'), report({ yaml: { work_auth: 'unstated', posting_location: 'Barcelona, Spain' }, workAuthHeader: '⚠️ Unstated' }));
  writeFileSync(join(root, 'reports', '002-berlin-2026-11-01.md'), report({ yaml: { work_auth: 'not_needed', posting_location: 'Berlin, Germany' } }));
  writeFileSync(join(root, 'reports', '003-legacy-2026-11-01.md'), '# Evaluation: Legacy\n\nNo YAML here.\n');
  return root;
}

function run(args, root) {
  const env = { ...process.env, CAREER_OPS_ROOT: root };
  delete env.CAREER_OPS_PROFILE;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', env, cwd: ROOT });
}

test('CLI: one report, text output, exit 0 with a finding; --strict exits 1', () => {
  const root = fixtureRoot();
  try {
    const spain = join(root, 'reports', '001-spain-2026-11-01.md');
    const r = run([spain], root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /work-auth-location/);
    assert.match(r.stdout, /1 finding\(s\) in 1 report\(s\)/);
    const strict = run([spain, '--strict'], root);
    assert.equal(strict.status, 1);
    const clean = run([join(root, 'reports', '002-berlin-2026-11-01.md'), '--strict'], root);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, /0 finding\(s\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: --all over a directory, --json shape, unverified legacy report, --strict on unverified', () => {
  const root = fixtureRoot();
  try {
    const r = run([join(root, 'reports'), '--all', '--json'], root);
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout);
    assert.equal(json.profile, join(root, 'config', 'profile.yml'));
    assert.equal(json.reports.length, 3);
    assert.equal(json.total, 1);
    const byName = Object.fromEntries(json.reports.map((x) => [x.report.split('/').pop(), x]));
    assert.equal(byName['001-spain-2026-11-01.md'].status, 'findings');
    assert.equal(byName['002-berlin-2026-11-01.md'].status, 'ok');
    assert.equal(byName['003-legacy-2026-11-01.md'].status, 'unverified');
    const strict = run([join(root, 'reports'), '--all', '--strict'], root);
    assert.equal(strict.status, 1);
    assert.match(strict.stdout, /UNVERIFIED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: a directory without --all, a missing file and an unknown flag exit 2; --profile overrides the data root', () => {
  const root = fixtureRoot();
  try {
    assert.equal(run([join(root, 'reports')], root).status, 2);
    assert.equal(run([join(root, 'reports', 'nope.md')], root).status, 2);
    assert.equal(run(['--bogus'], root).status, 2);
    assert.equal(run([], root).status, 2);
    const other = join(root, 'other-profile.yml');
    writeFileSync(other, 'location:\n  authorized_in: ["Spain"]\n  needs_sponsorship: true\n');
    const r = run([join(root, 'reports', '001-spain-2026-11-01.md'), '--profile', other, '--json'], root);
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout);
    assert.equal(json.profile, other);
    assert.equal(json.total, 0, 'with Spain authorized, the unstated tier is not a location finding');
    const result = verifyReportConsistency({ path: join(root, 'reports', '001-spain-2026-11-01.md'), dataRoot: root });
    assert.equal(result.total, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI never writes: the data root holds only what the fixture wrote', () => {
  const root = fixtureRoot();
  try {
    run([join(root, 'reports'), '--all'], root);
    assert.deepEqual(readdirSync(root).sort(), ['config', 'reports']);
    assert.deepEqual(readdirSync(join(root, 'reports')).sort(), ['001-spain-2026-11-01.md', '002-berlin-2026-11-01.md', '003-legacy-2026-11-01.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('work-auth-header: the tier label is read before any explanation in parentheses', () => {
  assert.equal(headerWorkAuth('**Work Auth:** ➖ Not needed (fully remote, EMEA; no sponsorship issue raised)'), 'not_needed');
  assert.equal(headerWorkAuth('**Work Auth:** ➖ Not needed — no sponsorship question relevant'), 'not_needed');
  assert.equal(headerWorkAuth('**Work Auth:** ⛔ No sponsorship (JD: "we cannot sponsor")'), 'no_sponsorship');
  assert.equal(headerWorkAuth('**Work Auth:** ⚠️ Permit needed — ask before applying'), 'permit_question');
});

test('countryOf: the European Union and the EEA are locations a national permit does not cover', () => {
  assert.equal(countryOf('European Union'), 'European Union');
  assert.equal(countryOf('Remote, EU'), 'European Union');
  assert.equal(countryOf('European Economic Area'), 'European Economic Area');
  assert.equal(countryOf('Berlin, Germany (EU)'), 'Germany');
  assert.equal(countryOf('EMEA'), null);
  assert.equal(isAuthorized('European Union', ['Germany']), false);
  assert.equal(isAuthorized('European Union', ['EU']), true);
  assert.equal(isAuthorized('European Economic Area', ['EEA']), true);
});

test('without-clause: "people" and "hiring" in an Evidence cell no longer evidence a headcount claim; pronoun-led clauses are ignored', () => {
  assert.deepEqual(withoutClauses('apply without hesitation once it arrives'), []);
  const table = { cols: { evidence: 2 }, rows: [['Req', 'Strong', 'Led a people round with the CTO; owns hiring']] };
  assert.equal(clauseEvidenced({ nouns: ['headcount'] }, table), false);
  const evidenced = { cols: { evidence: 2 }, rows: [['Req', 'Strong', 'Throughput up 2.6x at constant team size (_context.md:12)']] };
  assert.equal(clauseEvidenced({ nouns: ['headcount'] }, evidenced), true);
});

// The report fixture's header is dated 2026-11-01; posting-age findings count from it.
const AGE_ENTRY = 'Evergreen or re-listed requisition (posting-age.mjs): first posted 2026-07-01 (scan-history title identity), 123 days before 2026-11-01; re-listed 3 times between 2026-07-01 and 2026-09-20 (detect-reposts.mjs). Verdict capped at Consider; Block G at most Proceed with Caution.';

test('posting-age-hard-stop-missing: an old posting_first_seen or a repost_count of 3 without the evergreen entry', () => {
  const old = checkReport(report({ yaml: { final_decision: 'Consider', posting_first_seen: '2026-07-01', repost_count: 1 } }));
  assert.deepEqual(kinds(old), ['posting-age-hard-stop-missing']);
  assert.match(old.findings[0].detail, /123 days before the report date 2026-11-01/);
  assert.match(old.findings[0].detail, /posting-age\.mjs/);
  const reposted = checkReport(report({ yaml: { final_decision: 'Consider', posting_first_seen: '2026-10-20', repost_count: 3 } }));
  assert.deepEqual(kinds(reposted), ['posting-age-hard-stop-missing']);
  assert.match(reposted.findings[0].detail, /repost_count 3 reaches 3/);
  const otherStop = checkReport(report({ yaml: { final_decision: 'Research first', posting_first_seen: '2026-07-01', repost_count: 3, hard_stops: ['JD requires 18 direct reports; context records 9'] } }));
  assert.deepEqual(kinds(otherStop), ['posting-age-hard-stop-missing'], 'a stack or span hard stop does not stand in for the evergreen one');
});

test('posting-age: the evergreen entry with Consider and Proceed with Caution is consistent; recent, unknown and overridden postings pass', () => {
  const capped = checkReport(report({ yaml: { final_decision: 'Consider', legitimacy_tier: 'Proceed with Caution', posting_first_seen: '2026-07-01', repost_count: 3, hard_stops: [AGE_ENTRY] } }));
  assert.deepEqual(kinds(capped), []);
  const recent = checkReport(report({ yaml: { final_decision: 'Apply', posting_first_seen: '2026-10-20', repost_count: 1 } }));
  assert.deepEqual(kinds(recent), []);
  const edge = checkReport(report({ yaml: { final_decision: 'Apply', posting_first_seen: '2026-09-02', repost_count: 2 } }));
  assert.deepEqual(kinds(edge), [], 'exactly 60 days and two listings are the Medium signal, not the hard stop');
  const unknown = checkReport(report({ yaml: { final_decision: 'Apply', posting_first_seen: null, repost_count: 0 } }));
  assert.deepEqual(kinds(unknown), []);
  const legacy = checkReport(report({ yaml: { final_decision: 'Apply' } }));
  assert.deepEqual(kinds(legacy), [], 'a report written before the fields existed is not flagged');
  const overridden = checkReport(report({ yaml: { final_decision: 'Apply', posting_first_seen: '2026-07-01', repost_count: 3, soft_gaps: [`overridden: ${AGE_ENTRY}`] } }));
  assert.deepEqual(kinds(overridden), [], 'after "apply anyway" the entry lives in soft_gaps with the overridden: prefix');
});

test('posting-age-cap and posting-age-legitimacy: the evergreen entry caps the verdict at Consider and Block G at Proceed with Caution', () => {
  const apply = checkReport(report({ yaml: { final_decision: 'Apply', legitimacy_tier: 'Proceed with Caution', posting_first_seen: '2026-07-01', repost_count: 3, hard_stops: [AGE_ENTRY] } }));
  assert.deepEqual(kinds(apply), ['apply-with-hard-stops', 'posting-age-cap']);
  assert.match(apply.findings.find((f) => f.kind === 'posting-age-cap').detail, /caps the verdict at Consider/);
  const high = checkReport(report({ yaml: { final_decision: 'Consider', legitimacy_tier: 'High Confidence', posting_first_seen: '2026-07-01', repost_count: 3, hard_stops: [AGE_ENTRY] } }));
  assert.deepEqual(kinds(high), ['posting-age-legitimacy']);
  assert.match(high.findings[0].detail, /Proceed with Caution/);
  const handWritten = checkReport(report({ yaml: { final_decision: 'Apply', legitimacy_tier: 'Proceed with Caution', hard_stops: ['Role re-listed 3 times since July'] } }));
  assert.ok(kinds(handWritten).includes('posting-age-cap'), 'the pre-script wording is recognised too');
});

test('posting-age-value: a malformed date or count is a finding; the header date and today stand in for each other', () => {
  const badDate = checkReport(report({ yaml: { final_decision: 'Consider', posting_first_seen: 'July 2026', repost_count: 0 } }));
  assert.deepEqual(kinds(badDate), ['posting-age-value']);
  const badCount = checkReport(report({ yaml: { final_decision: 'Consider', posting_first_seen: '2026-10-20', repost_count: 'three' } }));
  assert.deepEqual(kinds(badCount), ['posting-age-value']);
  assert.equal(headerDate('**Date:** 2026-11-01\n'), '2026-11-01');
  assert.equal(headerDate('**Date:** 1 Nov 2026\n'), null);
  assert.equal(headerDate('no header'), null);
  assert.equal(daysBetween('2026-07-01', '2026-11-01'), 123);
  assert.equal(daysBetween('x', '2026-11-01'), null);
  const noHeader = report({ yaml: { final_decision: 'Consider', posting_first_seen: '2026-07-01', repost_count: 1 } }).replace(/^\*\*Date:\*\*.*$/m, '');
  assert.deepEqual(kinds(checkReport(noHeader, { today: '2026-08-15' })), [], '45 days by today');
  assert.deepEqual(kinds(checkReport(noHeader, { today: '2026-09-15' })), ['posting-age-hard-stop-missing'], '76 days by today');
});
