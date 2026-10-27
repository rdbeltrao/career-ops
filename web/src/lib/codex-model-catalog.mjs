import { spawn } from "node:child_process";
import { prepareCliLaunch } from "./cli-launch.mjs";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_PAGES = 5;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]()-]{0,255}$/;
const LOAD_WARNING = "Could not load models from the installed Codex CLI. Use CLI default or check Codex sign-in/version, then refresh Config.";
const CUSTOM_WARNING = "This provider manages its own models. Use CLI default or enter a custom model ID configured for that provider.";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * EVIDENCE: model/list returns the installed client's account-specific catalog;
 * global desktop caches and documentation examples can describe different clients.
 * https://learn.chatgpt.com/docs/app-server#list-models-model-list
 * This connection only initializes and lists metadata; it never starts inference.
 * @param {{binPath:string,env?:NodeJS.ProcessEnv,cwd?:string,provider?:string,spawnFn?:typeof spawn,timeoutMs?:number}} options
 * @returns {Promise<{models:{id:string,label:string,isDefault:boolean}[],warning:string|null}>}
 */
export async function discoverCodexModels({ binPath, env = process.env, cwd = process.cwd(), provider = "", spawnFn = spawn, timeoutMs = 5000 }) {
  if (provider !== "" && provider !== "openai") return { models: [], warning: CUSTOM_WARNING };
  return new Promise((resolve) => {
    let child;
    let finished = false;
    let buffer = "";
    let bytes = 0;
    let expectedId = 1;
    let pages = 0;
    let killTimer;
    const models = new Map();
    const cursors = new Set();
    const timer = setTimeout(() => finish(), Math.max(1, Math.min(timeoutMs, 30_000)));

    function cleanup() {
      clearTimeout(killTimer);
      child?.stdout?.off("data", onData);
      child?.stdout?.off("error", onError);
      child?.stderr?.off("data", discard);
      child?.stderr?.off("error", discard);
      child?.stdin?.off("error", onError);
      child?.off("error", onError);
      child?.off("close", onClose);
    }
    function finish(success = false) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child?.stdout?.off("data", onData);
      if (child) {
        // Keep error listeners until close: a final stdin write can produce EPIPE
        // after a catalog response. Closing the probe must not crash the server.
        killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already stopped */ } }, 500);
        killTimer.unref();
        try { child.stdin?.end(); } catch { /* startup or pipe failure */ }
        try { child.kill("SIGTERM"); } catch { /* retain the forced-stop timer */ }
      }
      const available = success ? [...models.values()] : [];
      resolve({ models: available, warning: available.length ? null : LOAD_WARNING });
    }
    function discard() {}
    function onError() { finish(); }
    function onClose() { finish(); cleanup(); }
    function send(message) {
      if (finished) return;
      try { child.stdin.write(JSON.stringify(message) + "\n"); } catch { finish(); }
    }
    function list(cursor) {
      send({ method: "model/list", id: expectedId, params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } });
    }
    function receive(message) {
      if (!object(message) || message.id !== expectedId || message.method) return;
      if (message.error || !object(message.result)) return finish();
      if (expectedId === 1) {
        expectedId = 2;
        send({ method: "initialized", params: {} });
        list();
        return;
      }
      const { data, nextCursor } = message.result;
      if (!Array.isArray(data) || (nextCursor != null && typeof nextCursor !== "string")) return finish();
      for (const entry of data) {
        if (!object(entry) || entry.hidden === true || typeof entry.model !== "string" || !MODEL_ID.test(entry.model) || models.has(entry.model)) continue;
        const label = typeof entry.displayName === "string" ? entry.displayName.trim() : "";
        models.set(entry.model, { id: entry.model, label: label && label.length <= 160 && !/[\u0000-\u001f\u007f]/.test(label) ? label : entry.model, isDefault: entry.isDefault === true });
      }
      pages += 1;
      if (!nextCursor) return finish(true);
      if (pages >= MAX_PAGES || cursors.has(nextCursor) || nextCursor.length > 4096) return finish();
      cursors.add(nextCursor);
      expectedId += 1;
      list(nextCursor);
    }
    function onData(chunk) {
      if (finished) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) return finish();
      buffer += chunk;
      let newline;
      while (!finished && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { return finish(); }
        receive(message);
      }
    }
    try {
      const args = ["app-server", "--stdio", ...(provider === "openai" ? ["-c", 'model_provider="openai"'] : [])];
      const launch = prepareCliLaunch(binPath, args);
      child = spawnFn(launch.command, launch.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", onData);
      child.stdout.on("error", onError);
      child.stderr.on("data", discard);
      child.stderr.on("error", discard);
      child.stdin.on("error", onError);
      child.on("error", onError);
      child.on("close", onClose);
      send({ method: "initialize", id: 1, params: { clientInfo: { name: "career_ops_model_picker", title: "career-ops model picker", version: "0.1.0" } } });
    } catch { finish(); }
  });
}
