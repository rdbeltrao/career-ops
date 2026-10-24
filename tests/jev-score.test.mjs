// tests/jev-score.test.mjs — jev-score.mjs, the calibrated typed pre-screen.
//
// Port of job-hunt's tests/test_scoring.py and tests/test_llm_scoring.py.
// Every network call is a fetch stub or a local HTTP server; no test reads a
// real API key (CAREER_OPS_SKIP_KEYCHAIN keeps the CLI off the Keychain).
//
// Run: node --test tests/jev-score.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCriteria } from '../lib/jev-criteria.mjs';
import { parseDotEnv } from '../lib/openrouter-key.mjs';
import { DEFAULT_USER_AGENT } from '../user-agent.mjs';
import {
  CONTEXT_FALLBACK_NOTICE, DEFAULT_CHAT_MODEL, JEV_MODEL, JevScoreError,
  blockingAnswers, buildFallbackInstructions, buildFallbackSchema, buildState, errorResult,
  formatJevSegment, formatPrescreenMarkdown, formatPrescreenNotRun, isProviderBlocked,
  loadContextText, parseAnswers, parseCompletion, scoreJob, scoreToFive,
} from '../jev-score.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'jev');
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf-8'));
const criteria = loadCriteria({ dataRoot: mkdtempSync(join(tmpdir(), 'jev-score-crit-')), codeRoot: ROOT });
const tmp = (prefix = 'jev-score-') => mkdtempSync(join(tmpdir(), prefix));

const JOB = {
  url: 'https://jobs.example.com/123',
  title: 'Engineering Lead',
  company: 'Acme',
  location: 'Remote (EU)',
  workplace: 'remote',
  seniority: 'Mid-Senior level',
  description: 'Lead a team of 6 engineers building a customer-facing marketplace.',
  salary: '',
  posted_date: '2026-10-16',
  ignored_key: 'dropped',
};

const APPLY_SEGMENT = 'jev: 79 apply — seniority match, location yes, language none, product, stack agnostic';
const APPLY_BLOCK = [
  '## Calibrated pre-screen (Jev)',
  '',
  'model: typesafe/jev-1.13 | fit: 79/100 | jev_score: 4.2/5 | verdict: apply',
  'seniority_match: match (0.91) | location_ok: yes (0.88) | language_blocker: none (0.95) | team_type: product (0.70) | stack_fit: stack_agnostic (0.66)',
  'blocking: none',
].join('\n');

/** A fetch stub that answers from a queue and records every call. */
function fetchQueue(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error('fetch stub: no response queued');
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return { ok: next.status >= 200 && next.status < 300, status: next.status, text: async () => text };
  };
  return { impl, calls };
}

// ── state and parsing ─────────────────────────────────────────────────────────

test('buildState truncates a 7000-char description to 6000 plus [truncated]', () => {
  const state = buildState('profile text', { ...JOB, description: 'x'.repeat(7000) }, criteria);
  assert.equal(state.instructions, criteria.preamble);
  assert.equal(state.profile, 'profile text');
  assert.equal(state.job.description.length, 6000 + '\n[truncated]'.length);
  assert.ok(state.job.description.endsWith('\n[truncated]'));
  assert.equal(state.job.description.slice(0, 6000), 'x'.repeat(6000));
});

test('buildState carries the job fields and drops unknown keys', () => {
  const state = buildState('p', JOB, criteria);
  assert.deepEqual(Object.keys(state.job), ['title', 'company', 'location', 'workplace', 'seniority', 'description']);
  assert.equal(state.job.title, 'Engineering Lead');
  assert.equal(state.job.description, JOB.description);
  const withSalary = buildState('p', { ...JOB, salary: '90-110k EUR' }, criteria);
  assert.equal(withSalary.job.salary, '90-110k EUR');
  const sparse = buildState('p', { title: 'X' }, criteria);
  assert.equal(sparse.job.description, '');
  assert.equal(sparse.job.company, '');
});

