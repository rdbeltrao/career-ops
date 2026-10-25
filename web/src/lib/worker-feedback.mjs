/** @typedef {{ id: string, title: string, subtitle?: string, status: string }} Worker */

/** @param {Pick<Worker, 'title' | 'subtitle'>} job */
export function workerIdentity(job) {
  return [job.title, job.subtitle].filter(Boolean).join(" · ");
}

/**
 * A run that stopped at a confirmation gate (report-persist.mjs →
 * evaluateRunOutcome) ends as an error whose last status asks the user a
 * question. It did nothing wrong; it is waiting on them.
 * @param {{status: string, steps?: {label?: string}[]}} job
 */
export function needsAnswer(job) {
  if (job?.status !== "error") return false;
  const last = job.steps?.[job.steps.length - 1]?.label;
  return typeof last === "string" && last.startsWith("Needs your answer");
}

/** @param {string} status @param {boolean} [waiting] from needsAnswer() */
export function workerState(status, waiting = false) {
  if (status === "error" && waiting) return "Needs answer";
  return status === "done" ? "Completed" : status === "error" ? "Failed" : "Running";
}

/** Stable during timer/tool updates; includes the visible task identity. @param {Worker} job */
export function workerDetailsLabel(job) {
  return `Open worker: ${workerIdentity(job)} — ${workerState(job.status, needsAnswer(job))}`;
}

/** @param {Worker[]} jobs @param {number} total */
export function workerBatchSummary(jobs, total = jobs.length) {
  const counts = [
    ["running", jobs.filter((j) => j.status === "running").length],
    ["completed", jobs.filter((j) => j.status === "done").length],
    ["failed", jobs.filter((j) => j.status === "error").length],
    ["unavailable", Math.max(0, total - jobs.length)],
  ];
  return counts.filter(([, count]) => count).map(([state, count]) => `${count} ${state}`).join(", ");
}

/**
 * One owner per provider, fed ONLY by live terminal events (never by rendering or
 * history restoration). A fixed window coalesces concurrent completions without
 * postponing feedback indefinitely when more workers keep finishing.
 * @param {(message: string) => void} publish
 * @param {{ schedule?: typeof setTimeout, cancel?: typeof clearTimeout, delay?: number }} options
 */
export function createWorkerFeedback(publish, { schedule = setTimeout, cancel = clearTimeout, delay = 500 } = {}) {
  const seen = new Set();
  /** @type {Worker[]} */
  let pending = [];
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let disposed = false;
  return {
    /** @param {Worker} job */
    push(job) {
      if (disposed || !["done", "error"].includes(job.status)) return;
      const key = `${job.id}:${job.status}`;
      if (seen.has(key)) return;
      seen.add(key);
      pending.push(job);
      if (timer !== undefined) return;
      // Leave an empty interval even when two different tasks share a title and
      // outcome, so the second event can create a fresh live-region mutation.
      publish("");
      timer = schedule(() => {
        const batch = pending;
        pending = [];
        timer = undefined;
        publish(batch.length <= 3
          ? batch.map((j) => `${workerIdentity(j)}: ${workerState(j.status).toLowerCase()}.`).join(" ")
          : `${batch.length} workers: ${workerBatchSummary(batch)}. Open Worker history for details.`);
      }, delay);
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) cancel(timer);
      timer = undefined;
      pending = [];
      seen.clear();
    },
  };
}
