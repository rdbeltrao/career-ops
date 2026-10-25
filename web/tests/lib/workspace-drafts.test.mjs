import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDraftRecovery } from '../../src/lib/workspace-drafts.mjs';

const draft = { section: 'profile', revision: 'before', content: 'Unsaved fictional text', original: 'Original text', form: null };
function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test('unsaved drafts recover after remount with original revision and source', () => {
  const session = storage();
  createDraftRecovery().write(session, 'workspace-a', 'context', draft);
  assert.deepEqual(createDraftRecovery().read(session, 'workspace-a', 'context'), draft);
});

test('same localhost session cannot restore a different workspace document', () => {
  const session = storage();
  const recovery = createDraftRecovery();
  recovery.write(session, 'workspace-a', 'context', draft);
  assert.equal(recovery.read(session, 'workspace-b', 'context'), null);
  assert.equal(recovery.read(session, 'workspace-a', 'cv'), null);
});

test('failed saves leave drafts intact; explicit discard or successful save clears recovery', () => {
  const session = storage();
  const recovery = createDraftRecovery();
  recovery.write(session, 'workspace-a', 'context', draft);
  assert.deepEqual(recovery.read(session, 'workspace-a', 'context'), draft);
  recovery.clear(session, 'workspace-a', 'context');
  assert.equal(createDraftRecovery().read(session, 'workspace-a', 'context'), null);
});

test('blocked browser storage retains in-memory route-navigation recovery', () => {
  const unavailable = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const recovery = createDraftRecovery();
  assert.equal(recovery.write(unavailable, 'workspace-a', 'context', draft), false);
  assert.deepEqual(recovery.read(unavailable, 'workspace-a', 'context'), draft);
  recovery.clear(unavailable, 'workspace-a', 'context');
  assert.equal(recovery.read(unavailable, 'workspace-a', 'context'), null);
});

test('missing workspace identity never persists a draft and malformed records are ignored', () => {
  const session = storage();
  const recovery = createDraftRecovery();
  recovery.write(session, undefined, 'context', draft);
  assert.deepEqual(recovery.read(session, undefined, 'context'), draft);
  assert.equal(createDraftRecovery().read(session, undefined, 'context'), null);
  session.setItem('career-ops:workspace-draft:workspace-a:context', '{bad json');
  assert.equal(recovery.read(session, 'workspace-a', 'context'), null);
});
