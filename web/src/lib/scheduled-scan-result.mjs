import { extractJsonObject } from "./extract-json-object.mjs";

/** Require a complete scanner receipt; unreadable output is never an empty scan. */
export function scheduledScanResult(engine, stdout) {
  const { obj: receipt, truncated } = extractJsonObject(String(stdout || ""));
  const count = engine === "full" ? receipt?.postingsKept : receipt?.added;
  if (truncated || !receipt || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("Scanner returned no complete, valid result receipt.");
  }
  if (engine !== "full" && receipt.version !== "careerops.scan.receipt@1") {
    throw new Error("Scanner returned an unsupported result receipt.");
  }

  const details = [];
  const warnings = [];
  let failed = false;
  if (engine === "full") {
    if (Number.isSafeInteger(receipt.companiesScanned)) {
      details.push(`Scanned ${receipt.companiesScanned}${Number.isSafeInteger(receipt.companiesAvailable) ? ` of ${receipt.companiesAvailable}` : ""} companies.`);
      if (receipt.companiesScanned === 0) failed = true;
    }
    if (receipt.capHit) warnings.push("Company limit reached; only a rotating sample was searched.");
    if (receipt.stoppedByOutage || receipt.stoppedEarly) warnings.push("Scan stopped before all sources finished.");
    const datasets = Object.entries(receipt.datasetStatus || {});
    const unavailable = datasets.filter(([, status]) => status !== "ok");
    if (unavailable.length) warnings.push(`Company lists unavailable or stale: ${unavailable.map(([name]) => name).join(", ")}.`);
    if (datasets.length && datasets.every(([, status]) => status === "empty")) failed = true;
    if (receipt.unreachableBoards > 0) warnings.push(`${receipt.unreachableBoards} boards unreachable.`);
    if (receipt.cappedBoards > 0) warnings.push(`${receipt.cappedBoards} boards reached their page limit.`);
    if (receipt.postingsDroppedNoDate > 0) warnings.push(`${receipt.postingsDroppedNoDate} posting${receipt.postingsDroppedNoDate === 1 ? "" : "s"} excluded because no posting date was available.`);
  } else {
    if (Number.isSafeInteger(receipt.scanned)) {
      details.push(`Searched ${receipt.scanned} sources; ${receipt.found ?? 0} jobs read, ${receipt.filtered ?? 0} filtered out, ${receipt.duplicates ?? 0} already known.`);
      if (receipt.scanned === 0) failed = true;
    }
    if (receipt.errors?.length) {
      warnings.push(`${receipt.errors.length} source errors: ${String(receipt.errors[0].error || "unknown error").slice(0, 200)}.`);
      if (receipt.errors.length >= receipt.scanned && receipt.found === 0) failed = true;
    }
    if (receipt.unverified_zero?.length) warnings.push(`${receipt.unverified_zero.length} sources returned an unverified empty result.`);
  }
  return {
    state: failed ? "failed" : warnings.length ? "partial" : "success",
    rolesFound: count,
    message: [
      failed ? `Scan could not verify coverage; ${count} new matching roles saved.` : `Scan finished with ${count} new matching role${count === 1 ? "" : "s"}.`,
      ...details,
      ...warnings,
    ].join(" "),
  };
}
