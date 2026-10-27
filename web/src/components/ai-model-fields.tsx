"use client";

import { useState } from "react";
import { aiOptionsFor } from "@/lib/ai-settings.mjs";

export type AiModelSelection = { provider: string; model: string };

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
  const models = options.models.filter((option: { id: string }) => option.id !== "");
  // JUDGMENT: retain an explicit custom-edit state even while its input is empty,
  // rather than snapping the select back to its inherited default after a keystroke.
  const [customProvider, setCustomProvider] = useState(Boolean(selection.provider && !providers.some((option: { id: string }) => option.id === selection.provider)));
  const [customModel, setCustomModel] = useState(Boolean(selection.model && !models.some((option: { id: string }) => option.id === selection.model)));

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
            onChange({ ...selection, provider: provider === CUSTOM ? "" : provider });
          }}
        >
          <option value="">{options.providers.find((option: { id: string }) => option.id === "")?.label || "Use CLI default"}</option>
          {providers.map((option: { id: string; label: string }) => <option key={option.id} value={option.id}>{option.label}</option>)}
          {options.supportsProvider && <option value={CUSTOM}>Custom provider</option>}
        </select>
        {customProvider && (
          <div className="mt-2">
            <label htmlFor="ai-custom-provider" className="mb-1 block text-xs text-muted">Custom provider ID</label>
            <input id="ai-custom-provider" className={inputClass} value={selection.provider} maxLength={80} autoComplete="off" placeholder="Provider ID configured in your AI tool" onChange={(event) => onChange({ ...selection, provider: event.target.value })} />
          </div>
        )}
        <p className="mt-1.5 text-xs text-faint">{options.supportsProvider ? "The provider must already be configured in your AI tool." : "Provider and authentication come from this tool’s existing configuration."}</p>
      </div>
      <div>
        <label htmlFor="ai-model" className="mb-1.5 block text-sm font-medium text-foreground">Model</label>
        <select
          id="ai-model"
          className={inputClass}
          value={customModel ? CUSTOM : selection.model}
          onChange={(event) => {
            const model = event.target.value;
            setCustomModel(model === CUSTOM);
            onChange({ ...selection, model: model === CUSTOM ? "" : model });
          }}
        >
          <option value="">Use CLI default</option>
          {models.map((option: { id: string; label: string }) => <option key={option.id} value={option.id}>{option.label}</option>)}
          <option value={CUSTOM}>Custom model</option>
        </select>
        {customModel && (
          <div className="mt-2">
            <label htmlFor="ai-custom-model" className="mb-1 block text-xs text-muted">Custom model ID</label>
            <input id="ai-custom-model" className={inputClass} value={selection.model} maxLength={200} autoComplete="off" placeholder={cliId === "opencode" && !selection.provider ? "provider/model" : "Exact model ID or alias"} onChange={(event) => onChange({ ...selection, model: event.target.value })} />
          </div>
        )}
        <p className="mt-1.5 text-xs text-faint">Choose a model your account can access. Use CLI default inherits this tool’s saved model.</p>
        {needsModel && <p role="alert" className="mt-2 text-xs text-red-300">Choose a model when selecting an OpenCode provider.</p>}
      </div>
    </fieldset>
  );
}
