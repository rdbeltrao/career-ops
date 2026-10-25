/**
 * jd-prefetch.mjs — read the posting from the ATS's public API before the
 * evaluate worker starts.
 *
 * The evaluate worker holds no Bash (#3629): a posting is untrusted input, and
 * Bash is not path-scoped. So it cannot run fetch-jd.mjs itself, and its only
 * way to read the posting was WebFetch. On a JavaScript-rendered board (Ashby,
 * Workday, LinkedIn) WebFetch returns an empty page shell; the worker then
 * applies the mode's "posting appears closed" rule, emits no report, and the
 * run fails with "The agent emitted no <<report-md>> envelope" — for a posting
 * that is live.
 *
 * The backend has no such restriction. It runs fetch-jd.mjs as a plain Node
 * child (no agent CLI, no model, no sandbox), writes the JD text to a file, and
 * the prompt points the worker at that file, which it reads with Read. A miss
 * (an ATS fetch-jd.mjs does not cover, a timeout, a dead posting) is not an
 * error: the worker falls back to WebFetch exactly as before.
 *
 * Plain .mjs with the spawn function injected, so it is unit-tested with
 * `node --test` and no real network.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** fetch-jd.mjs has its own 15s request timeout; this bounds a hung child. */
export const PREFETCH_TIMEOUT_MS = 25_000;

/** Shorter than this is a title or a stub, not a job description. */
export const MIN_JD_CHARS = 200;

/**
 * @param {{spawnFn: Function, execPath: string, codeRoot: string, url: string, outDir: string, timeoutMs?: number}} args
 * @returns {Promise<{ok: true, file: string, chars: number} | {ok: false}>}
 */
export async function prefetchJd({ spawnFn, execPath, codeRoot, url, outDir, timeoutMs = PREFETCH_TIMEOUT_MS }) {
  // The url is passed as an argv entry, never through a shell. Refusing anything
  // that is not http(s) also keeps a value such as "--help" from reaching the
  // script as a flag.
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return { ok: false };

  const text = await runFetchJd({ spawnFn, execPath, codeRoot, url, timeoutMs });
  if (!text || text.length < MIN_JD_CHARS) return { ok: false };

  try {
    fs.mkdirSync(outDir, { recursive: true });
    const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
    const file = path.join(outDir, `jd-${hash}.md`);
    fs.writeFileSync(file, text + "\n");
    return { ok: true, file, chars: text.length };
  } catch {
    return { ok: false };
  }
}

/** @returns {Promise<string>} the trimmed JD text, or "" on any miss. */
function runFetchJd({ spawnFn, execPath, codeRoot, url, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      const root = path.resolve(codeRoot);
      child = spawnFn(execPath, [path.join(root, "fetch-jd.mjs"), url], { cwd: root });
    } catch {
      resolve("");
      return;
    }
    let stdout = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      finish("");
    }, timeoutMs);
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.on("error", () => finish(""));
    child.on("close", (code) => finish(code === 0 ? stdout.trim() : ""));
  });
}