test('parseAnswers on the apply fixture', () => {
  const r = parseAnswers(fixture('answers-apply'), criteria);
  assert.equal(r.model, 'typesafe/jev-1.13');
  assert.equal(r.fit, 79);
  assert.equal(r.score, 4.2);
  assert.equal(r.verdict, 'apply');
  assert.deepEqual(r.reasons, {
    seniority_match: 'match', location_ok: 'yes', language_blocker: 'none', team_type: 'product', stack_fit: 'stack_agnostic',
  });
  assert.equal(r.confidences.seniority_match, 0.91);
  assert.equal(r.confidences.verdict, 0.9);
  assert.deepEqual(r.probabilities, { verdict: { apply: 0.9, maybe: 0.08, skip: 0.02 } });
  assert.deepEqual(r.blocking, []);
  assert.equal(r.fallback, false);
  assert.ok(!('error' in r));
});

test('parseAnswers on the skip fixture lists the blocking answers', () => {
  const r = parseAnswers(fixture('answers-skip'), criteria);
  assert.equal(r.fit, 21);
  assert.equal(r.score, 1.8);
  assert.equal(r.verdict, 'skip');
  assert.deepEqual(r.blocking, ['seniority_match=below', 'location_ok=no']);
});

test('parseAnswers on the no-fit fixture gives null fit and null score', () => {
  const r = parseAnswers(fixture('answers-no-fit'), criteria);
  assert.equal(r.fit, null);
  assert.equal(r.score, null);
  assert.equal(r.verdict, 'maybe');
  assert.equal(r.reasons.language_blocker, 'partial');
  assert.deepEqual(r.blocking, []);
});

test('parseAnswers accepts the numeric score variants and clamps', () => {
  assert.equal(parseAnswers({ answers: { fit: { type: 'score', score: 73 } } }, criteria).fit, 73);
  assert.equal(parseAnswers({ answers: { fit: { type: 'score', value: 0.5 } } }, criteria).fit, 50);
  assert.equal(parseAnswers({ answers: { fit: { type: 'score', score: 140 } } }, criteria).fit, 100);
  assert.equal(parseAnswers({ answers: {} }, criteria).fit, null);
  assert.equal(parseAnswers({ answers: {} }, criteria).verdict, '');
  assert.equal(parseAnswers({ answers: { fit: { type: 'noul', noul: true } } }, criteria).fit, null);
});

test('scoreToFive is round(1 + 4 * fit / 100, 1)', () => {
  assert.equal(scoreToFive(79), 4.2);
  assert.equal(scoreToFive(0), 1);
  assert.equal(scoreToFive(100), 5);
  assert.equal(scoreToFive(50), 3);
  assert.equal(scoreToFive(21), 1.8);
  assert.equal(scoreToFive(null), null);
  assert.equal(scoreToFive(undefined), null);
  assert.equal(scoreToFive('79'), null);
});

test('blockingAnswers follows the criteria, in reason order', () => {
  const reasons = { seniority_match: 'above', location_ok: 'yes', language_blocker: 'missing', team_type: 'platform_infra', stack_fit: 'required_mismatch' };
  assert.deepEqual(blockingAnswers(reasons, criteria), ['seniority_match=above', 'language_blocker=missing', 'stack_fit=required_mismatch']);
  assert.deepEqual(blockingAnswers({}, criteria), []);
});

test('isProviderBlocked is 404 plus "allowed providers", case-insensitive', () => {
  assert.equal(isProviderBlocked(404, JSON.stringify(fixture('error-404-providers').body)), true);
  assert.equal(isProviderBlocked(404, 'NO ALLOWED PROVIDERS are available'), true);
  assert.equal(isProviderBlocked(404, 'not found'), false);
  assert.equal(isProviderBlocked(402, 'No allowed providers are available'), false);
  assert.equal(isProviderBlocked('404', 'allowed providers'), true);
});

// ── requests ──────────────────────────────────────────────────────────────────

