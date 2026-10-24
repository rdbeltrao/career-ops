#!/usr/bin/env node
/**
 * career-ops OpenRouter Runner
 * No Claude Code CLI required — uses OpenRouter free models with automatic fallback.
 *
 * Usage:
 *   node openrouter-runner.mjs scan              → Scan Greenhouse API companies for new listings
 *   node openrouter-runner.mjs evaluate <url>    → Evaluate a job by URL
 *   node openrouter-runner.mjs evaluate          → Paste job text interactively
 *   node openrouter-runner.mjs pipeline          → Process all pending URLs from pipeline.md
 *   node openrouter-runner.mjs apply <report_no> → Generate draft application form answers
 *   node openrouter-runner.mjs models            → List available free models
 *   node openrouter-runner.mjs help              → Show this help
 *
 * Setup:
 *   1. copy .env.example .env
 *   2. Add OPENROUTER_API_KEY=sk-or-v1-... to .env
 *   3. Free API key: https://openrouter.ai
 *
 * Environment:
 *   CAREER_OPS_MODEL            Pin one model instead of the free rotation.
 *   CAREER_OPS_MODEL_TIMEOUT_MS Abort a single model call after this many
 *                               milliseconds (positive integer; default 15000).
 *                               A pinned model running a full evaluation needs
 *                               more than the default, e.g. 180000.
 *   CAREER_OPS_MAX_TOKENS       Completion budget per call (positive integer;
 *                               default 8192). Shared with reasoning on models
 *                               that think first.
 *   CAREER_OPS_REASONING        off | low | medium | high | <token budget>.
 *                               Sent as OpenRouter's `reasoning` field; unset
 *                               sends none. claude-sonnet-5.5 needs `low` plus
 *                               CAREER_OPS_MAX_TOKENS=16384 to return a report
 *                               instead of an empty, all-reasoning answer.
 *
 * Context: cv.md, config/profile.yml, modes/_profile.md and, when present,
 * modes/_context.md (the fit profile — the context tier: qualitative facts are
 * evidence for the evaluation, numbers are targeting only, never a source for
 * candidate-facing text). The Jev
 * pre-screen (`node jev-score.mjs`) runs before each evaluation when that script
 * is installed and a key is available; otherwise the evaluation runs as before.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline';
import { loadYaml } from './lib/yaml-document.mjs';
import { outputLanguageInstruction, parseOutputLanguage } from './profile-language.mjs';
import { TSV_ADDITION_HEADER } from './tracker-parse.mjs';
import { normalizedTrackerScore } from './lib/tracker-addition.mjs';
import {
  formatReportNumber, releaseReportNumbers, reserveReportNumbers,
} from './reserve-report-num.mjs';
import { TokenAccumulator, formatBreakdown, normalizeOpenAIUsage } from './utils/token-tracker.mjs';
import { DEFAULT_USER_AGENT } from './user-agent.mjs';
import { buildTitleFilter } from './title-keywords.mjs';
import { appendToPipeline, appendToScanHistory, atomicWriteFile } from './scan.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { createAdmissionGate, formatSkipCounts } from './lib/admission-gate.mjs';
import { localToday } from './lib/local-today.mjs';
import { getCareerOpsRoot, getProfilePath } from './path-resolver.mjs';
import { readMaskedContext } from './lib/context-evidence.mjs';
import { markPipelineProcessed } from './lib/pipeline-processed.mjs';
import { normalizeReportLink } from './tracker-links.mjs';
import { SAMPLING_SEED, SAMPLING_TEMPERATURE } from './lib/sampling.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { withJdArchiveSection } from './lib/jd-archive-section.mjs';
import { locateApplyReport } from './apply-scope.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tracker = new TokenAccumulator();
let activeModel = null;
// The report cmdEvaluate last saved, so cmdPipeline can move the pipeline row
// under Processed with its link and score.
let lastSavedReport = null;

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------
// Lazy: only runs when this file is the CLI entry point (`node
// openrouter-runner.mjs ...`). Importing the module (e.g. for buildSystemPrompt
// in test-all.mjs) must NOT mutate process.env — a module-level loader here
// leaked every .env key (including CAREER_OPS_CLI) into the importing process
// and broke later CLI-resolution tests.
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^(['"])(.*?)\1$/, '$2');
    }
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const OPENROUTER_API_URL    = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const DEFAULT_MAX_TOKENS    = 8192;
let MAX_TOKENS              = DEFAULT_MAX_TOKENS; // resolved from CAREER_OPS_MAX_TOKENS at startup
let REASONING               = null;               // resolved from CAREER_OPS_REASONING at startup
const RATE_LIMIT_DELAY_MS   = 2500;  // pause between requests on free tier
const DEFAULT_MODEL_TIMEOUT_MS = 15_000; // abort a single model call after 15 s unless overridden

/**
 * CAREER_OPS_MODEL_TIMEOUT_MS as a positive safe integer, else the default.
 * 15 s fits the free rotation (a slow free model is skipped for the next one),
 * but a pinned model writing a full A-H report needs minutes. Resolved after
 * loadEnvFile() so the value can live in .env like the key does.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveModelTimeoutMs(env = process.env) {
  const raw = env.CAREER_OPS_MODEL_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_MODEL_TIMEOUT_MS;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return DEFAULT_MODEL_TIMEOUT_MS;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MODEL_TIMEOUT_MS;
}

/**
 * CAREER_OPS_MAX_TOKENS as a positive safe integer, else 8192. The budget is
 * shared between reasoning and the answer on models that think before they
 * write, so a full A-H report from such a model needs more than the default
 * (16384 is enough for claude-sonnet-5.5 with CAREER_OPS_REASONING=low).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveMaxTokens(env = process.env) {
  const raw = env.CAREER_OPS_MAX_TOKENS;
  if (raw === undefined) return DEFAULT_MAX_TOKENS;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return DEFAULT_MAX_TOKENS;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOKENS;
}

/**
 * CAREER_OPS_REASONING as OpenRouter's unified `reasoning` request field, or
 * null when unset or unrecognised (the request then carries no field, exactly
 * as before). Accepted: `off` (no thinking), `low` / `medium` / `high` (an
 * effort level), or a positive integer (a thinking budget in tokens).
 *
 * A reasoning-first model such as claude-sonnet-5.5 otherwise spends the whole
 * max_tokens budget thinking about a 60k-token evaluation prompt and returns
 * no content at all (finish_reason "length", every completion token a
 * reasoning token). Bounding the effort leaves room for the report.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ enabled: false } | { effort: 'low'|'medium'|'high' } | { max_tokens: number } | null}
 */
