import { groupSimilarApplications } from "./pipeline-groups.mjs";

/** UI eligibility only; the core validates current tracker rows under its lock. */
export function canMergeListings(rows) {
  const ids = rows.map(({ n }) => String(n));
  return rows.length >= 2 && rows.length <= 100
    && ids.every((n) => /^[1-9]\d*$/.test(n) && Number.isSafeInteger(Number(n)))
    && new Set(ids).size === rows.length && groupSimilarApplications(rows).length === 1;
}

export async function mergeListings(rows, keep, request = fetch) {
  if (!canMergeListings(rows)) throw new Error("Choose at least two similar listings to merge.");
  if (!rows.some(({ n }) => String(n) === keep)) throw new Error("Choose a retained listing from this group.");
  const response = await request("/api/tracker/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keep, nums: rows.map(({ n }) => String(n)) }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "Could not merge listings.");
  if (result?.ok !== true || String(result.kept) !== keep || !Array.isArray(result.merged)) {
    throw new Error("Could not merge listings. Refresh the pipeline before trying again.");
  }
  return result;
}