test('scoreJob posts the decisions request and parses the answers', async () => {
  const { impl, calls } = fetchQueue([{ status: 200, body: fixture('answers-apply') }]);
  const r = await scoreJob({ profileText: 'I lead teams.', job: JOB, criteria, apiKey: 'test-key', fetchImpl: impl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.equal(calls[0].init.headers['User-Agent'], DEFAULT_USER_AGENT);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].body.model, JEV_MODEL);
  assert.equal(calls[0].body.state.profile, 'I lead teams.');
  assert.equal(calls[0].body.state.job.title, 'Engineering Lead');
  assert.deepEqual(Object.keys(calls[0].body.questions), ['fit', 'verdict', 'seniority_match', 'location_ok', 'language_blocker', 'team_type', 'stack_fit']);
  assert.equal(calls[0].body.questions.verdict.type, 'choice');
  assert.deepEqual(Object.keys(calls[0].body.questions.verdict.criteria), ['apply', 'maybe', 'skip']);
  assert.equal(r.fit, 79);
  assert.equal(r.fallback, false);
  assert.equal(r.error, null);
});

test('scoreJob falls back to chat completions on 404 "No allowed providers"', async () => {
  const blocked = fixture('error-404-providers');
  const { impl, calls } = fetchQueue([
    { status: blocked.status, body: blocked.body },
    { status: 200, body: fixture('chat-fallback') },
  ]);
  const r = await scoreJob({ profileText: 'I lead teams.', job: JOB, criteria, apiKey: 'k', fetchImpl: impl, chatModel: DEFAULT_CHAT_MODEL });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/chat/completions');
  const body = calls[1].body;
  assert.equal(body.model, 'anthropic/claude-haiku-5.5');
  assert.equal(body.temperature, 0);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.name, 'jev_fallback');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.properties.verdict.enum, ['apply', 'maybe', 'skip']);
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /verdict \(one of: apply, maybe, skip\)/);
  assert.match(body.messages[1].content, /I lead teams\./);
  assert.equal(r.fallback, true);
  assert.equal(r.model, 'anthropic/claude-haiku-5.5');
  assert.equal(r.fit, 78);
  assert.equal(r.score, 4.1);
  assert.equal(r.verdict, 'apply');
  assert.equal(r.reasons.stack_fit, 'stack_agnostic');
  assert.equal(r.confidences.verdict, 0.85);
  assert.deepEqual(r.blocking, []);
  assert.equal(r.error, null);
});

test('scoreJob honours a model override and JOB_HUNT_SCORE_MODEL for the fallback', async () => {
  const blocked = fixture('error-404-providers');
  const { impl, calls } = fetchQueue([
    { status: blocked.status, body: blocked.body },
    { status: 200, body: fixture('chat-fallback') },
  ]);
  const r = await scoreJob({
    profileText: 'p', job: JOB, criteria, apiKey: 'k', fetchImpl: impl,
    model: 'typesafe/jev-2.0', chatModel: 'openai/gpt-5-mini',
  });
  assert.equal(calls[0].body.model, 'typesafe/jev-2.0');
  assert.equal(calls[1].body.model, 'openai/gpt-5-mini');
  assert.equal(r.model, 'openai/gpt-5-mini');
});

test('scoreJob throws on an HTTP error without retrying', async () => {
  const { impl, calls } = fetchQueue([{ status: 402, body: 'insufficient credits' }]);
  await assert.rejects(
    scoreJob({ profileText: 'p', job: JOB, criteria, apiKey: 'k', fetchImpl: impl }),
    (err) => err instanceof JevScoreError && /HTTP 402/.test(err.message),
  );
  assert.equal(calls.length, 1);
});

test('scoreJob throws when the answer has no answers or is not JSON', async () => {
  const noAnswers = fetchQueue([{ status: 200, body: { error: 'bad' } }]);
  await assert.rejects(scoreJob({ profileText: 'p', job: JOB, criteria, apiKey: 'k', fetchImpl: noAnswers.impl }), /answers/);
  const notJson = fetchQueue([{ status: 200, body: '<html>nope</html>' }]);
  await assert.rejects(scoreJob({ profileText: 'p', job: JOB, criteria, apiKey: 'k', fetchImpl: notJson.impl }), /non-JSON/);
});