export function resolveReasoning(env = process.env) {
  const raw = env.CAREER_OPS_REASONING;
  if (raw === undefined) return null;
  const text = String(raw).trim().toLowerCase();
  if (!text) return null;
  if (text === 'off' || text === 'none' || text === 'disabled') return { enabled: false };
  if (text === 'low' || text === 'medium' || text === 'high') return { effort: text };
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return Number.isSafeInteger(n) && n > 0 ? { max_tokens: n } : null;
  }
  return null;
}

/**
 * The chat-completions body for one model call: the cached system message,
 * the user message, the token budget, and the `reasoning` field only when one
 * was resolved, so an install without CAREER_OPS_REASONING sends the request
 * it always sent.
 *
 * @param {{ model: string, systemPrompt: string, userMessage: string, maxTokens: number, reasoning?: object|null }} args
 * @returns {object}
 */
export function buildRequestBody({ model, systemPrompt, userMessage, maxTokens, reasoning = null }) {
  const body = {
    model,
    messages: [
      buildCachedSystemMessage(systemPrompt),
      { role: 'user', content: userMessage },
    ],
    max_tokens: maxTokens,
    // lib/sampling.mjs: temperature 0 and a fixed seed remove the spread the
    // provider lets us remove; the rest is model noise (docs/JEV.md).
    temperature: SAMPLING_TEMPERATURE,
    seed: SAMPLING_SEED,
  };
  if (reasoning) body.reasoning = reasoning;
  return body;
}

/**
 * Why a 200 response carried no content, as one actionable sentence. The case
 * this exists for: finish_reason "length" with (nearly) every completion token
 * spent on reasoning, which is a budget problem, not a provider failure.
 *
 * @param {object} data - the parsed chat-completions response
 * @param {number} maxTokens - the max_tokens the request carried
 * @returns {string}
 */
export function describeEmptyResponse(data, maxTokens) {
  const choice = data?.choices?.[0] ?? {};
  const finish = choice.finish_reason ?? choice.native_finish_reason ?? 'unknown';
  const completion = Number(data?.usage?.completion_tokens ?? 0);
  const reasoning = Number(data?.usage?.completion_tokens_details?.reasoning_tokens ?? 0);
  if (finish === 'length' && completion > 0 && reasoning >= completion * 0.9) {
    return `Empty response: the model spent its whole max_tokens budget (${maxTokens}) on reasoning `
      + `(${reasoning} of ${completion} completion tokens, finish_reason "length"). `
      + 'Set CAREER_OPS_REASONING=low (or off) and raise CAREER_OPS_MAX_TOKENS, for example 16384.';
  }
  return `Empty response (finish_reason "${finish}")`;
}

let MODEL_TIMEOUT_MS = DEFAULT_MODEL_TIMEOUT_MS;

// Provider priority order — models are sorted by provider prefix, not hardcoded names.
// Add, remove, or reorder providers here; model names are resolved at runtime from the API.
const PROVIDER_PRIORITY = [
  'google',
  'qwen',
  'openai',
  'meta-llama',
  'nvidia',
  'mistralai',
  'nousresearch',
  'minimax',
  'arcee-ai',
  // any unlisted provider goes last (alphabetical)
];

// In-memory model list — populated on first callOpenRouter()
let freeModels = null;   // string[]
let modelIndex = 0;      // current position in rotation

// Persistent blacklist file — survives process restarts. data/ is User Layer
// (gitignored runtime state), so it follows the data root like every other
// data/ path this runner touches.
const BLACKLIST_DIR  = path.join(getCareerOpsRoot(), 'data');
const BLACKLIST_FILE = path.join(BLACKLIST_DIR, 'model-blacklist.json');
function loadPersistedBlacklist() {
  try {
    const data = JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}
function saveBlacklist(set) {
  try {
    fs.mkdirSync(BLACKLIST_DIR, { recursive: true });
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify([...set], null, 2), 'utf-8');
  } catch {}
}

// Models that failed permanently (403, timeout, persistent 429) — never retry
const blacklistedModels = new Set(loadPersistedBlacklist());
if (blacklistedModels.size > 0) {
  console.log(`[blacklist] Loaded ${blacklistedModels.size} pre-blacklisted model(s) from disk.`);
}
// 429 failure count per model — auto-blacklist after 3 consecutive 429s
// (a success or any other failure resets the count)
const rateLimitCounts = {};

