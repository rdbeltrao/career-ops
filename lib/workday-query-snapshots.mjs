import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_AGE_MS = 2 * 60 * 60_000;
const MAX_QUERY_BYTES = 4 * 1024 * 1024;
const MAX_BOARD_BYTES = 128 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');

/** Short-lived, completed list queries; board completion remains the ledger's job. */
export function createWorkdayQuerySnapshots(base, namespace, { now = Date.now, maxAgeMs = MAX_AGE_MS, onError = () => {} } = {}) {
  const directory = path.join(base, hash(namespace));
  const boards = new Map();
  const stats = { hits: 0, saved: 0, errors: 0 };
  let warned = false, pruned = false;
  const failed = error => { stats.errors++; if (!warned) { warned = true; onError(error); } };
  const valid = (result, host) => result && ['complete', 'early-stop'].includes(result.stopReason)
    && typeof result.clamped === 'boolean' && (result.total === null || Number.isSafeInteger(result.total) && result.total >= 0)
    && Array.isArray(result.facets) && Array.isArray(result.jobs) && result.jobs.length <= 30_000
    && result.jobs.every(job => {
      try { return job && typeof job.title === 'string' && new URL(job.url).hostname === host
        && (job.postedAt === undefined || Number.isFinite(job.postedAt))
        && (job.postedAtUpperBound === undefined || Number.isFinite(job.postedAtUpperBound)); } catch { return false; }
    });
  const prune = () => {
    if (pruned) return;
    pruned = true;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const target = path.join(base, entry.name);
      if (target !== directory && entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)
        && now() - fs.statSync(target).mtimeMs > maxAgeMs) fs.rmSync(target, { recursive: true, force: true });
    }
  };
  return {
    stats,
    board(board) {
      if (boards.has(board)) return boards.get(board);
      const folder = path.join(directory, hash(board)), host = new URL(board).hostname;
      let bytes;
      const fileFor = key => path.join(folder, `${hash(key)}.json`);
      const cache = {
        get(key, sinceMs, requireAll = false) {
          try {
            const file = fileFor(key);
            if (fs.statSync(file).size > MAX_QUERY_BYTES) return null;
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (saved.version !== 1 || saved.key !== key || !Number.isFinite(saved.createdAt)
              || saved.createdAt > now() || now() - saved.createdAt > maxAgeMs
              || typeof saved.verifyNativeCounts !== 'boolean' || !valid(saved.result, host)) return null;
            // A date-stopped query only proves its original, wider window.
            if (saved.result.stopReason === 'early-stop'
              && (requireAll || !Number.isFinite(saved.sinceMs) || !Number.isFinite(sinceMs) || saved.sinceMs > sinceMs)) return null;
            stats.hits++;
            return saved;
          } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) failed(error); return null; }
        },
        set(key, result, sinceMs, verifyNativeCounts, capturedAt = now()) {
          if (!valid(result, host)) return;
          const body = JSON.stringify({ version: 1, key, createdAt: Math.min(capturedAt, now()), sinceMs, verifyNativeCounts, result });
          const length = Buffer.byteLength(body);
          if (length > MAX_QUERY_BYTES) return;
          const file = fileFor(key), temp = `${file}.${randomUUID()}.tmp`;
          try {
            fs.mkdirSync(folder, { recursive: true });
            prune();
            if (bytes === undefined) {
              bytes = 0;
              for (const name of fs.readdirSync(folder)) {
                if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
                const target = path.join(folder, name), stat = fs.statSync(target);
                if (now() - stat.mtimeMs > maxAgeMs) fs.rmSync(target, { force: true });
                else bytes += stat.size;
              }
            }
            let previous = 0;
            try { previous = fs.statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (bytes - previous + length > MAX_BOARD_BYTES) return;
            fs.writeFileSync(temp, body, { mode: 0o600 });
            fs.renameSync(temp, file);
            bytes = bytes - previous + length;
            stats.saved++;
          } catch (error) { failed(error); }
          finally { try { fs.rmSync(temp, { force: true }); } catch { /* best-effort cache cleanup */ } }
        },
        clear() { try { fs.rmSync(folder, { recursive: true, force: true }); bytes = 0; } catch (error) { failed(error); } },
      };
      boards.set(board, cache);
      return cache;
    },
    clearCompleted(completed) { for (const [board, cache] of boards) if (completed(board)) cache.clear(); },
  };
}