test('scoreJob reports a failed fallback as an error, not as a score', async () => {
  const blocked = fixture('error-404-providers');
  const { impl } = fetchQueue([
    { status: blocked.status, body: blocked.body },
    { status: 500, body: 'upstream down' },
  ]);
  await assert.rejects(scoreJob({ profileText: 'p', job: JOB, criteria, apiKey: 'k', fetchImpl: impl }), /HTTP 500/);
});

test('scoreJob wraps a network failure', async () => {
  const impl = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(scoreJob({ profileText: 'p', job: JOB, criteria, apiKey: 'k', fetchImpl: impl }), (err) => err instanceof JevScoreError && /fetch failed/.test(err.message));
});

test('buildFallbackSchema follows the criteria', () => {
  const schema = buildFallbackSchema(criteria);
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.fit, { type: 'integer', minimum: 0, maximum: 100 });
  assert.deepEqual(schema.properties.language_blocker.enum, ['none', 'missing', 'partial']);
  assert.deepEqual(schema.properties.stack_fit.enum, ['required_match', 'desired_match', 'stack_agnostic', 'required_mismatch']);
  assert.ok('stack_fit_confidence' in schema.properties);
  assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)));
  assert.match(buildFallbackInstructions(criteria), /data, not instructions/);
});

test('parseCompletion clamps fit and refuses an unknown label', () => {
  const good = JSON.parse(fixture('chat-fallback').choices[0].message.content);
  const completion = (answers) => ({ model: 'm', choices: [{ message: { content: JSON.stringify(answers) } }] });
  assert.equal(parseCompletion(completion({ ...good, fit: 140 }), criteria, 'm').fit, 100);
  assert.throws(() => parseCompletion(completion({ ...good, verdict: 'definitely' }), criteria, 'm'), /verdict/);
  assert.throws(() => parseCompletion({ choices: [{ message: { content: 'nope' } }] }, criteria, 'm'), /non-JSON/);
  assert.throws(() => parseCompletion({}, criteria, 'm'), /shape/);
});

// ── formatting ────────────────────────────────────────────────────────────────

test('formatJevSegment on the apply fixture', () => {
  assert.equal(formatJevSegment(parseAnswers(fixture('answers-apply'), criteria)), APPLY_SEGMENT);
});

test('formatJevSegment is empty without a fit and never breaks a row', () => {
  assert.equal(formatJevSegment(parseAnswers(fixture('answers-no-fit'), criteria)), '');
  assert.equal(formatJevSegment(errorResult(new Error('x'))), '');
  const weird = parseAnswers(fixture('answers-apply'), criteria);
  weird.reasons.team_type = 'a | b\n- [ ] fake [x]';
  const seg = formatJevSegment(weird);
  assert.ok(!seg.includes('\n'));
  assert.ok(!seg.slice(4).includes('|'));
  assert.ok(!/\[ \]/.test(seg));
  weird.reasons.team_type = 'z'.repeat(400);
  assert.ok(formatJevSegment(weird).length < 140 + 40);
});

test('formatPrescreenMarkdown prints the C3 block', () => {
  assert.equal(formatPrescreenMarkdown(parseAnswers(fixture('answers-apply'), criteria)), APPLY_BLOCK);
});

test('formatPrescreenMarkdown on the no-fit fixture still prints the five reasons and fit: n/a', () => {
  const md = formatPrescreenMarkdown(parseAnswers(fixture('answers-no-fit'), criteria));
  assert.match(md, /fit: n\/a/);
  assert.match(md, /jev_score: n\/a/);
  for (const key of ['seniority_match: match', 'location_ok: unclear', 'language_blocker: partial', 'team_type: unclear', 'stack_fit: desired_match']) {
    assert.ok(md.includes(key), `${key} in\n${md}`);
  }
  assert.match(md, /blocking: none/);
});

