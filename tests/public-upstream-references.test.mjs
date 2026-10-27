import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pass, fail, ROOT } from './helpers.mjs';
import { approvedUpstreamReference } from './helpers/public-upstream-references.mjs';

// Split these diagnostic fixtures so the repository privacy scan does not
// mistake its own injected candidate-data probes for source data.
const authorName = 'San' + 'tiago';
const authorDomain = 'santi' + 'fer.io';
const authorEmail = `hi@${authorDomain}`;
const cases = [
  ['.github/scripts/ci-approve.mjs', authorName],
  ['.github/scripts/direction-gate.mjs', authorName],
  ['.github/scripts/gfi-handoff.mjs', authorName],
  ['.github/scripts/triage.bundle.mjs', authorName],
  ['.github/workflows/direction-gate.yml', authorName],
  ['.github/workflows/gfi-handoff.yml', authorName],
  ['README.vi.md', authorName],
  ['README.vi.md', authorDomain],
  ['README.vi.md', authorEmail],
];

console.log('\nPrivacy check: reviewed public upstream references');
for (const [file, pattern] of cases) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  if (approvedUpstreamReference(file, pattern, source)) {
    pass(`reviewed public reference recognized in ${file}`);
  } else {
    fail(`reviewed public reference was not recognized in ${file}`);
  }

  if (approvedUpstreamReference(file, pattern, source.replace(/\r?\n/g, '\r\n'))) {
    pass(`reviewed public reference recognized with CRLF in ${file}`);
  } else {
    fail(`line endings changed public-reference approval in ${file}`);
  }

  if (!approvedUpstreamReference(file, pattern, `${source}\nCandidate achievement: ${pattern} managed 100 people.\n`)) {
    pass(`new candidate data remains detectable in ${file}`);
  } else {
    fail(`new candidate data was incorrectly exempted in ${file}`);
  }

  const altered = source.split('\n').map(line => line.includes(pattern) ? `${line} candidate achievement` : line).join('\n');
  if (!approvedUpstreamReference(file, pattern, altered)) {
    pass(`edited reference requires review in ${file}`);
  } else {
    fail(`edited reference was incorrectly exempted in ${file}`);
  }
}

const workflow = '.github/workflows/direction-gate.yml';
const workflowSource = readFileSync(join(ROOT, workflow), 'utf8');
for (const [label, result] of [
  ['a sibling path is not approved', approvedUpstreamReference(`fixtures/${workflow}`, authorName, workflowSource)],
  ['a different pattern is not approved', approvedUpstreamReference(workflow, authorDomain, `${workflowSource}\n${authorDomain}`)],
  ['a missing matching line is not approved', approvedUpstreamReference(workflow, authorName, 'name: example\n')],
]) {
  if (!result) pass(label);
  else fail(label);
}

// git grep treats an unescaped dot as a BRE wildcard. Every line it matches
// must be reviewed, even when the exact diagnostic text is absent from it.
const readme = 'README.vi.md';
const readmeSource = readFileSync(join(ROOT, readme), 'utf8');
const fixtureDir = mkdtempSync(join(tmpdir(), 'co-privacy-bre-'));
try {
  const fixturePath = join(fixtureDir, 'candidate.txt');
  for (const pattern of [authorDomain, authorEmail]) {
    for (const separator of ['X', '\t', '\r', '😀', '\u2028']) {
      const candidateLine = `Candidate achievement: ${pattern.replace('.', separator)} managed 100 people.`;
      writeFileSync(fixturePath, `${candidateLine}\n`);
      const gitMatches = execFileSync('git', ['grep', '-G', '--no-index', '-h', '-e', pattern, '--', 'candidate.txt'], { cwd: fixtureDir, encoding: 'utf8' });
      if (gitMatches.includes(candidateLine)) pass('Git BRE finds a near-domain candidate statement');
      else fail('the adversarial privacy fixture did not match Git BRE');
      if (!approvedUpstreamReference(readme, pattern, `${readmeSource}\n${candidateLine}\n`)) {
        pass('a Git BRE wildcard match outside reviewed lines remains detectable');
      } else {
        fail('a Git BRE wildcard match outside reviewed lines was incorrectly exempted');
      }
    }
  }
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}
