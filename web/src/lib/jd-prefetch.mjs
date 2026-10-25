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
 * The backend has no such restriction. It looks for the JD in two places, in
 * order, writes the text to a file, and the prompt points the worker at that
 * file, which it reads with Read:
 *
 *   1. "ats-api"    fetch-jd.mjs, run as a plain Node child (no agent CLI, no
 *                   model, no sandbox). An answer also means the posting is
 *                   still listed, so it doubles as a liveness check.
 *   2. "scan-store" the description the scanner already saved for this url
 *                   (lib/jd-store.mjs: jds/feeder/*.json via data/jd-index.tsv).
 *                   This is how LinkedIn postings, which have no public API,
 *                   get read. It says nothing about whether the posting is
 *                   still open.
 *
 * A miss on both is not an error: the worker falls back to WebFetch exactly as
 * before.
 *
 * Plain .mjs with the spawn function injected, so it is unit-tested with
 * `node --test` and no real network.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** fetch-jd.mjs has its own 15s request timeout; this bounds a hung child. */
export const PREFETCH_TIMEOUT_MS = 25_000;

/** Shorter than this is a title or a stub, not a job description. */
export const MIN_JD_CHARS = 200;

/**
 * @typedef {"ats-api" | "scan-store"} JdSource
 *
 * @param {{spawnFn: Function, execPath: string, codeRoot: string, dataRoot: string, url: string, outDir: string, timeoutMs?: number, readStoredJd?: (url: string) => Promise<object|null>}} args
 *   `readStoredJd` is injected by tests; by default it is lib/jd-store.mjs's
 *   readJdForUrl, loaded from the checkout.
 * @returns {Promise<{ok: true, file: string, chars: number, source: JdSource} | {ok: false}>}
 */
export async function prefetchJd({ spawnFn, execPath, codeRoot, dataRoot, url, outDir, timeoutMs = PREFETCH_TIMEOUT_MS, readStoredJd }) {
  // The url is passed as an argv entry, never through a shell. Refusing anything
  // that is not http(s) also keeps a value such as "--help" from reaching the
  // script as a flag.
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return { ok: false };

  /** @type {JdSource} */
  let source = "ats-api";
  let text = await runFetchJd({ spawnFn, execPath, codeRoot, url, timeoutMs });
  if (text.length < MIN_JD_CHARS) {
    source = "scan-store";
    const read = readStoredJd ?? ((u) => defaultReadStoredJd(u, { codeRoot, dataRoot }));
    text = storedJdText(await Promise.resolve().then(() => read(url)).catch(() => null));
  }
  if (text.length < MIN_JD_CHARS) return { ok: false };

  try {
    fs.mkdirSync(outDir, { recursive: true });
    const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
    const file = path.join(outDir, `jd-${hash}.md`);
    fs.writeFileSync(file, text + "\n");
    return { ok: true, file, chars: text.length, source };
  } catch {
    return { ok: false };
  }
}

/**
 * The scanner's job object as JD text: title, company and location as a header
 * (the description alone often omits them), then the description verbatim.
 *
 * @param {any} job
 * @returns {string} "" when the object has no description.
 */
export function storedJdText(job) {
  const description = typeof job?.description === "string" ? job.description.trim() : "";
  if (!description) return "";
  const header = [
    job.title && String(job.title).trim(),
    job.company && `Company: ${String(job.company).trim()}`,
    job.location && `Location: ${String(job.location).trim()}`,
    job.workplace && `Work model: ${String(job.workplace).trim()}`,
  ].filter(Boolean).join("\n");
  return (header ? `${header}\n\n` : "") + description;
}

/** lib/jd-store.mjs lives in the checkout, outside the web bundle. */
async function defaultReadStoredJd(url, { codeRoot, dataRoot }) {
  if (!dataRoot) return null;
  const file = path.join(path.resolve(codeRoot), "lib", "jd-store.mjs");
  const mod = await import(/* webpackIgnore: true */ pathToFileURL(file).href);
  return mod.readJdForUrl(url, { dataRoot });
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
