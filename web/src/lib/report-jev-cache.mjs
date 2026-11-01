import { readReportJev } from './core/evaluation-report.mjs';

/** Cache parsing only: callers still read fresh files. Full text keys avoid
 * stale evidence even when a writer preserves a file's size and timestamps. */
export function createReportJevReader(parse = readReportJev, { maxCharacters = 16_000_000, maxEntries = 2048 } = {}) {
  const cache = new Map();
  let characters = 0;
  return markdown => {
    const text = String(markdown ?? '');
    if (!text || text.length > maxCharacters || maxEntries <= 0) return parse(text);
    let result = cache.get(text);
    if (result) cache.delete(text);
    else {
      result = parse(text);
      characters += text.length;
    }
    cache.set(text, result);
    while (characters > maxCharacters || cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      characters -= oldest.length;
      cache.delete(oldest);
    }
    // Keep cached evidence private; a consumer must not corrupt later ratings.
    return structuredClone(result);
  };
}