// ---------------------------------------------------------------------------
// Fetch free models from OpenRouter API
// ---------------------------------------------------------------------------
async function loadFreeModels() {
  if (freeModels !== null) return freeModels;

  try {
    const resp = await fetch(OPENROUTER_MODELS_URL, {
      headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    // A model is free when its prompt and completion pricing are both "0"
    const list = (data.data ?? [])
      .filter(m => {
        const p = m.pricing ?? {};
        return String(p.prompt) === '0' && String(p.completion) === '0';
      })
      .map(m => m.id);

    if (list.length === 0) throw new Error('No free models found in API response');

    // Sort by provider priority; within the same provider sort alphabetically
    function providerOf(id) { return id.split('/')[0]; }
    function priorityOf(id) {
      const idx = PROVIDER_PRIORITY.indexOf(providerOf(id));
      return idx === -1 ? PROVIDER_PRIORITY.length : idx;
    }

    freeModels = list.sort((a, b) => {
      const diff = priorityOf(a) - priorityOf(b);
      return diff !== 0 ? diff : a.localeCompare(b);
    });

    console.log(`[models] ${freeModels.length} free models loaded from OpenRouter API.`);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const hasKey = Boolean(process.env.OPENROUTER_API_KEY);
    throw new Error(
      `[models] Failed to fetch free model list: ${reason}. ` +
      (hasKey ? 'Check that your API key is valid and that network access to OpenRouter is available.'
               : 'OPENROUTER_API_KEY is not set — copy .env.example to .env and add your key.')
    );
  }

  return freeModels;
}

// List and exit (helper command)
async function cmdModels() {
  const models = await loadFreeModels();
  console.log(`\nFree models available on OpenRouter (${models.length} total):\n`);
  models.forEach((id, i) => console.log(`  ${String(i + 1).padStart(2)}. ${id}`));
  console.log('');
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------
// Anchored to the career-ops data root, not to __dirname. scan.mjs resolves
// every path it touches through getCareerOpsRoot(), so with CAREER_OPS_DATA_DIR
// set this module was reading a DIFFERENT data/scan-history.tsv than the shared
// writers it now delegates to — dedup would clear a URL the writer then found
// present, or skip one it had never seen. The default is unchanged: with no
// env and no .career-ops-data marker, getCareerOpsRoot() returns the same
// directory __dirname did.
const DATA_ROOT = getCareerOpsRoot();
// System-layer files ship with the code and never follow the data root: a data
// root outside the checkout holds cv.md and modes/_profile.md, but no
// modes/_shared.md or modes/oferta.md. Read through readFile() those came back
// null, fell through to '', and the evaluation ran on a system prompt with no
// shared rules and no evaluation mode (#5115). Same split as ollama-eval.mjs
// and gemini-eval.mjs.
const CODE_ROOT = __dirname;

function readFile(relPath) {
  try { return fs.readFileSync(path.join(DATA_ROOT, relPath), 'utf-8'); }
  catch { return null; }
}

function readProfile() {
  try { return fs.readFileSync(getProfilePath(), 'utf-8'); }
  catch { return null; }
}

function readSystemFile(relPath) {
  try { return fs.readFileSync(path.join(CODE_ROOT, relPath), 'utf-8'); }
  catch { return null; }
}

function writeFile(relPath, content) {
  const full = path.join(DATA_ROOT, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

function fileExists(relPath) {
  // Same root as readFile() above: a fileExists that disagrees with the reader
  // is a split-brain waiting to happen under CAREER_OPS_DATA_DIR.
  return fs.existsSync(path.join(DATA_ROOT, relPath));
}

// ---------------------------------------------------------------------------
// Prompt caching (#1709)
// ---------------------------------------------------------------------------
// The static system prefix (shared + profile + mode + cv, ~12K tokens) is
// byte-identical across every offer in a run, yet it was re-sent and re-billed
// on each call. Send it as a structured content block with an ephemeral
// `cache_control` breakpoint — OpenRouter's documented prompt-caching mechanism.
// Providers that support caching (Anthropic, Gemini, …) reuse the prefix across
// back-to-back calls within the cache TTL; providers that don't simply ignore
// the field, so this is a safe passthrough that never changes the prompt text.
export function buildCachedSystemMessage(systemPrompt) {
  return {
    role: 'system',
    content: [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
  };
}

// ---------------------------------------------------------------------------
// OpenRouter API call — automatic model rotation with fallback
// ---------------------------------------------------------------------------
/**
 * Fork guard: OpenRouter pays for the Jev pre-screen only. A pinned paid model
 * spends real credit on every full evaluation (60k+ prompt tokens each), and
 * the Claude subscription runs the same evaluation for nothing (`claude -p`,
 * batch/batch-runner.sh, /career-ops pipeline). A `:free` model passes; any
 * other pinned model needs CAREER_OPS_ALLOW_PAID_OPENROUTER=1 in that shell.
 *
 * @param {string|undefined} model - CAREER_OPS_MODEL
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null} the refusal message, or null when the call may proceed
 */
export function paidModelRefusal(model, env = process.env) {
  if (!model || /:free$/.test(model) || env.CAREER_OPS_ALLOW_PAID_OPENROUTER === '1') return null;
  return `Refusing to evaluate with the paid model ${model} through OpenRouter: this fork keeps OpenRouter for the Jev pre-screen. `
    + 'Run evaluations through your Claude subscription (bash batch/batch-runner.sh, or /career-ops pipeline), '
    + 'or set CAREER_OPS_ALLOW_PAID_OPENROUTER=1 for this one shell.';
}

async function callOpenRouter(systemPrompt, userMessage) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      'OPENROUTER_API_KEY not found.\n' +
      'Copy .env.example to .env and add your API key.\n' +
      'Free key: https://openrouter.ai'
    );
  }

  const pinnedModel = process.env.CAREER_OPS_MODEL;
  if (pinnedModel) {
    const refusal = paidModelRefusal(pinnedModel);
    if (refusal) throw new Error(refusal);
    activeModel = pinnedModel;
    process.stdout.write(`[model] ${pinnedModel} (pinned) ... `);
    const body = JSON.stringify(buildRequestBody({ model: pinnedModel, systemPrompt, userMessage, maxTokens: MAX_TOKENS, reasoning: REASONING }));
    const ctrl = new AbortController();
    const timerId = setTimeout(() => ctrl.abort(), MODEL_TIMEOUT_MS);
    try {
      const resp = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type':  'application/json',
          'HTTP-Referer':  'https://github.com/career-ops-hq/career-ops',
          'X-Title':       'career-ops',
        },
        body,
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${t.slice(0, 120)}`);
      }
      const data = await resp.json();
      if (data.error) throw new Error(data.error.message);
      const content = data.choices?.[0]?.message?.content ?? '';
      if (!content) throw new Error(describeEmptyResponse(data, MAX_TOKENS));
      console.log('OK');
      const usage = normalizeOpenAIUsage(data.usage);
      return { content, usage };
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`Pinned model timed out after ${MODEL_TIMEOUT_MS / 1000}s`);
      throw e;
    } finally {
      clearTimeout(timerId);
    }
  }

  const models = await loadFreeModels();
  let lastError;

  if (models.length === 0) {
    throw new Error(
      'No free OpenRouter models are available. Model loading may have failed, or your account currently has no free models.'
    );
  }
  // Build the active (non-blacklisted) model list in rotation order
  const active = models.filter(m => !blacklistedModels.has(m));
  if (active.length === 0) throw new Error('All loaded models have been blacklisted this session.');

  for (let attempt = 0; attempt < active.length; attempt++) {
    const model = active[(modelIndex % active.length + attempt) % active.length];
    activeModel = model;
    process.stdout.write(`[model] ${model} ... `);

    try {
      const body = JSON.stringify(buildRequestBody({ model, systemPrompt, userMessage, maxTokens: MAX_TOKENS, reasoning: REASONING }));

      const controller = new AbortController();
      const timerId = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
      let data;
      try {
        const resp = await fetch(OPENROUTER_API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type':  'application/json',
            'HTTP-Referer':  'https://github.com/career-ops-hq/career-ops',
            'X-Title':       'career-ops',
          },
          body,
          signal: controller.signal,
        });
        if (!resp.ok) {
          const t = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${t.slice(0, 120)}`);
        }
        data = await resp.json();
      } catch (e) {
        if (e.name === 'AbortError') throw new Error(`Timeout after ${MODEL_TIMEOUT_MS / 1000}s`);
        throw e;
      } finally {
        clearTimeout(timerId);
      }
      if (data.error) throw new Error(data.error.message);

      const content = data.choices?.[0]?.message?.content ?? '';
      if (!content) throw new Error(describeEmptyResponse(data, MAX_TOKENS));

      const usage = normalizeOpenAIUsage(data.usage);

      modelIndex = (modelIndex + attempt + 1) % active.length;
      delete rateLimitCounts[model];
      console.log('OK');
      return { content, usage };

    } catch (e) {
      lastError = e;
      const msg = e.message.split('\n')[0];

          const is403     = msg.includes('HTTP 403');
      const isTimeout = msg.startsWith('Timeout');
      const is429     = msg.includes('HTTP 429') || msg.includes('rate-li') || msg.includes('rate limit') || msg.includes('temporarily rate');
      if (is403 || isTimeout) {
        blacklistedModels.add(model);
        saveBlacklist(blacklistedModels);
        console.log(`SKIP (blacklisted: ${msg})`);
      } else if (is429) {
        rateLimitCounts[model] = (rateLimitCounts[model] ?? 0) + 1;
        if (rateLimitCounts[model] >= 3) {
          blacklistedModels.add(model);
          saveBlacklist(blacklistedModels);
          console.log(`SKIP (auto-blacklisted: persistent 429)`);
        } else {
          console.log(`FAILED (HTTP 429 [${rateLimitCounts[model]}/3])`);
          await new Promise(r => setTimeout(r, 800));
        }
      } else {
        delete rateLimitCounts[model];
        console.log(`FAILED (${msg})`);
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }

  throw new Error(`All ${active.length} active models failed. Last error: ${lastError?.message}`);
}

// Exported so tests/openrouter-runner-429-reset.test.mjs can script fetch()
// against the real rotation and blacklist logic without a network or a CLI run.
export { callOpenRouter, rateLimitCounts, blacklistedModels };

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------
function loadContext() {
  // modes/_context.md is the candidate's fit profile, the context tier of the
  // Source-of-Truth Boundary (AGENTS.md): qualitative facts are evidence for
  // the evaluation, numbers are targeting only, never a source for
  // candidate-facing text. Its numbers are masked before the model sees them
  // (lib/context-evidence.mjs). Optional: an install without it evaluates on
  // cv.md and profile.yml exactly as before, with one line saying so.
  const context = readMaskedContext(DATA_ROOT)?.text ?? null;
  if (context === null) console.log('ℹ️  modes/_context.md not found — evaluating on cv.md and profile.yml only');
  return {
    cv:          readFile('cv.md')               ?? 'CV not found.',
    profile:     readProfile()                   ?? '',
    shared:      readSystemFile('modes/_shared.md') ?? '',
    profileMode: readFile('modes/_profile.md')   ?? '',
    context:     context                         ?? '',
  };
}

export function buildSystemPrompt(modeContent, ctx) {
  const languageInstruction = outputLanguageInstruction(parseOutputLanguage(ctx.profile));
  // The context block is conditional as a whole: with no context file the
  // prompt is byte-identical to the one built before the block existed, so
  // prompt caching and the recorded prompts of older runs are undisturbed.
  const contextBlock = ctx.context
    ? ['---', 'CANDIDATE CONTEXT (context tier: qualitative facts are evidence for the evaluation, cite them as _context.md:; its numbers are masked as [n], so every figure you see came from cv.md or article-digest.md and a [n] is never written as a figure; never a source for the CV, a letter or a form answer):', ctx.context]
    : [];
  return [
    ctx.shared,
    ctx.profileMode,
    modeContent,
    '---',
    'CANDIDATE PROFILE (YAML):',
    ctx.profile,
    '---',
    'CV (Markdown):',
    ctx.cv,
    ...contextBlock,
    '---',
    'OUTPUT LANGUAGE:',
    languageInstruction,
  ].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------------------
// Jev pre-screen (modes/_shared.md → Calibrated pre-screen (Jev))
// ---------------------------------------------------------------------------
// The helper lives in lib/jev-prescreen.mjs so every evaluator shares it
// without importing this runner; re-exported here for the existing callers
// and tests.
import { jevPrescreen, loadJevModule } from './lib/jev-prescreen.mjs';
export { jevPrescreen, loadJevModule };

/**
 * Import a sibling module by path, or null when it does not exist or does
 * not load. Resolved from this file's own URL, never from the data root.
 * @param {string} rel
 * @returns {Promise<object|null>}
 */
async function loadOptionalModule(rel) {
  const target = fileURLToPath(new URL(rel, import.meta.url));
  if (!fs.existsSync(target)) return null;
  try { return await import(pathToFileURL(target).href); } catch { return null; }
}

/**
 * Fill process.env.OPENROUTER_API_KEY from the shared resolver when .env and the
 * environment left it empty: OPENROUTER_API_KEY_JOB_SEARCH, the code-root and
 * data-root .env files, then the macOS Keychain (lib/openrouter-key.mjs). The
 * main OpenRouter call reads process.env, so this is the one place the fork
 * widens where the key may live; nothing here prints or stores the key.
 *
 * @param {{ env?: NodeJS.ProcessEnv, dataRoot?: string }} [opts]
 * @returns {Promise<string|null>} the key now in env, or null when none was found
 */
export async function ensureOpenRouterKeyInEnv({ env = process.env, dataRoot = DATA_ROOT } = {}) {
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY;
  const keyModule = await loadOptionalModule('./lib/openrouter-key.mjs');
  if (typeof keyModule?.resolveOpenRouterKey !== 'function') return null;
  const codeRoot = fileURLToPath(new URL('.', import.meta.url));
  const { key } = keyModule.resolveOpenRouterKey({ env, codeRoot, dataRoot });
  if (key) env.OPENROUTER_API_KEY = key;
  return key ?? null;
}


// ---------------------------------------------------------------------------
// Job page content fetcher (Playwright-first, plain fetch fallback)
// ---------------------------------------------------------------------------
// Reject unsafe fetch targets (SSRF defense-in-depth): http(s) only, never
// loopback / link-local / private / cloud-metadata hosts. URLs come from the
// user's own portals.yml / pipeline.md, but we still fail closed.
function assertSafeRemoteUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`Refusing non-HTTP(S) URL: ${url}`);
  }
  const host = u.hostname.toLowerCase();
  const blocked = host === 'localhost' || host === '::1' || host.endsWith('.local') ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) throw new Error(`Refusing private/loopback host: ${host}`);
  return u;
}

