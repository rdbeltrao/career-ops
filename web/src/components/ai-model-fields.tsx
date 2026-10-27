"use client";

import { useEffect, useState } from "react";
import { aiOptionsFor } from "@/lib/ai-settings.mjs";

export type AiModelSelection = { provider: string; model: string };
type ModelOption = { id: string; label: string; isDefault?: boolean };

const CUSTOM = "__custom__";
const inputClass = "w-full rounded-xl border border-border bg-surface/60 px-3 py-2.5 text-sm text-foreground outline-none focus:border-brand/50 disabled:opacity-60";

export function AiModelFields({ cliId, selection, disabled, onChange }: {
  cliId: string;
  selection: AiModelSelection;
  disabled: boolean;
  onChange: (selection: AiModelSelection) => void;
}) {
  const options = aiOptionsFor(cliId);
  const providers = options.providers.filter((option: { id: string }) => option.id !== "");
  const [catalog, setCatalog] = useState<ModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(cliId === "codex");
  const [catalogWarning, setCatalogWarning] = useState("");
  const [refresh, setRefresh] = useState(0);
  const models: ModelOption[] = cliId === "codex" ? catalog : options.models.filter((option: { id: string }) => option.id !== "");
  // JUDGMENT: retain an explicit custom-edit state even while its input is empty,
  // rather than snapping the select back to its inherited default after a keystroke.
  const [customProvider, setCustomProvider] = useState(Boolean(selection.provider && !providers.some((option: { id: string }) => option.id === selection.provider)));
  const [customModel, setCustomModel] = useState(false);
  const showCustomModel = customModel || Boolean(selection.model && !models.some((option) => option.id === selection.model));

  useEffect(() => {
    if (cliId !== "codex") return;
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    setCatalog([]);
    setLoadingModels(true);
    setCatalogWarning("");
    const query = new URLSearchParams({ cliId, provider: selection.provider });
    // EVIDENCE: model/list reflects this installed client's account, unlike a
    // global models cache shared with a different version of the desktop app.
    fetch(`/api/ai-models?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.models) || data.models.some((model: ModelOption) => !model || typeof model.id !== "string" || typeof model.label !== "string")) {
          throw new Error("Could not load models from the installed Codex CLI. Use CLI default or check Codex sign-in and version.");
        }
        if (active) {
          setCatalog(data.models);
          setCatalogWarning(typeof data.warning === "string" ? data.warning : "");
        }
      })
      .catch(() => {
        if (active) setCatalogWarning("Could not load models from the installed Codex CLI. Use CLI default or check Codex sign-in and version.");
      })
      .finally(() => { clearTimeout(timeout); if (active) setLoadingModels(false); });
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [cliId, selection.provider, refresh]);

  if (!options.supportsModel) {
    return <p className="mt-5 text-sm text-muted">This tool uses its own provider and model settings. Model overrides are not available for this tool yet.</p>;
  }

  const needsModel = cliId === "opencode" && selection.provider !== "" && selection.model === "";

  return (
    <fieldset disabled={disabled} className="mt-6 space-y-4 rounded-xl border border-border bg-surface/30 p-4">
      <legend className="px-1 text-sm font-medium text-foreground">Provider and model</legend>
      <div>
        <label htmlFor="ai-provider" className="mb-1.5 block text-sm font-medium text-foreground">Provider</label>
        <select
          id="ai-provider"
          disabled={!options.supportsProvider}
          className={inputClass}
          value={customProvider ? CUSTOM : selection.provider}
          onChange={(event) => {
            const provider = event.target.value;
            setCustomProvider(provider === CUSTOM);
            setCustomModel(false);
            onChange({ provider: provider === CUSTOM ? "" : provider, model: "" });
          }}
        >
          <option value="">{options.providers.find((option: { id: string }) => option.id === "")?.label || "Use CLI default"}</option>
          {providers.map((option: { id: string; label: string }) => <option key={option.id} value={option.id}>{option.label}</option>)}
          {options.supportsProvider && <option value={CUSTOM}>Custom provider</option>}
        </select>
        {customProvider && (
          <div className="mt-2">
            <label htmlFor="ai-custom-provider" className="mb-1 block text-xs text-muted">Custom provider ID</label>
            <input id="ai-custom-provider" className={inputClass} value={selection.provider} maxLength={80} autoComplete="off" placeholder="Provider ID configured in your AI tool" onChange={(event) => onChange({ provider: event.target.value, model: "" })} />
          </div>
        )}
        <p className="mt-1.5 text-xs text-faint">{options.supportsProvider ? "The provider must already be configured in your AI tool." : "Provider and authentication come from this tool’s existing configuration."}</p>
      </div>
      <div>
        <label htmlFor="ai-model" className="mb-1.5 block text-sm font-medium text-foreground">Model</label>
        <select
          id="ai-model"
          className={inputClass}
          value={showCustomModel ? CUSTOM : selection.model}
          onChange={(event) => {
            const model = event.target.value;
            setCustomModel(model === CUSTOM);
            onChange({ ...selection, model: model === CUSTOM ? "" : model });
          }}
        >
          <option value="">Use CLI default</option>
          {models.map((option) => <option key={option.id} value={option.id}>{option.label}{option.isDefault ? " (recommended by CLI)" : ""}</option>)}
          <option value={CUSTOM}>Custom model</option>
        </select>
        {showCustomModel && (
          <div className="mt-2">
            <label htmlFor="ai-custom-model" className="mb-1 block text-xs text-muted">Custom model ID</label>
            <input id="ai-custom-model" className={inputClass} value={selection.model} maxLength={200} autoComplete="off" placeholder={cliId === "opencode" && !selection.provider ? "provider/model" : "Exact model ID or alias"} onChange={(event) => onChange({ ...selection, model: event.target.value })} />
          </div>
        )}
        <p className="mt-1.5 text-xs text-faint">Choose a model your account can access. Use CLI default inherits this tool’s saved model.</p>
        {cliId === "codex" && (
          <div className="mt-2 space-y-2">
            <p role="status" className="text-xs text-faint">{loadingModels ? "Loading models from your installed Codex CLI…" : catalogWarning || "Models reported by your installed Codex CLI for its current account."}</p>
            <button type="button" disabled={disabled || loadingModels} onClick={() => setRefresh((value) => value + 1)} className="text-xs text-brand underline disabled:opacity-50">Refresh models</button>
            {!loadingModels && !catalogWarning && selection.model && !catalog.some((model) => model.id === selection.model) && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">This model is not listed by your Codex CLI. Choose a listed model or verify access to this custom ID before running.</p>}
          </div>
        )}
        {needsModel && <p role="alert" className="mt-2 text-xs text-red-300">Choose a model when selecting an OpenCode provider.</p>}
      </div>
    </fieldset>
  );
}
