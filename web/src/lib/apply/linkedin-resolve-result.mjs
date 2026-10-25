/**
 * linkedin-resolve-result.mjs - read linkedin-apply.mjs's exit code and output
 * into what the web Apply button shows.
 *
 * Plain .mjs with no imports so `node --test` can load it. The CLI's exit codes
 * (see its header): 0 read, 1 nothing found or browser failure, 2 usage, 3
 * LinkedIn asked for a login.
 */

/** The last stderr line a person can read: no stack frames, no Node banner, no usage text. */
function reason(stderr) {
  const lines = String(stderr ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s/.test(l) && !/^Node\.js v/.test(l) && !/^(Usage|Exit codes|node linkedin-apply)/.test(l));
  return lines.find((l) => l.startsWith("linkedin-apply:")) ?? lines.at(-1) ?? "";
}

/**
 * @param {{ code: number, stdout: string, stderr: string, timedOut: boolean, spawnFailed: boolean }} r
 * @returns {{ ok: true, entry: { id: string, linkedinUrl: string, applyUrl: string, kind: string, checkedAt: string } }
 *   | { ok: false, status: number, error: string, loginRequired?: boolean }}
 */
export function interpretResolve(r) {
  if (r.timedOut) return { ok: false, status: 504, error: "LinkedIn took too long to answer. Try again in a moment." };
  if (r.spawnFailed || /Cannot find module/.test(r.stderr ?? "")) {
    return { ok: false, status: 501, error: "This career-ops checkout has no linkedin-apply.mjs, so the employer form cannot be looked up." };
  }
  if (r.code === 3) {
    return { ok: false, status: 409, loginRequired: true, error: 'LinkedIn asked for a login in the crawl profile. Run "node linkedin-login.mjs", then try again.' };
  }
  if (r.code === 2) return { ok: false, status: 400, error: "career-ops does not recognise that as a LinkedIn posting URL." };
  let parsed = null;
  try {
    parsed = JSON.parse(String(r.stdout ?? "").trim().split("\n").filter(Boolean).at(-1) ?? "");
  } catch {
    parsed = null;
  }
  if (r.code === 0 && parsed && (parsed.applyUrl || parsed.kind)) return { ok: true, entry: parsed };
  return { ok: false, status: 404, error: (reason(r.stderr) || "No apply method was found on that posting.").slice(0, 300) };
}
