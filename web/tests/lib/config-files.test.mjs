import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONFIG_FILES, MAX_CONFIG_BYTES, readConfigFile, saveConfigFile } from '../../src/lib/config-files.mjs';
import '../helpers/web-ts-alias-loader.mjs';
const { atomicWriteWithBackup } = await import('../../src/lib/core/safe-write.ts');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-config-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, portalsPath: path.join(root, 'portals.yml'), profilePath: path.join(root, 'config/profile.yml') };
}
function put(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function save(location, before, content, write = atomicWriteWithBackup) {
  return saveConfigFile({ location, request: { file: before.id, revision: before.revision, content }, write });
}

test('only known user configuration files can be opened; missing reads create nothing', (t) => {
  const location = fixture(t);
  assert.deepEqual(CONFIG_FILES.map((file) => file.id), ['portals', 'profile', 'jev-criteria', 'notion-map', 'plugins']);
  for (const file of CONFIG_FILES) assert.equal(readConfigFile(location, file.id).exists, false);
  assert.deepEqual(fs.readdirSync(location.root), []);
  for (const id of ['../cv.md', '/etc/passwd', '__proto__', 'templates/states.yml', 'config/profile.yml', null]) {
    assert.throws(() => readConfigFile(location, id), (error) => error.status === 404);
  }
});

test('raw comments, quoting, and line endings survive saves; backup contains previous bytes', (t) => {
  const location = fixture(t);
  const original = '# Fictional settings\r\ntitle_filter:\r\n  positive: ["Example Engineer"]\r\n';
  put(location.portalsPath, original);
  const before = readConfigFile(location, 'portals');
  const edited = original.replace('Example Engineer', 'Research Engineer');
  const after = save(location, before, edited);
  assert.equal(after.content, edited);
  assert.equal(after.backedUp, true);
  assert.equal(after.warning, null);
  const backup = fs.readdirSync(location.root).find((file) => file.startsWith('portals.yml.bak-'));
  assert.equal(fs.readFileSync(path.join(location.root, backup), 'utf8'), original);
  assert.throws(() => save(location, before, original), (error) => error.status === 409 && error.code === 'stale');
  let writes = 0;
  save(location, after, edited, () => writes++);
  assert.equal(writes, 0, 'no-op saves do not create redundant backups');
});

test('missing files can be explicitly created; existing empty files have another revision', (t) => {
  const location = fixture(t);
  const missing = readConfigFile(location, 'plugins');
  const created = save(location, missing, 'plugins: []\n');
  assert.equal(created.exists, true);
  assert.equal(created.backedUp, false);
  const absentProfile = readConfigFile(location, 'profile');
  put(location.profilePath, '');
  assert.notEqual(readConfigFile(location, 'profile').revision, absentProfile.revision);
  assert.throws(() => save(location, absentProfile, 'candidate: {}\n'), (error) => error.code === 'stale');
});

test('malformed YAML remains readable and repairable; invalid edits never replace it', (t) => {
  const location = fixture(t);
  put(location.portalsPath, 'title_filter: [\n');
  const broken = readConfigFile(location, 'portals');
  assert.equal(broken.exists, true);
  assert.match(broken.warning, /Invalid YAML at line/);
  assert.equal(broken.content, 'title_filter: [\n');
  let writes = 0;
  for (const content of ['title_filter: [\n', 'same: 1\nsame: 2\n', '[]', 'false', '', '# comments only\n', '---\na: 1\n---\nb: 2\n']) {
    assert.throws(() => save(location, broken, content, () => writes++), (error) => error.code === 'invalid_yaml');
  }
  assert.equal(writes, 0);
  assert.equal(save(location, broken, 'title_filter: {}\n').warning, null);
});

test('profile and portal overrides are used without touching default files', (t) => {
  const defaults = fixture(t);
  const external = fixture(t);
  put(defaults.portalsPath, 'default: true\n');
  put(defaults.profilePath, 'default: true\n');
  put(external.portalsPath, 'external: portals\n');
  put(external.profilePath, 'external: profile\n');
  const location = { ...defaults, portalsPath: external.portalsPath, profilePath: external.profilePath };
  for (const id of ['portals', 'profile']) {
    const before = readConfigFile(location, id);
    assert.equal(fs.realpathSync(before.path), fs.realpathSync(id === 'profile' ? external.profilePath : external.portalsPath));
    save(location, before, 'external: updated\n');
  }
  assert.equal(fs.readFileSync(defaults.portalsPath, 'utf8'), 'default: true\n');
  assert.equal(fs.readFileSync(defaults.profilePath, 'utf8'), 'default: true\n');
  const old = readConfigFile(location, 'portals');
  put(defaults.portalsPath, old.content);
  assert.throws(() => save(defaults, old, 'changed: true\n'), (error) => error.code === 'stale', 'revision also binds the target path');
});

test('symlink files, linked config directories, non-files, and invalid UTF-8 are refused', (t) => {
  const location = fixture(t);
  const external = fixture(t);
  put(external.portalsPath, 'outside: true\n');
  fs.symlinkSync(external.portalsPath, location.portalsPath);
  assert.throws(() => readConfigFile(location, 'portals'), /symlink/i);
  assert.throws(() => readConfigFile({ ...external, portalsPath: location.portalsPath }, 'portals'), /symlink/i);
  fs.symlinkSync(external.root, path.join(location.root, 'config'), 'dir');
  assert.throws(() => readConfigFile(location, 'profile'), /symlink/i);
  fs.unlinkSync(location.portalsPath);
  fs.mkdirSync(location.portalsPath);
  assert.throws(() => readConfigFile(location, 'portals'), /regular file/i);
  fs.rmdirSync(location.portalsPath);
  put(location.portalsPath, Buffer.from([0xc3, 0x28]));
  assert.throws(() => readConfigFile(location, 'portals'), /UTF-8/i);
});

test('oversized or invalid text, absent revisions, and failed backups do not overwrite files', (t) => {
  const location = fixture(t);
  put(location.portalsPath, 'original: true\n');
  const before = readConfigFile(location, 'portals');
  let writes = 0;
  for (const content of [undefined, 42, 'text: \ud800', 'text: ' + 'é'.repeat(MAX_CONFIG_BYTES)]) {
    assert.throws(() => save(location, before, content, () => writes++));
  }
  assert.equal(writes, 0);
  assert.throws(() => save(location, { ...before, revision: undefined }, 'valid: true\n'), (error) => error.code === 'invalid_revision');
  assert.throws(() => save(location, before, 'valid: true\n', () => { throw new Error('backup failed: ENOSPC'); }), /backup failed: ENOSPC/);
  assert.equal(readConfigFile(location, 'portals').content, before.content);
  put(location.portalsPath, 'x'.repeat(MAX_CONFIG_BYTES + 1));
  assert.throws(() => readConfigFile(location, 'portals'), (error) => error.status === 413);
});
