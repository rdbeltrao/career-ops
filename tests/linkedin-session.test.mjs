// tests/linkedin-session.test.mjs — whether the LinkedIn crawl profile is
// signed in, and what the last crawl found.
//
// The cookie database is Chromium's own SQLite file. These tests build one with
// node:sqlite in the same shape (the columns the status reads), so no real
// profile is touched. Only cookie NAMES and timestamps are read, never values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CRAWL_STATUS_FILE,
  profileDir,
  readCrawlStatus,
  readSessionCookies,
  recordCrawlStatus,
  sessionStatus,
} from '../lib/linkedin-session.mjs';

const EPOCH_1601_S = 11644473600;
const chromium = (date) => BigInt(Math.floor(new Date(date).getTime() / 1000) + EPOCH_1601_S) * 1000000n;

function profileWith(cookies) {
  const dir = mkdtempSync(join(tmpdir(), 'li-profile-'));
  mkdirSync(join(dir, 'Default'));
  const db = new DatabaseSync(join(dir, 'Default', 'Cookies'));
  db.exec('CREATE TABLE cookies (creation_utc INTEGER, host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER, has_expires INTEGER)');
  const insert = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const c of cookies) insert.run(chromium(c.created), c.host, c.name, 'SECRET', Buffer.from('SECRET'), chromium(c.expires), 1);
  db.close();
  return dir;
}

const NOW = new Date('2026-10-25T12:00:00Z');
const LI_AT = { host: '.www.linkedin.com', name: 'li_at', created: '2026-10-24T13:48:21Z', expires: '2027-10-24T13:48:21Z' };

test('readSessionCookies: names and times only, never values', () => {
  const dir = profileWith([LI_AT, { host: '.example.com', name: 'li_at', created: '2026-01-01', expires: '2027-01-01' }]);
  const read = readSessionCookies(dir);
  assert.equal(read.exists, true);
  assert.deepEqual(read.cookies, [{ name: 'li_at', host: '.www.linkedin.com', createdAt: '2026-10-24T13:48:21.000Z', expiresAt: '2027-10-24T13:48:21.000Z' }]);
  assert.ok(!JSON.stringify(read).includes('SECRET'));
});

test('sessionStatus: signed in with a live li_at cookie', () => {
  const s = sessionStatus({ profileDir: profileWith([LI_AT]), now: NOW });
  assert.equal(s.state, 'signed-in');
  assert.equal(s.expiresAt, '2027-10-24T13:48:21.000Z');
  assert.equal(s.signedInAt, '2026-10-24T13:48:21.000Z');
  assert.equal(s.busy, false);
});

test('sessionStatus: no profile, no cookie, or an expired one', () => {
  assert.equal(sessionStatus({ profileDir: join(tmpdir(), 'no-such-profile-xyz'), now: NOW }).state, 'no-profile');
  assert.equal(sessionStatus({ profileDir: profileWith([]), now: NOW }).state, 'signed-out');
  assert.equal(sessionStatus({ profileDir: profileWith([{ ...LI_AT, expires: '2026-10-01' }]), now: NOW }).state, 'expired');
});

test('sessionStatus: a crawl that hit the login wall after the cookie was set means sign-in is needed', () => {
  const dir = profileWith([LI_AT]);
  const after = sessionStatus({ profileDir: dir, now: NOW, crawl: { result: 'login-required', at: '2026-10-25T07:40:00Z' } });
  assert.equal(after.state, 'sign-in-needed');
  const before = sessionStatus({ profileDir: dir, now: NOW, crawl: { result: 'login-required', at: '2026-10-20T07:40:00Z' } });
  assert.equal(before.state, 'signed-in', 'signing in again after the failed crawl fixed it');
  const ok = sessionStatus({ profileDir: dir, now: NOW, crawl: { result: 'ok', at: '2026-10-25T07:40:00Z' } });
  assert.equal(ok.state, 'signed-in');
});

test('sessionStatus: a held profile is reported busy, and still read', () => {
  const dir = profileWith([LI_AT]);
  writeFileSync(join(dir, 'SingletonLock'), '');
  const s = sessionStatus({ profileDir: dir, now: NOW });
  assert.equal(s.busy, true);
  assert.equal(s.state, 'signed-in');
});

test('crawl status: recorded per run, read back, unreadable reads as none', () => {
  const root = mkdtempSync(join(tmpdir(), 'li-root-'));
  assert.equal(readCrawlStatus(root), null);
  recordCrawlStatus(root, { result: 'ok', search: 'LinkedIn em-germany-7d', jobs: 12, at: '2026-10-25T07:40:00.000Z' });
  assert.deepEqual(readCrawlStatus(root), { result: 'ok', search: 'LinkedIn em-germany-7d', jobs: 12, message: '', at: '2026-10-25T07:40:00.000Z' });
  recordCrawlStatus(root, { result: 'login-required', message: 'LinkedIn asked for a login', at: '2026-10-25T07:41:00.000Z' });
  assert.equal(readCrawlStatus(root).result, 'login-required');
  writeFileSync(join(root, CRAWL_STATUS_FILE), '{oops');
  assert.equal(readCrawlStatus(root), null);
  assert.throws(() => recordCrawlStatus(root, { result: 'weird' }), /result/);
});

test('profileDir: LINKEDIN_PROFILE_DIR, else ~/.job-hunt/browser-profile', () => {
  const prev = process.env.LINKEDIN_PROFILE_DIR;
  try {
    process.env.LINKEDIN_PROFILE_DIR = '/tmp/x-profile';
    assert.equal(profileDir(), '/tmp/x-profile');
    delete process.env.LINKEDIN_PROFILE_DIR;
    assert.match(profileDir(), /\.job-hunt[\\/]browser-profile$/);
  } finally {
    if (prev === undefined) delete process.env.LINKEDIN_PROFILE_DIR;
    else process.env.LINKEDIN_PROFILE_DIR = prev;
  }
});
