// tests/verify-block-b-context.test.mjs — verify-block-b-context.mjs flags a
// Block B row marked missing when modes/_context.md carries the requirement,
// and any row that gives cv.md's silence as the gap. The context file is the
// source of truth about the candidate, so an evaluation that judged the person
// on cv.md alone is what this check catches. It never edits anything.
//
// Run:  node --test tests/verify-block-b-context.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkRows, distinctiveTerms, findBlockB, findMatchTable, stem } from '../verify-block-b-context.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'verify-block-b-context.mjs');

const CONTEXT = `# Fit profile

## Experience details

- Led the web marketplace: catalogue and search (managed), information architecture of the shop, checkout.
- Built a role-specific AI plugin for the developer platform, in daily use by the product teams since 2025-03.
- PHP (Symfony 6.4), Vue 3, TypeScript, Node.js, PostgreSQL.
`;

const REPORT_WITH_GAPS = `# Report 042 — Acme — 2026-10-25

**Score:** 3.8/5

## A) Snapshot

| Field | Value |
|---|---|
| **Company** | Acme |

## B) Match with CV

| Requirement | Importance | Match | JD signal | Evidence / gap |
|---|---|---|---|---|
| PHP and Symfony | critical (stated) | ✅ Strong | "PHP/Symfony" | cv.md: PHP (Symfony 6.4) |
| Frontend leadership: TypeScript and Node.js | high (structural) | ❌ Missing | "led frontend teams on TypeScript" | None in cv.md |
| Navigation, search, information architecture | high (stated) | ❌ Missing | "navigation and search" | cv.md does not mention it |
| Kubernetes operations at scale | meaningful (inferred) | ❌ Missing | — | No Kubernetes operations work found |

### Gaps

| Gap | Severity | Mitigation |
|---|---|---|
| Kubernetes | Low | Mention Docker-based deployments |

## C) Level and Strategy

Senior.
`;

const REPORT_GENUINE_GAP = `# Report 043 — Acme — 2026-10-25

## Block B — Match with CV

| Requirement | Importance | Match | JD signal | Evidence / gap |
|---|---|---|---|---|
| PHP and Symfony | critical (stated) | ✅ Strong | "PHP/Symfony" | cv.md: PHP (Symfony 6.4) |
| Kubernetes operations at scale | high (stated) | ❌ Missing | "operate our Kubernetes clusters" | Deployment work is Docker-based; no cluster operations in any source |

## C) Level and Strategy
`;

const REPORT_NO_TABLE = `# Report 044 — Acme — 2026-10-25

## A) Snapshot

| Field | Value |
|---|---|
| **Company** | Acme |

## C) Level and Strategy

No Block B here.
`;

function fixture(t, { context = CONTEXT } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'block-b-ctx-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }));
  mkdirSync(join(root, 'modes'));
  mkdirSync(join(root, 'reports'));
  if (context !== null) writeFileSync(join(root, 'modes', '_context.md'), context);
  return root;
}

function run(root, args) {
  const env = { ...process.env, CAREER_OPS_ROOT: root };
  delete env.CAREER_OPS_DATA_DIR;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', env, cwd: ROOT });
}

test('stem and distinctiveTerms agree on both sides and skip filler', () => {
  assert.equal(stem('teams'), 'team');
  assert.equal(stem('libraries'), 'library');
  assert.equal(stem('operations'), 'operation');
  assert.equal(stem('managing'), 'manag');
  assert.equal(stem('managed'), 'manag');
  assert.equal(stem('process'), 'process');
  const terms = distinctiveTerms('Developer platform / plugin teams with strong experience in Vue 3');
  assert.deepEqual([...terms.keys()], ['developer', 'platform', 'plugin']);
  assert.equal(terms.get('developer').properNoun, false, 'sentence-initial capital is not a proper noun');
  const tech = distinctiveTerms('Experience with Kubernetes and OAuth2');
  assert.equal(tech.get('kubernet').properNoun, true);
  assert.equal(tech.get('oauth2').properNoun, true);
});

