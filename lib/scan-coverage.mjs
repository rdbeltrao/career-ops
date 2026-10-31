import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireDirLock, releaseOrWarn } from './dir-lock.mjs';

/** A scan's completed boards, committed only after its matches are saved. */
export async function openScanCoverage(file, signature) {
  const lock = await acquireDirLock(`${file}.lock`, { timeoutMs: 1000, retryMs: 50, staleMs: 30_000, createParent: true });
  try {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state?.version !== 1 || typeof state.signature !== 'string' || typeof state.complete !== 'boolean'
        || !Number.isFinite(Date.parse(state.startedAt))
        || (state.stalledRuns !== undefined && (!Number.isSafeInteger(state.stalledRuns) || state.stalledRuns < 0))
        || !state.sources || typeof state.sources !== 'object' || Array.isArray(state.sources)
        || Object.values(state.sources).some(s => !s || !Array.isArray(s.keys) || !Array.isArray(s.done)
          || [...s.keys, ...s.done].some(k => typeof k !== 'string'))) throw new Error('invalid coverage state');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // A permanently broken board must not prevent healthy boards being
    // refreshed forever. Allow three retry-only runs without progress, then
    // start a fresh sweep; failures remain visible in each scanner receipt.
    if (!state || state.signature !== signature || state.complete || state.stalledRuns >= 3) {
      state = { version: 1, signature, startedAt: new Date().toISOString(), sources: {}, complete: false };
    }
    const sources = new Map(Object.entries(state.sources).map(([name, source]) => [name, { keys: new Set(source.keys), done: new Set(source.done) }]));
    const initialCompleted = [...sources.values()].reduce((n, source) => n + source.done.size, 0);
    const unavailable = new Set();
    const summary = () => {
      const total = [...sources.values()].reduce((n, s) => n + s.keys.size, 0);
      const completed = [...sources.values()].reduce((n, s) => n + s.done.size, 0);
      return { startedAt: state.startedAt, companiesTotal: total, companiesCompleted: completed, remaining: total - completed, sourcesUnavailable: [...unavailable] };
    };
    return {
      register(name, keys, status = 'ok') {
        if (status !== 'ok') unavailable.add(name);
        if (status === 'empty') return;
        const previous = sources.get(name);
        const keySet = new Set(keys);
        sources.set(name, { keys: keySet, done: new Set([...previous?.done || []].filter(key => keySet.has(key))) });
      },
      pending(name, key) { return !sources.get(name)?.done.has(key); },
      done(name, key) { const source = sources.get(name); if (source?.keys.has(key)) source.done.add(key); },
      fraction(name) { const source = sources.get(name); return source?.keys.size ? source.done.size / source.keys.size : 0; },
      summary,
      // Caller must persist admitted jobs first. Interrupted in-flight boards
      // remain pending, so resuming cannot skip jobs that never reached disk.
      save() {
        const coverage = summary();
        const next = { ...state, complete: coverage.companiesTotal > 0 && coverage.remaining === 0 && !unavailable.size,
          stalledRuns: coverage.companiesCompleted > initialCompleted ? 0 : (state.stalledRuns || 0) + 1,
          sources: Object.fromEntries([...sources].map(([name, s]) => [name, { keys: [...s.keys], done: [...s.done] }])),
          updatedAt: new Date().toISOString() };
        const temp = `${file}.${randomUUID()}.tmp`;
        try { fs.writeFileSync(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 }); fs.renameSync(temp, file); }
        finally { fs.rmSync(temp, { force: true }); }
      },
      close() { releaseOrWarn(lock); },
    };
  } catch (error) { releaseOrWarn(lock); throw error; }
}
