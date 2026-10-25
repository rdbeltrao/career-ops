import { pathToFileURL } from "node:url";
import { rootScript } from "@/lib/career-ops";
import { fallbackIsJobBoard } from "./apply-target.mjs";

/**
 * The core's job-board predicate (url-key.mjs isAggregatorUrl), so the Apply
 * button and the tracker dedup agree on which hosts are boards. Loaded at
 * runtime because the core checkout is chosen at runtime and is not bundled, the
 * same way the Apply checklist page loads application-answers.mjs. A core too
 * old to export it gets the built-in fallback list.
 */
export async function loadIsJobBoard(): Promise<(url: string) => boolean> {
  try {
    const mod = await import(/* webpackIgnore: true */ pathToFileURL(rootScript("url-key")).href);
    if (typeof mod.isAggregatorUrl === "function") return mod.isAggregatorUrl as (url: string) => boolean;
  } catch {
    /* core missing or older than isAggregatorUrl → fallback */
  }
  return fallbackIsJobBoard;
}
