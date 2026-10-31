import { spawn } from "node:child_process";

/** Give scanners time to save a partial receipt, then bound even a stuck shutdown. */
export function runScheduledScanner(command, args, { timeout, maxBuffer, graceMs = 15_000, ...options }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0;
    let error;
    let hardKiller;
    const stop = (cause) => {
      if (error) return;
      error = cause;
      child.kill("SIGTERM");
      hardKiller = setTimeout(() => child.kill("SIGKILL"), graceMs);
    };
    const timer = setTimeout(() => stop(Object.assign(new Error("Scanner deadline reached"), { code: "ETIMEDOUT" })), timeout);
    for (const stream of ["stdout", "stderr"]) {
      child[stream].on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBuffer) {
          stop(Object.assign(new Error("Scanner output exceeded its buffer limit"), { code: "ENOBUFS" }));
          return;
        }
        chunks[stream].push(chunk);
      });
    }
    child.on("error", (cause) => { error ||= cause; });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      clearTimeout(hardKiller);
      resolve({ status, signal, error, stdout: Buffer.concat(chunks.stdout).toString("utf8"), stderr: Buffer.concat(chunks.stderr).toString("utf8") });
    });
  });
}
