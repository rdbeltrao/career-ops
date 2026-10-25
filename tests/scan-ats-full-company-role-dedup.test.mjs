// tests/scan-ats-full-company-role-dedup.test.mjs — the reverse ATS sweep must
// not re-add a role the user already has under another URL.
//
// scan-ats-full.mjs deduplicated by URL only. A role first found on LinkedIn and
// evaluated there (a tracker row, a processed pipeline line) came back from the
// sweep as a new pipeline row the moment its Ashby or Greenhouse URL turned up,
// because the two URLs never match. scan.mjs already applies a company+role
// check against the same three sources; createCompanyRoleGate() exposes that
// check, and the sweep consults it before it keeps an offer.
import { pass, fail } from './helpers.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCompanyRoleGate } from '../scan.mjs';
import { keepAndMaybeEmit } from '../scan-ats-full.mjs';

console.log('\nscan-ats-full — company+role dedup against roles already seen under another URL');

const TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 200 | 2026-10-24 | Statista | Engineering Manager - Data Platform (m/f/d) | 2/5 | Evaluated | ❌ | [200](reports/200-statista-2026-10-24.md) |  |
`;

const PIPELINE = `# Pipeline

## Pending

## Processed

- [x] [236](../reports/236-pragmatike-2026-10-24.md) | https://www.linkedin.com/jobs/view/4476314224/ | Pragmatike | Engineering Manager (Distributed P2P Systems) | N/A | PDF ❌
`;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'co-atsfull-role-'));
  const paths = {
    applicationsPath: join(dir, 'applications.md'),
    pipelinePath: join(dir, 'pipeline.md'),
    scanHistoryPath: join(dir, 'scan-history.tsv'),
  };
  writeFileSync(paths.applicationsPath, TRACKER);
  writeFileSync(paths.pipelinePath, PIPELINE);
  writeFileSync(paths.scanHistoryPath, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n');
  return { dir, paths };
}

const { dir, paths } = sandbox();
try {
  const gate = createCompanyRoleGate({}, paths);

  const statistaAshby = { company: 'statista', title: 'Engineering Manager - Data Platform (m/f/d)', url: 'https://jobs.ashbyhq.com/statista/d13572c5-0691-41dd-b57e-5d109cd869af' };
  if (gate.admit(statistaAshby) === false) pass('a tracker role seen under a LinkedIn URL is not re-admitted from its Ashby URL');
  else fail('the Ashby URL of an evaluated tracker role was admitted as new');

  const pragmatikeAshby = { company: 'pragmatike', title: 'Engineering Manager (Distributed P2P Systems)', url: 'https://jobs.ashbyhq.com/pragmatike/023fa634-e6f2-4a31-8069-3a24d9cd6f37' };
  if (gate.admit(pragmatikeAshby) === false) pass('a processed pipeline role is not re-admitted from another URL');
  else fail('the Ashby URL of a processed pipeline role was admitted as new');

  const affinidi = { company: 'affinidi', title: 'Senior Engineering Manager (m/f/d)', url: 'https://job-boards.greenhouse.io/affinidi/jobs/8012939003' };
  if (gate.admit(affinidi) === true) pass('a role never seen before is admitted');
  else fail('a new role was rejected');

  const affinidiMirror = { ...affinidi, url: 'https://jobs.lever.co/affinidi/abc' };
  if (gate.admit(affinidiMirror) === false) pass('the same new role is admitted once per run');
  else fail('the same new role was admitted twice in one run');

  // keepAndMaybeEmit is the single place both sweep paths keep an offer.
  const sink = [];
  keepAndMaybeEmit(statistaAshby, 'ashby-full', sink, new Map(), { json: true, companyRoleGate: createCompanyRoleGate({}, paths) });
  if (sink.length === 0) pass('keepAndMaybeEmit drops an offer the gate rejects');
  else fail(`keepAndMaybeEmit kept a duplicate role: ${JSON.stringify(sink)}`);

  const kept = [];
  keepAndMaybeEmit(affinidi, 'greenhouse-full', kept, new Map(), { json: true, companyRoleGate: createCompanyRoleGate({}, paths) });
  if (kept.length === 1) pass('keepAndMaybeEmit keeps an offer the gate admits');
  else fail('keepAndMaybeEmit dropped a new role');

  const noGate = [];
  keepAndMaybeEmit(statistaAshby, 'ashby-full', noGate, new Map(), { json: true });
  if (noGate.length === 1) pass('keepAndMaybeEmit without a gate keeps its URL-only behavior');
  else fail('keepAndMaybeEmit without a gate dropped an offer');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