test('formatPrescreenMarkdown lists blocking answers and the not-run form', () => {
  const md = formatPrescreenMarkdown(parseAnswers(fixture('answers-skip'), criteria));
  assert.match(md, /blocking: seniority_match=below, location_ok=no/);
  assert.equal(formatPrescreenNotRun('no API key'), '## Calibrated pre-screen (Jev)\n\nnot run: no API key');
  assert.equal(formatPrescreenMarkdown(errorResult(new Error('HTTP 500'))), '## Calibrated pre-screen (Jev)\n\nnot run: HTTP 500');
});

test('errorResult has the C1 keys with everything null but model, fallback and error', () => {
  const r = errorResult(new JevScoreError('HTTP 402 from Jev'));
  assert.deepEqual(Object.keys(r), ['model', 'fit', 'score', 'verdict', 'reasons', 'confidences', 'probabilities', 'blocking', 'fallback', 'error']);
  assert.equal(r.model, JEV_MODEL);
  assert.equal(r.fit, null);
  assert.equal(r.fallback, false);
  assert.equal(r.error, 'HTTP 402 from Jev');
});

// ── context ───────────────────────────────────────────────────────────────────

test('loadContextText with no _context.md returns cv.md + profile text and source cv+profile', () => {
  const dataRoot = tmp();
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(join(dataRoot, 'cv.md'), '# Jane Doe\n\nLeads teams.\n');
  writeFileSync(join(dataRoot, 'config', 'profile.yml'), 'name: Jane Doe\nlocation:\n  city: Nowhere\n');
  const ctx = loadContextText({ dataRoot });
  assert.equal(ctx.source, 'cv+profile');
  assert.ok(ctx.text.indexOf('Leads teams.') < ctx.text.indexOf('city: Nowhere'));
  assert.equal(ctx.notice, CONTEXT_FALLBACK_NOTICE);
  assert.equal(CONTEXT_FALLBACK_NOTICE, 'jev-score: modes/_context.md not found, using cv.md + profile.yml');
});

test('loadContextText prefers modes/_context.md and an explicit path over it', () => {
  const dataRoot = tmp();
  mkdirSync(join(dataRoot, 'modes'), { recursive: true });
  writeFileSync(join(dataRoot, 'cv.md'), 'cv');
  writeFileSync(join(dataRoot, 'modes', '_context.md'), '# Target role\n\nLead.\n');
  const ctx = loadContextText({ dataRoot });
  assert.equal(ctx.source, 'context');
  assert.equal(ctx.text, '# Target role\n\nLead.\n');
  assert.equal(ctx.notice, null);
  const other = join(dataRoot, 'other.md');
  writeFileSync(other, 'explicit');
  assert.deepEqual(loadContextText({ dataRoot, contextPath: other }), { text: 'explicit', source: 'context', path: other, notice: null });
  assert.throws(() => loadContextText({ dataRoot, contextPath: join(dataRoot, 'missing.md') }), /not found/);
});

test('loadContextText with nothing at all returns empty text', () => {
  const ctx = loadContextText({ dataRoot: tmp() });
  assert.equal(ctx.text, '');
  assert.equal(ctx.source, 'cv+profile');
});

// ── CLI ───────────────────────────────────────────────────────────────────────

const SCRIPT = join(ROOT, 'jev-score.mjs');
const baseEnv = (extra = {}) => ({ PATH: process.env.PATH, CAREER_OPS_SKIP_KEYCHAIN: '1', ...extra });

function runCli(args, { env, input } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8', env, input, timeout: 60_000 });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  return r;
}

/**
 * Async spawn for the tests that serve OpenRouter from THIS process: a
 * spawnSync there would block the event loop the stub server needs to answer,
 * and the child would wait on it until the timeout.
 */
