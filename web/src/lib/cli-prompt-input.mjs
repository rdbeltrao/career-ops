// JUDGMENT: leave room for flags and environment on Windows/macOS, and stay
// below Linux's per-argument ceiling. Large Context never belongs in argv.
export const MAX_INLINE_PROMPT_BYTES = 16 * 1024;

/**
 * EVIDENCE: Codex exec --help documents '-' for stdin; Claude's CLI reference
 * documents piped print mode; Gemini --help says stdin is appended to -p.
 * https://code.claude.com/docs/en/cli-reference
 * https://geminicli.com/docs/cli/headless/
 * OpenCode resolves its message from piped stdin when no message is supplied:
 * https://github.com/anomalyco/opencode/blob/ceb4890/packages/opencode/src/cli/cmd/run.ts
 * Pi prepends piped stdin to its first prompt:
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md
 *
 * @param {string} cliId
 * @param {string[]} args
 * @param {string} [prompt]
 * @returns {{args:string[],stdin:string|null}}
 */
export function preparePromptInput(cliId, args, prompt) {
  if (typeof prompt !== "string" || Buffer.byteLength(prompt) <= MAX_INLINE_PROMPT_BYTES) return { args, stdin: null };
  const positions = args.flatMap((arg, index) => arg === prompt ? [index] : []);
  if (positions.length !== 1) throw new Error("The AI prompt must occur exactly once in its command arguments.");
  const next = [...args];
  const index = positions[0];
  if (cliId === "codex") next[index] = "-";
  else if (cliId === "gemini") next[index] = "Follow the complete request supplied on stdin.";
  else if (["claude", "opencode", "pi"].includes(cliId)) next.splice(index, 1);
  else throw new Error("This Context is too large for this AI CLI's input adapter. Choose Codex, Claude, Gemini, OpenCode or Pi.");
  return { args: next, stdin: prompt };
}
