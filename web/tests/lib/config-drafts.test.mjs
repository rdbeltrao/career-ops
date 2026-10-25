import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConfigDraftRecovery } from '../../src/lib/config-drafts.mjs';

const file = { id: 'portals', path: '/fictional/root-a/portals.yml', content: 'value: original\n', revision: 'original-revision', exists: true };

test('configuration recovery keeps exact source and original revision after the saved file changes', () => {
  const recovery = createConfigDraftRecovery();
  recovery.write(file, 'value: edited\n');
  assert.deepEqual(recovery.read({ ...file, content: 'value: changed elsewhere\n', revision: 'new-revision' }), {
    content: 'value: edited\n', original: file.content, revision: file.revision, exists: true,
  });
});

test('configuration recovery is isolated by resolved file path and file ID', () => {
  const recovery = createConfigDraftRecovery();
  recovery.write(file, 'value: edited\n');
  assert.equal(recovery.read({ ...file, path: '/fictional/root-b/portals.yml' }), null);
  assert.equal(recovery.read({ ...file, id: 'profile' }), null);
  assert.equal(recovery.read({ ...file, path: '' }), null);
});

test('undo and explicit discard clear recovery while large valid configurations remain recoverable', () => {
  const recovery = createConfigDraftRecovery();
  const largeDraft = `value: ${'x'.repeat(500_000)}\n`;
  recovery.write(file, largeDraft);
  assert.equal(recovery.read(file)?.content, largeDraft);
  recovery.write(file, file.content);
  assert.equal(recovery.read(file), null);
  recovery.write(file, largeDraft);
  recovery.clear(file);
  assert.equal(recovery.read(file), null);
});