test('findBlockB accepts the heading shapes reports use and keeps sub-sections inside', () => {
  const section = findBlockB(REPORT_WITH_GAPS);
  assert.match(section, /Frontend leadership/);
  assert.match(section, /### Gaps/);
  assert.doesNotMatch(section, /Level and Strategy/);
  assert.match(findBlockB(REPORT_GENUINE_GAP), /Kubernetes operations/);
  assert.match(findBlockB('## B) CV Match\n\n| JD Requirement | CV Match | Source |\n|---|---|---|\n| x | y | z |\n'), /JD Requirement/);
  assert.equal(findBlockB(REPORT_NO_TABLE), null);
  const table = findMatchTable(findBlockB(REPORT_WITH_GAPS));
  assert.deepEqual(table.cols, { requirement: 0, match: 2, signal: 3, evidence: 4 });
  assert.equal(table.rows.length, 4);
});

test('checkRows flags the rows the context carries and the cv.md-silence gaps, not the genuine gap', () => {
  const findings = checkRows(findMatchTable(findBlockB(REPORT_WITH_GAPS)), CONTEXT);
  const kinds = findings.map((f) => `${f.kind}:${f.requirement}`).sort();
  assert.deepEqual(kinds, [
    'context-has-it:Frontend leadership: TypeScript and Node.js',
    'context-has-it:Navigation, search, information architecture',
    'cv-silence-as-gap:Frontend leadership: TypeScript and Node.js',
    'cv-silence-as-gap:Navigation, search, information architecture',
  ]);
  const frontend = findings.find((f) => f.kind === 'context-has-it' && /TypeScript/.test(f.requirement));
  assert.deepEqual(frontend.terms.map((t) => t.toLowerCase()).sort(), ['node', 'typescript']);
  const search = findings.find((f) => f.kind === 'context-has-it' && /search/.test(f.requirement));
  assert.ok(search.terms.some((t) => /search/i.test(t)));
  assert.ok(search.terms.some((t) => /architecture/i.test(t)));
  assert.equal(findings.filter((f) => /Kubernetes/.test(f.requirement)).length, 0);
  assert.equal(findings.filter((f) => /Symfony/.test(f.requirement)).length, 0);
});

test('(a) a report whose Block B marks context-backed requirements missing: findings, --strict exit 1, --json shape', (t) => {
  const root = fixture(t);
  const report = join(root, 'reports', '042-acme-2026-10-25.md');
  writeFileSync(report, REPORT_WITH_GAPS);
  const text = run(root, [report]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /⚠️ {2}context-has-it {2}row "Frontend leadership: TypeScript and Node.js" \(❌ Missing\): modes\/_context\.md mentions /);
  assert.match(text.stdout, /⚠️ {2}cv-silence-as-gap {2}row "Navigation, search, information architecture" \(❌ Missing\): cv\.md silence is never a gap/);
  assert.match(text.stdout, /^4 finding\(s\) in /m);
  const strict = run(root, [report, '--strict']);
  assert.equal(strict.status, 1);
  const json = run(root, [report, '--json']);
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.report, report);
  assert.equal(parsed.context, join(root, 'modes', '_context.md'));
  assert.equal(parsed.status, 'findings');
  assert.equal('reason' in parsed, false);
  assert.equal(parsed.findings.length, 4);
  for (const f of parsed.findings) {
    assert.deepEqual(Object.keys(f).sort(), ['evidence', 'kind', 'match', 'requirement', 'terms']);
    assert.ok(Array.isArray(f.terms));
  }
  const silence = parsed.findings.find((f) => f.kind === 'cv-silence-as-gap' && /TypeScript/.test(f.requirement));
  assert.equal(silence.evidence, 'None in cv.md');
  // --context overrides the data-root default.
  const elsewhere = join(root, 'other-context.md');
  writeFileSync(elsewhere, '# Fit profile\n\nNothing relevant here.\n');
  const overridden = JSON.parse(run(root, [report, '--json', '--context', elsewhere]).stdout);
  assert.equal(overridden.context, elsewhere);
  assert.deepEqual(overridden.findings.map((f) => f.kind), ['cv-silence-as-gap', 'cv-silence-as-gap']);
});

test('(b) a genuinely missing requirement against a context that never mentions it: no finding, exit 0', (t) => {
  const root = fixture(t);
  const report = join(root, 'reports', '043-acme-2026-10-25.md');
  writeFileSync(report, REPORT_GENUINE_GAP);
  const text = run(root, [report, '--strict']);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout, `0 finding(s) in ${report}\n`);
  const parsed = JSON.parse(run(root, [report, '--json']).stdout);
  assert.equal(parsed.status, 'ok');
  assert.deepEqual(parsed.findings, []);
});

test('(c) an absent context file is unverified, exit 2, never a pass', (t) => {
  const root = fixture(t, { context: null });
  const report = join(root, 'reports', '042-acme-2026-10-25.md');
  writeFileSync(report, REPORT_WITH_GAPS);
  const text = run(root, [report]);
  assert.equal(text.status, 2);
  assert.match(text.stderr, /context file not found/);
  const json = run(root, [report, '--json']);
  assert.equal(json.status, 2);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.status, 'unverified');
  assert.match(parsed.reason, /context file not found/);
  assert.deepEqual(parsed.findings, []);
});

test('(d) a report without a Block B table is unverified: exit 0, exit 1 under --strict', (t) => {
  const root = fixture(t);
  const report = join(root, 'reports', '044-acme-2026-10-25.md');
  writeFileSync(report, REPORT_NO_TABLE);
  const text = run(root, [report]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^UNVERIFIED: no-block-b-table/);
  const parsed = JSON.parse(run(root, [report, '--json']).stdout);
  assert.equal(parsed.status, 'unverified');
  assert.equal(parsed.reason, 'no-block-b-table');
  assert.equal(run(root, [report, '--strict']).status, 1);
});

test('usage errors and an unreadable report exit 2', (t) => {
  const root = fixture(t);
  assert.equal(run(root, []).status, 2);
  assert.equal(run(root, ['--bogus']).status, 2);
  assert.equal(run(root, [join(root, 'reports', 'nope.md')]).status, 2);
  assert.equal(run(root, ['--help']).status, 0);
});