function runCliAsync(args, { env, input } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (status, signal) => { clearTimeout(timer); resolvePromise({ status, signal, stdout, stderr }); });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function checkoutEnvHasKey() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return false;
  const vars = parseDotEnv(readFileSync(envPath, 'utf-8'));
  return Boolean(vars.OPENROUTER_API_KEY_JOB_SEARCH || vars.OPENROUTER_API_KEY);
}

function dataRootWithContext() {
  const dataRoot = tmp('jev-score-root-');
  mkdirSync(join(dataRoot, 'modes'), { recursive: true });
  writeFileSync(join(dataRoot, 'modes', '_context.md'), '# Target role\n\nEngineering lead, remote.\n');
  return dataRoot;
}

test('CLI: --self-test exits 0 without a network', () => {
  const r = runCli(['--self-test'], { env: baseEnv({ CAREER_OPS_ROOT: tmp() }) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /self-test/);
});

test('CLI: --help prints usage and exits 0', () => {
  const r = runCli(['--help'], { env: baseEnv({ CAREER_OPS_ROOT: tmp() }) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /jev-score\.mjs --job/);
  assert.match(r.stdout, /--format json\|markdown\|segment/);
});

test('CLI: an unknown flag, a missing --job and a bad --format exit 1', () => {
  const env = baseEnv({ CAREER_OPS_ROOT: tmp() });
  assert.equal(runCli(['--bogus'], { env }).status, 1);
  const noJob = runCli([], { env });
  assert.equal(noJob.status, 1);
  assert.match(noJob.stderr, /--job/);
  const jobFile = join(tmp(), 'job.json');
  writeFileSync(jobFile, JSON.stringify(JOB));
  const badFormat = runCli(['--job', jobFile, '--format', 'xml'], { env });
  assert.equal(badFormat.status, 1);
  assert.match(badFormat.stderr, /--format/);
});

test('CLI: --job with no key exits 2 and names OPENROUTER_API_KEY', (t) => {
  if (checkoutEnvHasKey()) {
    t.skip('the checkout .env defines an OpenRouter key, so the no-key path cannot be exercised here');
    return;
  }
  const dataRoot = tmp();
  const jobFile = join(dataRoot, 'job.json');
  writeFileSync(jobFile, JSON.stringify(JOB));
  const r = runCli(['--job', jobFile], { env: baseEnv({ CAREER_OPS_ROOT: dataRoot }) });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /OPENROUTER_API_KEY/);
  assert.equal(r.stdout, '');
});

/** A local stand-in for OpenRouter: one handler per path, recording bodies. */
async function withOpenRouterStub(routes, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(raw || '{}') });
      const route = routes[req.url];
      if (!route) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no route'); return; }
      const answer = typeof route === 'function' ? route(seen) : route;
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    return await fn(base, seen);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('CLI: scores a job end to end against a local server, json by default', async () => {
  await withOpenRouterStub({ '/api/alpha/decisions': { status: 200, body: fixture('answers-apply') } }, async (base, seen) => {
    const dataRoot = dataRootWithContext();
    const jobFile = join(dataRoot, 'job.json');
    writeFileSync(jobFile, JSON.stringify(JOB));
    const env = baseEnv({ CAREER_OPS_ROOT: dataRoot, OPENROUTER_API_KEY: 'test-key', OPENROUTER_BASE_URL: base });
    const r = await runCliAsync(['--job', jobFile], { env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out), ['model', 'fit', 'score', 'verdict', 'reasons', 'confidences', 'probabilities', 'blocking', 'fallback', 'error']);
    assert.equal(out.fit, 79);
    assert.equal(out.score, 4.2);
    assert.equal(out.verdict, 'apply');
    assert.equal(out.fallback, false);
    assert.equal(out.error, null);
    assert.equal(seen[0].auth, 'Bearer test-key');
    assert.equal(seen[0].body.state.profile, '# Target role\n\nEngineering lead, remote.\n');
    assert.ok(!r.stderr.includes('_context.md not found'), r.stderr);

    const md = await runCliAsync(['--job', jobFile, '--format', 'markdown'], { env });
    assert.equal(md.status, 0, md.stderr);
    assert.equal(md.stdout.trimEnd(), APPLY_BLOCK);

    const seg = await runCliAsync(['--job', '-', '--format', 'segment'], { env, input: JSON.stringify(JOB) });
    assert.equal(seg.status, 0, seg.stderr);
    assert.equal(seg.stdout.trimEnd(), APPLY_SEGMENT);
  });
});

