import test from 'node:test';
import assert from 'node:assert/strict';
import workday from '../providers/workday.mjs';

test('Workday enriches an undated posting from native startDate', async () => {
  const job = { url: 'https://acme.wd5.myworkdayjobs.com/Careers/job/Remote/Engineer_JR1' };
  let request;
  await workday.enrichDate(job, { fetchJson: async (url) => {
    request = url; return { jobPostingInfo: { startDate: '2026-10-30' } };
  } });
  assert.equal(request, 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/job/Remote/Engineer_JR1');
  assert.equal(job.postedAt, Date.parse('2026-10-30'));
});

test('Workday never invents a date or fetches an unrelated host', async () => {
  const ctx = { fetchJson: async () => { throw new Error('unexpected request'); } };
  await workday.enrichDate({ url: 'https://example.test/Careers/job/1' }, ctx);
  const job = { url: 'https://acme.wd5.myworkdayjobs.com/Careers/job/Remote/Engineer_JR1' };
  await workday.enrichDate(job, { fetchJson: async () => ({ jobPostingInfo: { startDate: 'unknown' } }) });
  assert.equal(job.postedAt, undefined);
  const dated = { ...job, postedAt: 42 };
  await workday.enrichDate(dated, ctx);
  assert.equal(dated.postedAt, 42);
});
