import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('CLI URL selection uses the same ATS guidance and explicit precedence as the web', t => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-template-cli-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataRoot, 'config'));
  fs.writeFileSync(path.join(dataRoot, 'config/profile.yml'), 'cv:\n  template: executive\n  ats_guidance: true\n  ats_templates:\n    ashby: compact\n');
  const run = (...args) => spawnSync(process.execPath, ['cv-templates.mjs', 'resolve', 'cv', ...args], { cwd: root, env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_PROFILE: path.join(dataRoot, 'config/profile.yml') }, encoding: 'utf8' });
  const greenhouse = run('--url=https://boards.greenhouse.io/example/jobs/1');
  assert.equal(greenhouse.status, 0, greenhouse.stderr);
  assert.equal(greenhouse.stdout.trim(), path.join(root, 'templates/ats/cv-template.ats.html'));
  const ashby = run('--url=https://jobs.ashbyhq.com/example/1');
  assert.equal(ashby.stdout.trim(), path.join(root, 'templates/cv-template.compact.html'));
  const explicit = run('jake', '--url=https://boards.greenhouse.io/example/jobs/1');
  assert.equal(explicit.stdout.trim(), path.join(root, 'templates/cv-template.jake.html'));
});
