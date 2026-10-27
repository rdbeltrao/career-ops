/** @typedef {{provider:string, model:string}} AiSelection */
/** @typedef {{version:1, cliId:string, models:Record<string, AiSelection>}} AiSettings */

export const AI_CLI_IDS = Object.freeze(["claude", "codex", "gemini", "opencode", "pi", "copilot", "qwen", "antigravity", "grok", "hermes"]);
/** @type {AiSettings} */
export const EMPTY_AI_SETTINGS = Object.freeze({ version: 1, cliId: "", models: Object.freeze({}) });

const MODEL_CLIS = new Set(["claude", "codex", "gemini", "opencode"]);
const PROVIDER_CLIS = new Set(["codex", "opencode"]);
const defaultProvider = { id: "", label: "Use the tool's configured provider" };
const defaultModel = { id: "", label: "Use the tool's default model" };
const options = (ids) => ids.map((id) => ({ id, label: id }));

/** Suggestions are not an account-access guarantee; custom model IDs remain accepted. */
export function aiOptionsFor(cliId) {
  return {
    supportsModel: MODEL_CLIS.has(cliId),
    supportsProvider: PROVIDER_CLIS.has(cliId),
    providers: [defaultProvider, ...options(cliId === "codex" ? ["openai", "ollama", "lmstudio"] : cliId === "opencode" ? ["anthropic", "openai", "google", "openrouter", "opencode", "ollama"] : [])],
    // EVIDENCE: Codex model/list depends on the installed client and account.
    // Its picker is populated by /api/ai-models, never a generic model catalog.
    // https://learn.chatgpt.com/docs/app-server#list-models-model-list
    models: [defaultModel, ...options(cliId === "claude" ? ["sonnet", "opus", "haiku", "fable"] : [])],
  };
}

function invalid(message) { throw new Error(`Invalid AI settings: ${message}`); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys, label) {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid(`${label} must contain only ${keys.join(", ")}.`);
}

function selectionFor(cliId, value) {
  exactKeys(value, ["provider", "model"], `Model selection for ${cliId}`);
  const { provider, model } = value;
  if (typeof provider !== "string" || provider.length > 80 || (provider && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider))) invalid(`Provider for ${cliId} must be a valid provider ID (at most 80 characters).`);
  if (typeof model !== "string" || model.length > 256 || (model && !/^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]()-]*$/.test(model))) invalid(`Model for ${cliId} must be a valid model ID (at most 256 characters, without whitespace or leading dashes).`);
  if (provider && !PROVIDER_CLIS.has(cliId)) invalid(`${cliId} uses the provider configured in its own tool.`);
  if (model && !MODEL_CLIS.has(cliId)) invalid(`Model overrides are not supported for ${cliId}; leave the model empty to use its own settings.`);
  if (cliId === "opencode" && provider && !model) invalid("Choose a model when selecting an OpenCode provider.");
  if (cliId === "opencode" && !provider && model && !model.includes("/")) invalid("OpenCode models need provider/model format when no provider is selected.");
  return { provider, model };
}

/** @param {unknown} value @returns {AiSettings} */
export function normalizeAiSettings(value) {
  if (value === undefined) return { version: 1, cliId: "", models: {} };
  exactKeys(value, ["version", "cliId", "models"], "Settings");
  if (value.version !== 1) invalid("Unsupported settings version.");
  if (typeof value.cliId !== "string" || (value.cliId !== "" && !AI_CLI_IDS.includes(value.cliId))) invalid("Choose a supported AI tool.");
  if (!record(value.models)) invalid("Models must be an object keyed by AI tool.");
  const models = {};
  for (const [cliId, selection] of Object.entries(value.models)) {
    if (!AI_CLI_IDS.includes(cliId)) invalid(`Unknown AI tool '${cliId}'.`);
    models[cliId] = selectionFor(cliId, selection);
  }
  return { version: 1, cliId: value.cliId, models };
}

// These option values may themselves equal "--model"; they are data, not flags.
const VALUE_OPTIONS = new Set(["-p", "--prompt", "--system-prompt", "--system-prompt-file", "--append-system-prompt", "--append-system-prompt-file", "--allowedTools", "--disallowedTools", "--tools", "--output-format", "--input-format", "--permission-mode", "--settings", "--session-id", "--resume", "--agent", "--agents", "--mcp-config", "--json-schema", "--output-schema", "--sandbox", "-s", "--profile", "--color", "--output-last-message", "-o", "--cd", "-C", "--add-dir", "--dir", "--format", "--title", "--variant"]);

function withoutOverrides(args, { model, provider }, cliId) {
  const kept = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") { kept.push(...args.slice(i)); break; }
    if (model && (arg === "--model" || arg === "-m")) { i += 1; continue; }
    if (model && arg.startsWith("--model=")) continue;
    if (cliId === "codex" && provider) {
      if (arg === "--oss") continue;
      if (arg === "--local-provider") { i += 1; continue; }
      if (arg.startsWith("--local-provider=")) continue;
      if (arg === "-c" || arg === "--config") {
        const next = args[++i];
        if (!/^model_provider\s*=/.test(next ?? "")) kept.push(arg, next);
        continue;
      }
      if (/^--config=model_provider\s*=/.test(arg)) continue;
    }
    kept.push(arg);
    if ((VALUE_OPTIONS.has(arg) || arg === "-c" || arg === "--config") && i + 1 < args.length) kept.push(args[++i]);
  }
  return kept;
}

/**
 * Apply only career-ops overrides; never change the user's global tool config.
 * @param {string} cliId @param {string[]} args @param {AiSelection | undefined} selection
 * @returns {string[]}
 */
export function applyAiModelArgs(cliId, args, selection) {
  if (!AI_CLI_IDS.includes(cliId)) invalid(`Unknown AI tool '${cliId}'.`);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) invalid("CLI arguments must be strings.");
  const selected = selectionFor(cliId, selection ?? { provider: "", model: "" });
  if (!selected.provider && !selected.model) return [...args];
  const clean = withoutOverrides(args, selected, cliId);
  // EVIDENCE: Claude/Gemini --model and OpenCode provider/model are invocation-only overrides.
  // https://code.claude.com/docs/en/model-config ; https://opencode.ai/docs/cli/
  const model = cliId === "opencode" && selected.provider ? `${selected.provider}/${selected.model}` : selected.model;
  const flags = model ? ["--model", model] : [];
  if (cliId === "codex" && selected.provider) {
    // EVIDENCE: https://developers.openai.com/codex/cli/reference documents local providers and -c overrides.
    if (["ollama", "lmstudio"].includes(selected.provider)) flags.push("--oss", "--local-provider", selected.provider);
    else flags.push("-c", `model_provider=${JSON.stringify(selected.provider)}`);
  }
  if (cliId === "codex" || cliId === "opencode") {
    const command = cliId === "codex" ? "exec" : "run";
    const index = clean.indexOf(command);
    if (index === -1) invalid(`${cliId} arguments must contain the '${command}' subcommand.`);
    return [...clean.slice(0, index + 1), ...flags, ...clean.slice(index + 1)];
  }
  return [...flags, ...clean];
}
