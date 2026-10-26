/**
 * Which pending rows need the user, read from the batch runner's state.
 *
 * Pending rows are evaluated in the background (lib/auto-evaluate.mjs runs
 * batch/batch-runner.sh as rows arrive). The batch records every posting it
 * touches in batch/batch-state.tsv; this module turns that status into one of:
 *
 *   evaluating  the batch is working on it now (or filing its report)
 *   queued      the next background run will evaluate it
 *   needs-you   the batch stopped and only the user can move it on
 *   skip        Jev ruled it out; it is never evaluated
 *
 * The inbox lists needs-you rows (and skip rows behind their chip) and counts
 * the rest, so a row being evaluated is never offered to Score a second time.
 */
import { inboxKey } from "./inbox-pending.mjs";

/** batch-runner.sh's MAX_RETRIES default: a failed row past it is not retried. */
export const MAX_RETRIES = 2;

/**
 * @typedef {{ status: string, error: string, retries: number }} BatchRow
 * @typedef {{ stage: "evaluating" | "queued" | "needs-you" | "skip", detail?: string }} BatchStage
 */

/**
 * Parse batch-state.tsv into posting key → latest row.
 * @param {string} tsv
 * @returns {Map<string, BatchRow>}
 */
export function parseBatchState(tsv) {
  const states = new Map();
  for (const line of String(tsv ?? "").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("id\t")) continue;
    const cells = line.split("\t");
    if (cells.length < 9 || !cells[1]) continue;
    const error = cells[7] && cells[7] !== "-" ? cells[7].trim() : "";
    states.set(inboxKey(cells[1]), { status: cells[2].trim(), error, retries: Number.parseInt(cells[8], 10) || 0 });
  }
  return states;
}

/**
 * @param {{ url: string, jev?: { verdict?: string } }} job
 * @param {Map<string, BatchRow>} states
 * @param {{ batchRunning?: boolean, maxRetries?: number }} [options]
 * @returns {BatchStage}
 */
export function batchStageOf(job, states, { batchRunning = false, maxRetries = MAX_RETRIES } = {}) {
  if (job.jev?.verdict === "skip") return { stage: "skip" };
  const row = states.get(inboxKey(job.url));
  if (!row) return { stage: "queued" };
  switch (row.status) {
    case "processing":
      // A row left "processing" by a run that died is picked up by the next run.
      return { stage: batchRunning ? "evaluating" : "queued" };
    case "completed":
      return { stage: "evaluating" };
    case "skipped":
      return { stage: "skip" };
    case "needs_confirmation":
      return { stage: "needs-you", detail: `Needs your answer: ${row.error || "the evaluation stopped at a gate"}` };
    case "failed":
      return row.retries >= maxRetries
        ? { stage: "needs-you", detail: `Evaluation failed: ${row.error || "no reason recorded"}` }
        : { stage: "queued" };
    default:
      return { stage: "queued" };
  }
}

/**
 * @template {{ url: string, jev?: { verdict?: string } }} T
 * @param {T[]} jobs - pending inbox rows
 * @param {Map<string, BatchRow>} states
 * @param {{ batchRunning?: boolean, maxRetries?: number }} [options]
 * @returns {{ listed: (T & { batch: BatchStage })[], needsYou: number, background: { evaluating: number, queued: number } }}
 */
export function splitInbox(jobs, states, options = {}) {
  const listed = [];
  const background = { evaluating: 0, queued: 0 };
  let needsYou = 0;
  for (const job of jobs) {
    const batch = batchStageOf(job, states, options);
    if (batch.stage === "evaluating" || batch.stage === "queued") {
      background[batch.stage] += 1;
      continue;
    }
    if (batch.stage === "needs-you") needsYou += 1;
    listed.push({ ...job, batch });
  }
  return { listed, needsYou, background };
}
