// Resilient per-post feed mapping — shared across the paid-scraper normalizers
// (instagram / reddit / tiktok / twitter).
//
// A feed page's RESPONSE schema used to validate the ENTIRE posts array strictly, so a
// SINGLE malformed post threw and nuked the whole (PAID) page → pg-boss retry re-paid
// the credit for the good rows too. This helper maps each post INDEPENDENTLY: a stray
// bad row is DROPPED, not fatal.
//
// BUT resilience must not hide a provider SHAPE CHANGE: if a MAJORITY of a page fails to
// parse that is drift, not a fluke, and silently returning a near-empty page would read
// as a false end-of-feed (prematurely marking backfill complete / needs_reconnect). So
// past a majority-drop threshold the helper THROWS AdapterError(transient) — the SAME
// loud, retry-then-dead-letter behavior the old strict parse gave, minus the single-row
// brittleness.
//
// USAGE: loosen the RESPONSE schema's posts-array element to z.unknown(), then map the
// raw array through here with a per-post normalizer that STRICT-PARSES (throws on a bad
// row). PURE — no HTTP / DB / logger imports (normalizer unit tests stay dependency-free;
// the throw is the signal, surfaced by the caller's error handling).

import { AdapterError } from "./errors.js";

/**
 * Map `rawPosts` through `normalizeOne`, dropping any element that throws. If MORE THAN
 * HALF of a non-empty page fails, throw AdapterError(transient) — a probable provider
 * shape change that must fail loudly rather than yield a partial page.
 *
 * `label` names the feed in the thrown error (e.g. "reddit feed", "instagram posts").
 */
export function mapPostsResilient<TOut>(
  rawPosts: readonly unknown[],
  normalizeOne: (raw: unknown) => TOut,
  label: string,
): TOut[] {
  const out: TOut[] = [];
  let dropped = 0;
  for (const raw of rawPosts) {
    try {
      out.push(normalizeOne(raw));
    } catch {
      dropped++;
    }
  }
  // Strictly-more-than-half failed ⇒ shape drift (a 1-post page whose only post is bad
  // also trips this). A minority of bad rows in a healthy page is tolerated.
  if (rawPosts.length > 0 && dropped > rawPosts.length / 2) {
    throw new AdapterError(
      `${label}: ${dropped}/${rawPosts.length} posts failed to parse — probable provider shape change`,
      { category: "transient", context: { dropped, total: rawPosts.length, label } },
    );
  }
  return out;
}
