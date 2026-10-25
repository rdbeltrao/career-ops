// The Explore page's Ignore button. Ignoring a posting writes a permanent
// `skipped_ignored` row to data/scan-history.tsv, and that file is append-only,
// so an Undo cannot take the row back. Instead the write waits: the card is
// hidden at once, and the request is sent only when the undo window closes (or
// the page is being left). Undo inside the window cancels it, and nothing is
// written. Kept as a plain .mjs so `node --test` can load it.

/** How long the Undo button stays available before the ignore is written. */
export const IGNORE_UNDO_MS = 6000;

/**
 * @template {{ url: string }} O
 * @param {{
 *   commit: (offer: O) => Promise<void>,
 *   delayMs?: number,
 *   schedule?: (fn: () => void, ms: number) => unknown,
 *   cancel?: (timer: unknown) => void,
 * }} options
 */
export function createIgnoreQueue({ commit, delayMs = IGNORE_UNDO_MS, schedule = setTimeout, cancel = clearTimeout }) {
  /** @type {Map<string, { offer: O, timer: unknown }>} */
  const pending = new Map();

  /** Send one pending ignore now. Resolves once its write has settled. */
  const fire = (url) => {
    const entry = pending.get(url);
    if (!entry) return Promise.resolve();
    pending.delete(url);
    cancel(entry.timer);
    return Promise.resolve().then(() => commit(entry.offer)).catch(() => {});
  };

  return {
    /** Start the undo window for `offer`. A second call for the same URL is a no-op. */
    add(offer) {
      if (pending.has(offer.url)) return;
      const timer = schedule(() => { void fire(offer.url); }, delayMs);
      pending.set(offer.url, { offer, timer });
    },
    /** Cancel a pending ignore. Returns false when it was already sent. */
    undo(url) {
      const entry = pending.get(url);
      if (!entry) return false;
      cancel(entry.timer);
      pending.delete(url);
      return true;
    },
    /** Send every pending ignore now, for example when the page is being left. */
    flush() {
      return Promise.all([...pending.keys()].map(fire)).then(() => {});
    },
    has(url) {
      return pending.has(url);
    },
  };
}

/**
 * POST offers to /api/explore/ignore. `keepalive` lets the request finish when
 * it is sent while the page unloads. Throws with a message the UI can show.
 *
 * @param {Array<object>} offers
 * @param {typeof fetch} [request]
 * @returns {Promise<number>} how many offers the server recorded
 */
export async function postIgnore(offers, request = fetch) {
  const response = await request("/api/explore/ignore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offers }),
    keepalive: true,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || typeof result.ignored !== "number" || result.error) {
    throw new Error(typeof result?.error === "string" ? result.error : "Could not save the ignore. Please try again.");
  }
  return result.ignored;
}
