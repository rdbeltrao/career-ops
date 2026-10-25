import { spawn } from "node:child_process";
import { fenceArgs } from "./cli-fencing.mjs";
import { prepareCliLaunch } from "./cli-launch.mjs";
import { preparePromptInput } from "./cli-prompt-input.mjs";

// Plain .mjs (same pattern as tracker-table.mjs/clean-chips.mjs) so
// tests/lib/spawn-cli.test.mjs can import it directly under Node. Import it with the
// .mjs extension included (e.g. "@/lib/spawn-cli.mjs") — unlike .ts files,
// which TypeScript resolves without an extension, ESM specifiers for plain
// JS modules must be fully specified.

/**
 * Spawn a headless agent CLI with stdin delivered and closed, under the worker's permissions.
 *
 * CLIs such as `codex exec` read additional prompt text from stdin when a pipe
 * is left open. Close it immediately after delivering a large prompt, or with
 * no input for an ordinary argv prompt, so Codex never waits on an open pipe. This is
 * the ONLY spawn path for CLI-invoking routes — every call site should use it
 * instead of `node:child_process`'s `spawn` directly, so the fix can't drift.
 *
 * It also replaces the `stdio: ["ignore", ...]` the apply planners used to spell
 * for the same reason — one mechanism means one place for this to be right.
 * The options type omits `stdio` on purpose: stdout/stderr must stay pipes for
 * every caller's stream handlers, and TypeScript keeps `child.stdout` non-null
 * only under that contract. `stdin` is still optional-chained so an untyped
 * caller passing `stdio` anyway degrades safely (null stdin) instead of throwing.
 *
 * `fencing` is REQUIRED, and that is the point (#2507). Permission used to be
 * applied per route, so it reached only the one route that remembered — every
 * other CLI ran unrestricted. Demanding it here means a new route cannot spawn an
 * unfenced agent by omission: it does not compile. Declare what the worker needs
 * (worker-capabilities.mjs) and this translates it for whichever runtime the user
 * picked (cli-fencing.mjs); a runtime with no verified mechanism is passed
 * through untouched, and fencingReport() grades the run so the UI can say so
 * rather than pretending.
 *
 * The one thing that legitimately spawns a CLI without coming through here is
 * cli-fencing-probe.mjs, which runs `--help` to ask whether the binary supports
 * the flags it would be fenced with. That executes no prompt, no model and no
 * tools, so there is nothing to fence — and it cannot import this module anyway
 * without making the two a cycle.
 *
 * @param {string} binPath
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptionsWithoutStdio} options
 * @param {{cliId: string, capabilities: import("./worker-capabilities.mjs").Capabilities}} fencing
 * @param {{prompt?:string}} [input] The complete prompt, when the caller supports large Context.
 */
export function spawnHeadlessCli(binPath, args, options, fencing, input = {}) {
  // Fail fast rather than spawn unfenced. Omitting `fencing` used to spread
  // `undefined` into nothing, leaving cliId undefined — which matches no fencer,
  // so the raw argv was spawned with no error at all. The docstring's "it does
  // not compile" holds only for the .ts call sites: `checkJs` is off, so a .mjs
  // caller gets no signal from tsc. A silently unrestricted agent is precisely
  // the outcome this parameter exists to prevent, so refuse to start.
  if (!fencing?.cliId || !fencing?.capabilities) {
    throw new Error(
      `spawnHeadlessCli: refusing to spawn ${binPath} without {cliId, capabilities}. ` +
        "Declare what the worker needs (worker-capabilities.mjs) so its permissions can be applied.",
    );
  }
  const transport = preparePromptInput(fencing.cliId, args, input.prompt);
  const { args: fencedArgs } = fenceArgs({ ...fencing, args: transport.args });
  // On Windows an npm-installed CLI is a script shim spawn() cannot run without a
  // shell, so launch the .js/.exe it wraps (a no-op elsewhere; cli-launch.mjs).
  // After fencing, so the fencers see the CLI's own argv rather than node's.
  const launch = prepareCliLaunch(binPath, fencedArgs);
  // windowsHide: on Windows a child attaches to the parent's console. A
  // long-lived dev server whose console has gone stale then kills EVERY child
  // at DLL init with 0xC0000142 (STATUS_DLL_INIT_FAILED), in ~20 ms and with no
  // output at all; the same spawn with windowsHide (CREATE_NO_WINDOW) succeeds.
  // Nothing spawned here needs a console, so never inherit one. Set after the
  // caller's options so no caller can opt back in. No-op on POSIX (#3809).
  const child = spawn(launch.command, launch.args, { ...options, ...(transport.stdin !== null ? { stdio: /** @type {const} */ (["pipe", "pipe", "pipe"]) } : {}), windowsHide: true });
  if (transport.stdin !== null && child.stdin) {
    // A CLI may exit before reading a large request. Surface the failed input
    // through the caller's existing child error handler instead of crashing
    // the server on an unhandled EPIPE or accepting a partial Context.
    child.stdin.once("error", () => {
      child.kill();
      child.emit("error", new Error("The AI CLI closed its input before the complete Context was delivered."));
    });
    child.stdin.end(transport.stdin);
  } else child.stdin?.end();
  return child;
}
