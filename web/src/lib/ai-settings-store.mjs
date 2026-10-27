import fs from "node:fs";
import path from "node:path";
import { normalizeAiSettings } from "./ai-settings.mjs";
import { resolveCodeRoot } from "./core/code-root.mjs";
import { resolveDataRoot } from "./core/data-root.mjs";

export class AiSettingsError extends Error {
  constructor(message, status = 500) { super(message); this.name = "AiSettingsError"; this.status = status; }
}

function settingsPath(root) { return path.join(/* turbopackIgnore: true */ root, "data", "ai-settings.json"); }

/** Only a missing file means defaults; malformed saved settings must stop the run. */
export function readAiSettings(root) {
  const file = settingsPath(root);
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return normalizeAiSettings(undefined);
    throw new AiSettingsError(`Cannot read AI settings at ${file}. Check file permissions and try again.`);
  }
  try { return normalizeAiSettings(JSON.parse(text)); }
  catch { throw new AiSettingsError(`AI settings at ${file} are invalid. Repair data/ai-settings.json before saving or running an AI task.`, 409); }
}

/**
 * The route supplies the shared atomic writer, keeping persistence inside the user layer.
 * @param {string} root @param {unknown} input @param {(file:string,text:string)=>unknown} write
 */
export function saveAiSettings(root, input, write) {
  let settings;
  try { settings = normalizeAiSettings(input); }
  catch (error) { throw new AiSettingsError(error.message, 400); }
  readAiSettings(root);
  write(settingsPath(root), `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}

/** Resolve exactly the same code/data-root split as the web app before every worker. */
export function readWorkerAiSettings({ cwd = process.cwd(), env = process.env } = {}) {
  const codeRoot = resolveCodeRoot(cwd, env);
  const readMarker = (file) => {
    try { return fs.readFileSync(file, "utf8"); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      throw new AiSettingsError(`Cannot read the career-ops data-root marker at ${file}.`);
    }
  };
  // EVIDENCE: reuse the existing parity-tested resolver rather than resolving paths from worker cwd.
  const root = resolveDataRoot(codeRoot, readMarker, env, path.resolve, path.join);
  return readAiSettings(root);
}
