import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import '../helpers/web-ts-alias-loader.mjs';
const { GET, POST } = await import('../../src/app/api/config-files/route.ts');

test('config API lists metadata only, respects overrides, validates edits, and reports conflicts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-config-route-'));
  const overrides = { CAREER_OPS_ROOT: root, CAREER_OPS_CODE_ROOT: path.resolve(import.meta.dirname, '../../..'), CAREER_OPS_PORTALS: path.join(root, 'lane.yaml'), CAREER_OPS_PROFILE: 'candidate.yaml' };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const req = (suffix = '') => new Request('http://localhost:3000/api/config-files' + suffix);
  const post = (body) => POST(new Request('http://localhost:3000/api/config-files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  let response = await GET(req());
  const catalog = await response.json();
  assert.equal(catalog.files.length, 5);
  assert.ok(catalog.files.every((file) => !('content' in file)));
  assert.deepEqual(fs.readdirSync(root), []);
  for (const [id, file] of [['portals', 'lane.yaml'], ['profile', 'candidate.yaml']]) {
    response = await GET(req(`?file=${id}`));
    const missing = await response.json();
    assert.equal(missing.exists, false);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    response = await post({ file: id, revision: missing.revision, content: '# Fictional fixture\nexample: true\n' });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), saved.content);
    assert.equal((await post({ file: id, revision: missing.revision, content: 'other: value\n' })).status, 409);
    assert.equal((await post({ file: id, revision: saved.revision, content: 'broken: [' })).status, 400);
    assert.equal((await GET(req(`?file=${id}`))).status, 200);
  }
  assert.equal((await GET(req('?file=..%2Fprivate'))).status, 404);
  assert.equal((await post({ file: 'portals', content: 'no: revision\n' })).status, 400);
  assert.equal((await post(null)).status, 400);
  assert.equal((await post([])).status, 400);
  assert.equal((await POST(new Request(req(), { method: 'POST', body: '{broken' }))).status, 400);
  fs.unlinkSync(path.join(root, 'lane.yaml'));
  fs.mkdirSync(path.join(root, 'lane.yaml'));
  assert.equal((await GET(req('?file=portals'))).status, 409, 'unreadable is not missing');
});
