/**
 * Inbox Jev verdict facets (fork). The verdict comes from the `jev:` segment
 * jev-rank.mjs writes on each pending pipeline row.
 *
 * A row Jev marked `skip` stays in data/pipeline.md (Jev annotates, it never
 * removes a row), but it is not "worth a look": the inbox hides it unless the
 * user turns the skip chip on.
 */

/** @typedef {"apply" | "maybe" | "skip" | "unscored"} JevFacet */

/** @type {JevFacet[]} */
export const JEV_FACETS = ["apply", "maybe", "skip", "unscored"];

/** @param {{jev?: {verdict?: string}}} job @returns {JevFacet} */
export function jevFacetOf(job) {
  const verdict = job?.jev?.verdict;
  if (verdict === "apply" || verdict === "maybe" || verdict === "skip") return verdict;
  return job?.jev ? "maybe" : "unscored";
}

/**
 * Whether a row passes the Jev chips. With no chip on, everything but skip
 * passes; with chips on, only their verdicts pass.
 * @param {{jev?: {verdict?: string}}} job @param {Set<string>} verdicts
 */
export function passesJevFacet(job, verdicts) {
  const facet = jevFacetOf(job);
  return verdicts.size ? verdicts.has(facet) : facet !== "skip";
}
