import fs from "node:fs";
import { rootScript } from "@/lib/career-ops";
import { runSetStatus, type CliResult } from "@/lib/core-cli";
import { canonicalizeStatus } from "@/lib/core/states";
import { parseCliJson, clientErrorMessage } from "@/lib/status-cli.mjs";
import { trackerNoteText } from "./apply-gates.mjs";

/**
 * Append a note to a tracker row WITHOUT changing its status, through the one
 * canonical writer: set-status.mjs. It takes the row's current state as the
 * state argument, so the status is a no-op re-run and only `--note` lands; the
 * shared tracker lock, the states.yml validation and the atomic write are the
 * CLI's, exactly as /api/status gets them. `--note=` (the literal form) keeps a
 * note that starts with "--" from being read as a flag.
 *
 * Hand-editing data/applications.md from the web is what #2900 closed; this
 * module exists so the apply flow never reopens it for its two notes
 * (`override: ...` and `cv: ...`, see apply-gates.mjs).
 */
export type TrackerNoteInput = {
  /** Tracker `#` (preferred) or, failing that, the report number the row links. */
  row?: string | null;
  report?: string | null;
  /** The row's current status, canonical or an alias states.yml knows. */
  status: string;
  note: string;
};

export type TrackerNoteResult = { ok: true; changed: boolean; note: string } | { ok: false; error: string; note: string };

/** The argv the CLI is run with; exported so a test can pin it without spawning. */
export function trackerNoteArgs({ row, report, status, note }: TrackerNoteInput): string[] | { error: string } {
  const text = trackerNoteText(note);
  if (!text) return { error: "note is empty" };
  const canon = canonicalizeStatus(status);
  if (!canon) return { error: `the row's status "${status}" is not a canonical state, so the note cannot be appended without changing it` };
  const selector = row && /^\d+$/.test(String(row).trim()) ? ["--row", String(row).trim()] : report && /^\d+$/.test(String(report).trim()) ? ["--report", String(report).trim()] : null;
  if (!selector) return { error: "no tracker row or report number to append the note to" };
  return [...selector, canon, `--note=${text}`, "--source", "web", "--json"];
}

export async function appendTrackerNote(input: TrackerNoteInput, run: (args: string[]) => Promise<CliResult> = runSetStatus): Promise<TrackerNoteResult> {
  const note = trackerNoteText(input.note);
  const args = trackerNoteArgs(input);
  if (!Array.isArray(args)) return { ok: false, error: args.error, note };
  // Same feature-detection /api/status does: a data-only root has no scripts,
  // and spawning anyway only yields a module-resolution stack trace.
  if (!fs.existsSync(rootScript("set-status"))) {
    return { ok: false, error: "tracker notes need the career-ops scripts; this root has data only", note };
  }
  const { code, stdout, stderr, spawnFailed, timedOut } = await run(args);
  if (spawnFailed) return { ok: false, error: "set-status.mjs failed to run", note };
  if (timedOut) return { ok: false, error: "set-status.mjs timed out; the note may or may not have been written", note };
  const parsed = parseCliJson(stdout);
  if (code !== 0) return { ok: false, error: clientErrorMessage(parsed, stderr) || `set-status.mjs exited ${code}`, note };
  return { ok: true, changed: parsed?.changed === true, note };
}