test('CLI: falls back to cv.md + profile.yml with a one-line notice when _context.md is absent', async () => {
  await withOpenRouterStub({ '/api/alpha/decisions': { status: 200, body: fixture('answers-skip') } }, async (base, seen) => {
    const dataRoot = tmp('jev-score-root-');
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(join(dataRoot, 'cv.md'), '# Jane Doe\n');
    writeFileSync(join(dataRoot, 'config', 'profile.yml'), 'name: Jane Doe\n');
    const jobFile = join(dataRoot, 'job.json');
    writeFileSync(jobFile, JSON.stringify(JOB));
    const env = baseEnv({ CAREER_OPS_ROOT: dataRoot, OPENROUTER_API_KEY: 'test-key', OPENROUTER_BASE_URL: base });
    const r = await runCliAsync(['--job', jobFile], { env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /jev-score: modes\/_context\.md not found, using cv\.md \+ profile\.yml/);
    assert.match(seen[0].body.state.profile, /Jane Doe/);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.blocking, ['seniority_match=below', 'location_ok=no']);
    assert.equal(out.verdict, 'skip');
  });
});

test('CLI: 404 "No allowed providers" falls back and marks fallback: true', async () => {
  const blocked = fixture('error-404-providers');
  await withOpenRouterStub({
    '/api/alpha/decisions': { status: blocked.status, body: blocked.body },
    '/api/v1/chat/completions': { status: 200, body: fixture('chat-fallback') },
  }, async (base) => {
    const dataRoot = dataRootWithContext();
    const jobFile = join(dataRoot, 'job.json');
    writeFileSync(jobFile, JSON.stringify(JOB));
    const env = baseEnv({ CAREER_OPS_ROOT: dataRoot, OPENROUTER_API_KEY: 'test-key', OPENROUTER_BASE_URL: base, JOB_HUNT_SCORE_MODEL: 'anthropic/claude-haiku-5.5' });
    const r = await runCliAsync(['--job', jobFile], { env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.fallback, true);
    assert.equal(out.model, 'anthropic/claude-haiku-5.5');
    assert.equal(out.fit, 78);
    assert.match(r.stderr, /fallback/i);
  });
});

test('CLI: an API failure exits 1 with error filled and the other fields null', async () => {
  await withOpenRouterStub({ '/api/alpha/decisions': { status: 402, body: { error: { message: 'insufficient credits' } } } }, async (base) => {
    const dataRoot = dataRootWithContext();
    const jobFile = join(dataRoot, 'job.json');
    writeFileSync(jobFile, JSON.stringify(JOB));
    const env = baseEnv({ CAREER_OPS_ROOT: dataRoot, OPENROUTER_API_KEY: 'test-key', OPENROUTER_BASE_URL: base });
    const r = await runCliAsync(['--job', jobFile], { env });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(out.error, /HTTP 402/);
    assert.equal(out.fit, null);
    assert.equal(out.reasons, null);
    const md = await runCliAsync(['--job', jobFile, '--format', 'markdown'], { env });
    assert.equal(md.status, 1);
    assert.match(md.stdout, /^## Calibrated pre-screen \(Jev\)\n\nnot run: HTTP 402/);
  });
});

test('CLI: a job file that is not JSON exits 1', () => {
  const dataRoot = dataRootWithContext();
  const jobFile = join(dataRoot, 'job.json');
  writeFileSync(jobFile, '{not json');
  const r = runCli(['--job', jobFile], { env: baseEnv({ CAREER_OPS_ROOT: dataRoot, OPENROUTER_API_KEY: 'test-key' }) });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /job/i);
});
