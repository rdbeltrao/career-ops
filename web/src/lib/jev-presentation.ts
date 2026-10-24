import type { ApplicationJev } from "@/lib/career-ops";

/** Badge tone for a Jev verdict: apply good, maybe warn, skip bad, unknown muted. */
export function jevTone(verdict: ApplicationJev["verdict"]): "good" | "warn" | "bad" | "muted" {
  if (verdict === "apply") return "good";
  if (verdict === "maybe") return "warn";
  if (verdict === "skip") return "bad";
  return "muted";
}

/** `Jev 68 · maybe`, with whichever of fit and verdict is known. */
export function jevLabel(jev: Pick<ApplicationJev, "fit" | "verdict">): string {
  const parts = [jev.fit !== null ? String(jev.fit) : null, jev.verdict].filter(Boolean);
  return `Jev ${parts.join(" · ") || "—"}`;
}