async function fetchJobPage(url) {
  assertSafeRemoteUrl(url);
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.warn('[fetch] Playwright unavailable — falling back to plain fetch.');
  }

  if (chromium) {
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(2000); // wait for SPA render
      const text = await page.evaluate(() => {
        document.querySelectorAll('script,style,nav,footer,header').forEach(el => el.remove());
        return (document.body?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ').trim();
      });
      return text.slice(0, 16_000);
    } catch (e) {
      console.warn(`[fetch] Playwright error: ${e.message} — falling back to plain fetch.`);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  // Plain HTTP fallback
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    const html = await r.text();
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 16_000);
  } catch (e) {
    throw new Error(`Could not fetch job page: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// portals.yml parser — reads the canonical schema with js-yaml (same library and
// field names as scan.mjs: `title_filter.positive/negative` + `tracked_companies`),
// so it never drifts from the main scanner. The runner's no-CLI scan path covers
// companies that expose a direct JSON `api:`; careers_url-only / Playwright /
// search-query companies are handled by the full /career-ops scan pipeline.
// `rawOverride` lets tests feed YAML text directly (see test-all.mjs drift guard).
// ---------------------------------------------------------------------------
export function parsePortals(rawOverride) {
  const raw = rawOverride ?? readFile('portals.yml');
  if (!raw) throw new Error('portals.yml not found');
  const config = loadYaml(raw) || {};

  // The shared predicate rather than a second copy of the matching rules. This
  // path kept its own `includes` loop, and the two had drifted three ways: an
  // empty positive list accepted every title in scan.mjs and rejected every
  // title here, AND-groups worked only in scan.mjs, and a non-string YAML entry
  // was dropped there but coerced into a live keyword here. A `word:` prefix
  // would have become the fourth — read as literal text, it would have matched
  // nothing, so the shipped `word:Intern` would stop rejecting "Operations
  // Intern" here while still working in scan.mjs.
  //
  // Side effect worth naming, since it changes this path's verdicts rather than
  // just its structure: it now also gets the 2-3 char rule. Measured over 2324
  // real titles that moves one verdict, and it moves it the permissive way —
  // the negative "iOS" had been matching inside "Biosamples". Nothing becomes
  // newly rejected.
  const titleMatches = buildTitleFilter(config.title_filter);

  // Companies with a direct JSON `api:` endpoint (the no-CLI scan path).
  const tracked = Array.isArray(config.tracked_companies) ? config.tracked_companies : [];
  const companies = tracked
    .filter(c => c && c.api && c.enabled !== false)
    .map(c => ({ name: String(c.name ?? c.company ?? 'Unknown'), api: String(c.api).trim() }));

  return { companies, titleMatches, config };
}

// ---------------------------------------------------------------------------
// pipeline.md management
// ---------------------------------------------------------------------------
function readPipeline() {
  const content = readFile('data/pipeline.md') ?? '';
  const pending = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^- \[ \] (.+)/);
    if (m) {
      const parts = m[1].split(' | ');
      pending.push({
        url:     parts[0]?.trim() ?? '',
        company: parts[1]?.trim() ?? 'Unknown',
        role:    parts[2]?.trim() ?? 'Unknown',
      });
    }
  }
  return pending;
}

// Move the pending row for `url` under Processed, through the one helper every
// evaluator path shares (lib/pipeline-processed.mjs): matched by posting key,
// written under the pipeline lock, with the report link and score when the
// caller has them. An earlier version ticked the row in place with an
// unlocked, truncating write and a prefix match that confused jobs/1 with
// jobs/12; both faults are the helper's to prevent now.
export async function markPipelineDone(url, { pipelinePath = path.join(DATA_ROOT, 'data', 'pipeline.md'), reportFile = null, score = 'N/A', pdf = '❌' } = {}) {
  if (!fs.existsSync(pipelinePath)) return null;
  const num = reportFile ? reportFile.match(/^(\d+)-/)?.[1] ?? null : null;
  const reportLink = reportFile && num ? normalizeReportLink(`[${num}](reports/${reportFile})`, path.dirname(pipelinePath), DATA_ROOT) : '-';
  return markPipelineProcessed(pipelinePath, [{ url, reportLink, score, pdf }]);
}

// Both writes go through the shared writers in scan.mjs rather than this
// module's own read-modify-write. Those writers hold pipeline-lock.mjs on the
// file they touch, so this stops being a fourth, unlocked writer racing the
// three appendToPipeline already names. The previous version read each file
// whole, appended in memory, and wrote the whole thing back with a truncating
// writeFileSync — so any row another scanner appended in between was erased,
// silently, because every reader skips a malformed or missing row quietly.
//
// Delegating fixes three things at once that were all symptoms of hand-rolling
// the write: the lock, the row format (formatScanHistoryRow emits every trailing
// column; this module wrote seven and created a seven-column header), and the
// date (the shared path stamps the local day, this one stamped the UTC day —
// the defect #3240/#3241 fixed in the other scanners, which this module escaped
// because that census finds scanners by looking for appendToScanHistory calls).
//
// It also picks up CAREER_OPS_DATA_DIR support for free: the shared paths are
// DATA_ROOT-anchored, while the __dirname-relative paths here ignored it.
//
// Admission goes through the shared gate (#5478): the seen set compares
// normalized URLs across scan-history, the pipeline and the tracker, and the
// blacklist and location filter apply as they do in scan.mjs. The raw-URL sets
// this built before re-queued a posting whose URL differed by a tracking
// parameter, and nothing here read data/blacklist.md.
export async function addToPipeline(entries, config = {}, gate = createAdmissionGate({ config })) {
  // The shared writers take {url, company, title, location}; this module calls
  // the title `role`.
  const offers = entries.map(e => ({
    url: e.url,
    company: e.company,
    title: e.role,
    location: typeof e.location === 'string' ? e.location : '',
    source: 'openrouter scan',
  }));

  const { admitted } = gate.partition(offers);
  const skipped = formatSkipCounts(gate.counts);
  if (skipped) console.log(`Skipped: ${skipped}`);
  if (admitted.length === 0) return 0;

  await appendToPipeline(admitted);
  await appendToScanHistory(admitted, localToday());
  return admitted.length;
}

/**
 * A pasted job may start with `URL: https://...` (the line the feeder and the
 * runbook put first). It is the posting URL for the report header and the
 * tracker row, and it is dropped from the archived JD text.
 *
 * @param {string} text
 * @returns {{ url: string|null, rest: string }}
 */
export function extractPostingUrl(text) {
  const m = String(text ?? '').match(/^\s*URL:\s*(https?:\/\/\S+)\s*\n?/i);
  if (!m) return { url: null, rest: String(text ?? '') };
  return { url: m[1], rest: String(text).slice(m[0].length) };
}

/**
 * Company and role from the report's own title line, `# Evaluation: {Company}
 * — {Role}` (the dash may be an em dash, an en dash, `--` or ` - `). The slug
 * guess from the JD text used to name a pasted evaluation "you" or "company",
 * and the tracker row carried "(see report)" as the role, so merge-tracker had
 * nothing to dedupe on (#fork).
 *
 * @param {string} result - the model's evaluation
 * @returns {{ company: string|null, role: string|null }}
 */
export function extractCompanyRole(result) {
  const text = String(result ?? '');
  const clean = (s) => s.replace(/\*\*/g, '').replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
  // The Machine Summary is the schema authority (batch/batch-prompt.md): its
  // company and role fields are filled even when the model skipped the title.
  const fence = text.match(/##\s*Machine Summary\s*\n+```(?:yaml|yml)?\s*\n([\s\S]*?)\n```/i);
  if (fence) {
    const c = fence[1].match(/^company:\s*(.+?)\s*$/m); const r = fence[1].match(/^role:\s*(.+?)\s*$/m);
    const company = c ? clean(c[1]) : ''; const role = r ? clean(r[1]) : '';
    if (company && role && company !== '?' && !/^\{.*\}$/.test(company) && company.length <= 80) return { company, role };
  }
  const m = text.match(/^#\s*(?:Evaluation|Evaluaci[oó]n|Bewertung):\s*(.+?)\s*(?:—|–|--| - |:)\s*(.+?)\s*$/m);
  if (!m) return { company: null, role: null };
  const company = clean(m[1]); const role = clean(m[2]);
  if (!company || !role || company.length > 80) return { company: null, role: null };
  return { company, role };
}

function extractCompanySlug(text, url) {
  // Try to extract from text (e.g. "Senior Engineer at Acme" or "Company: Acme")
  const m = text.match(/(?:at|@|company[:\s]+)\s*([A-Z][A-Za-z0-9]{2,25})/);
  if (m) return m[1].toLowerCase().replace(/[^a-z0-9]+/g, '-');
  // Fall back to URL hostname (e.g. job-boards.greenhouse.io/acme → acme)
  if (url) {
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      const slug = parts[0] ?? 'company';
      return slug.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    } catch { /* not a valid URL */ }
  }
  return 'company';
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// -- SCAN --
async function cmdScan() {
  tracker.recordZeroToken('scan');
  tracker.recordZeroToken('evaluation');
  tracker.recordZeroToken('pdf payload');
  console.log('Scanning Greenhouse portals...\n');

  let portals;
  try { portals = parsePortals(); }
  catch (e) { console.error(e.message); return; }

  const { companies, titleMatches, config } = portals;
  console.log(`Greenhouse API companies: ${companies.length}\n`);

  const found = [];
  for (const c of companies) {
    process.stdout.write(`  ${c.name.padEnd(25)} → `);
    try {
      assertSafeRemoteUrl(c.api);
      const r = await fetch(c.api);
      if (!r.ok) { console.log(`HTTP ${r.status}`); continue; }
      const data = await r.json();
      const jobs = data.jobs ?? [];
      const matched = jobs.filter(j => titleMatches(j.title));
      console.log(`${jobs.length} listings, ${matched.length} matched`);
      for (const j of matched) {
        // Skip postings without a public URL — falling back to the API
        // endpoint would write an unusable link into the pipeline.
        if (!j.absolute_url) continue;
        found.push({ url: j.absolute_url, company: c.name, role: j.title, location: j.location?.name ?? '' });
      }
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
  }

  const added = await addToPipeline(found, config);
  console.log(`\n✅ Scan complete. ${found.length} matches, ${added} new entries added to pipeline.md.`);
  if (added > 0) {
    console.log('\n→  node openrouter-runner.mjs pipeline\n   to evaluate pending listings.\n');
  }
}

// -- EVALUATE --
async function cmdEvaluate(input, ctx) {
  tracker.recordZeroToken('scan');
  tracker.recordZeroToken('pdf payload');
  const modeContent = readSystemFile('modes/oferta.md') ?? readSystemFile('modes/auto-pipeline.md') ?? '';

  let jdText = input;
  // The posting text alone, for the report's verbatim archive: jdText gains a
  // `URL:` line for the model when the input is a link.
  let archiveText = input;
  // The posting URL the report header and the tracker row carry: the link the
  // user passed, or the `URL:` line at the top of a pasted job.
  let postingUrl = typeof input === 'string' && input.startsWith('http') ? input : null;

  if (!input) {
    // Interactive paste mode
    console.log('Paste job description or URL, then press Enter on an empty line:\n');
    const rl = readline.createInterface({ input: process.stdin });
    const lines = [];
    try {
      for await (const line of rl) {
        if (line === '') break;
        lines.push(line);
      }
    } finally {
      rl.close();
    }
    jdText = lines.join('\n');
    const lifted = extractPostingUrl(jdText);
    postingUrl = lifted.url;
    archiveText = lifted.rest;
    if (!jdText.trim()) { console.log('No input provided.'); return null; }
  } else if (input.startsWith('http')) {
    console.log('Fetching job page...');
    try {
      const content = await fetchJobPage(input);
      jdText = `URL: ${input}\n\n${content}`;
      archiveText = content;
    } catch (e) {
      console.error(e.message);
      return null;
    }
  }

  // Jev pre-screen: zero agent tokens, appended to the request so the model
  // reports it (`**Jev:**`, Machine Summary `jev:`) and never recomputes it.
  // With jev-score.mjs absent the request is exactly what it was before.
  const prescreen = await jevPrescreen({
    url: typeof input === 'string' && input.startsWith('http') ? input : '',
    title: '', company: '', location: '', workplace: '', seniority: '',
    description: archiveText ?? '',
  }, { jev: await loadJevModule() });
  console.log(prescreen.notice);
  const userMessage = prescreen.block
    ? `Evaluate this job listing:\n\n${jdText}\n\n${prescreen.block}`
    : `Evaluate this job listing:\n\n${jdText}`;

  console.log('\nEvaluating...');
  const systemPrompt = buildSystemPrompt(modeContent, ctx);

  let resultObj;
  try {
    resultObj = await callOpenRouter(systemPrompt, userMessage);
  } catch (e) {
    console.error(`OpenRouter error: ${e.message}`);
    return null;
  }
  tracker.record('evaluation', resultObj.usage);
  const result = resultObj.content;

  let reservedNumbers;
  try {
    reservedNumbers = await reserveReportNumbers(1, {
      rootDir: DATA_ROOT,
      reportsDir: path.join(DATA_ROOT, 'reports'),
    });
  } catch (e) {
    console.error(`Could not reserve a report number: ${e.message}`);
    return null;
  }

  try {
    // Save report
    const today   = localToday();
    const num     = reservedNumbers[0];
    const named   = extractCompanyRole(result);
    const slug    = named.company
      ? (named.company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || extractCompanySlug(jdText, postingUrl))
      : extractCompanySlug(jdText, postingUrl);
    const numStr  = formatReportNumber(num);
    const relPath = `reports/${numStr}-${slug}-${today}.md`;
    lastSavedReport = null;

    // The report opens with the model's own header when it wrote one. Only a
    // result without a `**URL:**` line gets the URL and Legitimacy lines
    // prepended: a second header above the first made the dashboard read
    // `(pasted)` as the posting URL (reports showed "No application URL").
    const legitMatch = result.match(/\*\*Legitimacy:\*\*\s*([^\n]+)/);
    const legitLine  = legitMatch ? `**Legitimacy:** ${legitMatch[1].trim()}` : '**Legitimacy:** unconfirmed';
    const prelude = /^\*\*URL:\*\*/m.test(result) ? '' : `**URL:** ${postingUrl || '(pasted)'}\n${legitLine}\n\n`;
    writeFile(relPath, `${prelude}${withJdArchiveSection(result, archiveText)}`);

    // Capture the DENOMINATOR when the model writes one. The old pattern took
    // only the numeric prefix, so `Score: 8/10` yielded `8` and the cell became
    // `8.0/5` -- a ten-point score reinterpreted as a five-point one. That
    // satisfies SCORE_CELL_RE, so it merged as a genuine score and fed
    // stats.mjs's averages. normalizedTrackerScore refuses a denominator that
    // is not 5, but only if it is handed one (#3796).
    //
    // The capture runs to END OF LINE rather than stopping at a denominator
    // adjacent to the number. Requiring adjacency read `Score: 4.2 (strong
    // fit)/10` -- a ten-point score with an annotation -- as a bare 4.2 and
    // wrote `4.2/5`, the same wrong number the numeric prefix used to produce.
    // The cost is that an unrelated fraction later in the line (`Score: 4.2 --
    // matched 3/4 axes`) is refused as N/A rather than guessed at. That is the
    // trade the shared helper already documents and the gemini path already
    // pins: N/A is recoverable, a wrong score is not.
    const scoreMatch  = result.match(/(?:score|puntuaci[oó]n)[^\d]*(\d+(?:\.\d+)?[^\r\n]*)/i);
    // An unparseable score used to become the EMPTY string, and merge-tracker
    // refuses a blank required cell ("use the documented sentinel rather than a
    // blank cell") -- so the evaluation was skipped whole, the same loss #3796
    // documents for the drifted copies. The shared helper returns the `N/A`
    // sentinel (#1799), which merges as an unscored row instead of as nothing.
    const scoreStr    = normalizedTrackerScore(scoreMatch ? scoreMatch[1] : '');
    const companyName = named.company ?? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const roleName    = named.role ?? '(see report)';
    const reportLink  = `[${numStr}](reports/${numStr}-${slug}-${today}.md)`;
    const cell        = (s) => String(s).replace(/[\t\r\n]+/g, ' ').trim();
    // No url column: merge-tracker.mjs derives the posting URL from the report's
    // own `**URL:**` header (resolveReportUrl), which this report now carries,
    // and the suite checks that every evaluator writes exactly the shared
    // header above its row.
    const tsvLine     = `${num}\t${today}\t${cell(companyName)}\t${cell(roleName)}\tEvaluated\t${scoreStr}\t❌\t${reportLink}\t\n`;
    const tsvFile     = `batch/tracker-additions/or-${numStr}-${slug}.tsv`;
    // Header row, then the single data row. merge-tracker.mjs resolves the
    // fields by NAME when the header is present (#3517), so this row cannot be
    // read into the wrong columns. (Headerless files still work; they are the
    // legacy form, and they are the ones that can hit the undecidable
    // score-vs-status case.)
    writeFile(tsvFile, `${TSV_ADDITION_HEADER}\n${tsvLine}`);
    lastSavedReport = { reportFile: `${numStr}-${slug}-${today}.md`, score: scoreStr };

    console.log(`\n✅ Report saved: ${relPath}`);
    console.log('\n─── EVALUATION ──────────────────────────────────────\n');
    console.log(result);
    console.log('\n─────────────────────────────────────────────────────\n');

    return relPath;
  } finally {
    try {
      await releaseReportNumbers(reservedNumbers, { reportsDir: path.join(DATA_ROOT, 'reports') });
    } catch (e) {
      console.warn(`Could not release report reservation: ${e.message}`);
    }
  }
}

// -- PIPELINE --
async function cmdPipeline(ctx) {
  const pending = readPipeline();
  if (pending.length === 0) {
    console.log('No pending listings in pipeline.md.');
    return;
  }

  console.log(`Processing ${pending.length} pending listing(s) from pipeline.md...\n`);

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    console.log(`\n[${i + 1}/${pending.length}] ${item.company} — ${item.role}`);
    try {
      const report = await cmdEvaluate(item.url, ctx);
      if (report) await markPipelineDone(item.url, { reportFile: lastSavedReport?.reportFile ?? null, score: lastSavedReport?.score ?? 'N/A' });
    } catch (e) {
      console.error(`  Error: ${e.message}`);
    }
    if (i < pending.length - 1) {
      await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
    }
  }

  console.log('\n✅ Pipeline processing complete.\n');
}

// -- APPLY --
async function cmdApply(ref, ctx) {
  tracker.recordZeroToken('scan');
  tracker.recordZeroToken('evaluation');
  tracker.recordZeroToken('pdf payload');
  const modeContent = readSystemFile('modes/apply.md') ?? '';

  let reportContent;
  let reportPath;
  try {
    const located = locateApplyReport(DATA_ROOT, ref, {
      exists: (p) => fs.existsSync(p),
      list: (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []),
    });
    if (!located.ok) {
      console.error(`Report not found: ${ref}`);
      return;
    }
    reportPath = located.path;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return;
  }
  try {
    reportContent = fs.readFileSync(reportPath, 'utf8');
  } catch {
    reportContent = null;
  }

  if (!reportContent) { console.error('Could not read report content.'); return; }

  // Score-gate: warn and confirm before applying to low-fit roles (AGENTS.md Ethical Use)
  const scoreMatch = reportContent.match(/^\s*\*?\*?\s*(?:score|puntuaci[oó]n)\s*:\s*\*?\*?\s*(\d+(?:\.\d+)?)\s*\/\s*5/im);
  const scoreValue = scoreMatch ? parseFloat(scoreMatch[1]) : NaN;
  if (isFinite(scoreValue) && scoreValue < 4.0) {
    console.log(`\n⚠️  This report scored ${scoreValue.toFixed(1)}/5 — below the 4.0/5 threshold.`);
    console.log('Strongly discourage low-fit applications. Your time and the recruiter\'s time are both valuable.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => {
      rl.question('Proceed anyway? (yes/no): ', resolve);
    });
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('Aborted.');
      return;
    }
  }

  console.log('Generating application form answers...');
  const systemPrompt = buildSystemPrompt(modeContent, ctx);

  let resultObj;
  try {
    resultObj = await callOpenRouter(
      systemPrompt,
      `Generate application form answers based on this evaluation report:\n\n${reportContent}`
    );
  } catch (e) {
    console.error(`OpenRouter error: ${e.message}`);
    return;
  }
  tracker.record('apply', resultObj.usage);
  const result = resultObj.content;

  console.log('\n─── APPLICATION ANSWERS ─────────────────────────────\n');
  console.log(result);
  console.log('\n─────────────────────────────────────────────────────\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
// Only run the CLI when invoked directly (`node openrouter-runner.mjs ...`), so the
// module can be imported (e.g. by test-all.mjs) without executing a command.
const invokedDirectly = isMainModule(import.meta.url);
const [,, command, ...args] = invokedDirectly ? process.argv : [];
if (invokedDirectly) loadEnvFile();
if (invokedDirectly) await ensureOpenRouterKeyInEnv();
if (invokedDirectly) MODEL_TIMEOUT_MS = resolveModelTimeoutMs();
if (invokedDirectly) { MAX_TOKENS = resolveMaxTokens(); REASONING = resolveReasoning(); }
const ctx = invokedDirectly ? loadContext() : null;

// Load free models list before running any AI command (skip when a model is pinned)
if (invokedDirectly && ['evaluate', 'eval', 'pipeline', 'apply', 'models'].includes(command) && !process.env.CAREER_OPS_MODEL) {
  await loadFreeModels();
}

if (invokedDirectly) switch (command) {
  case 'scan':
    await cmdScan();
    break;

  case 'evaluate':
  case 'eval':
    await cmdEvaluate(args.join(' ').trim() || null, ctx);
    break;

  case 'pipeline':
    await cmdPipeline(ctx);
    break;

  case 'apply':
    if (!args[0]) { console.error('Usage: node openrouter-runner.mjs apply <report_num|report_path>'); break; }
    await cmdApply(args[0], ctx);
    break;

  case 'models':
    await cmdModels();
    break;

  default:
    console.log(`
career-ops OpenRouter Runner
Auto-fetches free models from OpenRouter API and rotates through them with fallback.

COMMANDS:
  node openrouter-runner.mjs scan              → Scan Greenhouse APIs for new matching listings
  node openrouter-runner.mjs evaluate <url>    → Evaluate a listing by URL
  node openrouter-runner.mjs evaluate          → Paste a job description interactively
  node openrouter-runner.mjs pipeline          → Batch-evaluate all pending entries in pipeline.md
  node openrouter-runner.mjs apply <report_no> → Generate application form answers from a report
  node openrouter-runner.mjs models            → List available free models from OpenRouter

SETUP:
  1. Copy .env.example to .env
  2. Add your key: OPENROUTER_API_KEY=sk-or-v1-...
  3. Free API key: https://openrouter.ai

MODEL SELECTION:
  - Free models are fetched automatically via the OpenRouter API at runtime.
  - They are tried in sequence; if one fails the next is used automatically.
  - Pin a model:  CAREER_OPS_MODEL=deepseek/deepseek-r1:free node openrouter-runner.mjs eval <url>
`);
}

if (invokedDirectly && ['scan', 'evaluate', 'eval', 'pipeline', 'apply'].includes(command)) {
  const modelName = process.env.CAREER_OPS_MODEL || activeModel || 'free-rotation';
  console.log('\n' + formatBreakdown(tracker, modelName, 'openrouter'));
}
