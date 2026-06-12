// YouTube Shorts redirect probe — THE decider for short-vs-video.
//
// User-locked design (2026-06-12): video DURATION is ONLY a prefilter, never
// the decider. A ≤3-minute video CAN be a regular (horizontal) video, not a
// Short — duration alone would mis-tag those. The actual classifier asks
// YouTube itself: GET https://www.youtube.com/shorts/<videoId> with
// redirect="manual".
//
//   - 200 OK          → the id IS a Short (YouTube served the Shorts player).
//   - 3xx → /watch    → NOT a Short; YouTube bounced /shorts/<id> to the
//                       standard watch page (a regular video can never live at
//                       a /shorts/ URL).
//   - 3xx → consent   → consent.google.com / consent.youtube.com interstitial
//                       (EU cookie wall). Retry ONCE with `Cookie: SOCS=CAI`
//                       (the "consent accepted" cookie) to slip past the wall.
//   - anything else /  → ambiguous → null (unknown). The caller leaves
//     ambiguous-after-retry  media_type NULL. NULL classifies as "video"
//                       downstream — we NEVER guess a Short.
//
// No API quota: this is a plain unauthenticated HTTP GET against the public
// web frontend, not the Data API. Cheap, but NOT free of latency — every probe
// is a network round-trip, so callers BOUND the number of probes per poll tick
// (PROBE_BUDGET_PER_TICK) and let a large legacy backlog heal gradually across
// successive ticks instead of stalling one tick on hundreds of probes.

import { logger } from "$lib/server/logger.js";

/** The classifier verdict. "short" / "video" are decisive; null = unknown
 *  (leave media_type NULL — classifies as video downstream, never guessed). */
export type ShortsProbeResult = "short" | "video" | null;

/** Per-probe network timeout. Probes run in the poll worker's tick budget; an
 *  8s ceiling keeps one slow id from eating the whole tick. */
const PROBE_TIMEOUT_MS = 8_000;

/** Desktop UA — YouTube serves the Shorts player vs the /watch redirect based
 *  on the client. A desktop UA gets the deterministic redirect behavior this
 *  probe relies on (a mobile UA can serve a different app-interstitial path). */
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Max probes a single poll tick will issue. A larger legacy NULL backlog heals
 *  over many ticks rather than stalling one tick on hundreds of round-trips. */
export const PROBE_BUDGET_PER_TICK = 20;

/** Is a redirect Location the EU consent interstitial? Both consent.google.com
 *  and consent.youtube.com are used depending on region/rollout. */
function isConsentRedirect(location: string): boolean {
  try {
    const host = new URL(location, "https://www.youtube.com").hostname.toLowerCase();
    return host === "consent.google.com" || host === "consent.youtube.com";
  } catch {
    return false;
  }
}

/** Does a redirect Location point at the standard watch page (→ NOT a Short)? */
function isWatchRedirect(location: string): boolean {
  try {
    return new URL(location, "https://www.youtube.com").pathname.startsWith("/watch");
  } catch {
    // A bare relative "/watch?v=…" Location still parses against the base above,
    // so reaching here means a truly malformed Location → treat as ambiguous.
    return false;
  }
}

/** Map ONE manual-redirect response to a verdict, or "consent" to signal the
 *  caller should retry with the SOCS cookie. Pure given a Response shape. */
function classify(status: number, location: string | null): ShortsProbeResult | "consent" {
  // 200 → YouTube served the Shorts player → it IS a Short.
  if (status === 200) return "short";
  // 3xx → inspect Location.
  if (status >= 300 && status < 400 && location !== null) {
    if (isConsentRedirect(location)) return "consent";
    if (isWatchRedirect(location)) return "video";
  }
  // Anything else (4xx/5xx, a 3xx to somewhere unexpected, a missing Location)
  // is ambiguous → unknown.
  return null;
}

/** One manual-redirect GET. Returns the raw {status, location} or null on a
 *  network/timeout failure (probe failures are non-fatal → NULL upstream). */
async function probeOnce(
  videoId: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; location: string | null } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": DESKTOP_UA, ...extraHeaders },
      signal: controller.signal,
    });
    return { status: resp.status, location: resp.headers.get("location") };
  } catch (err) {
    logger.debug(
      { videoId, err: String((err as Error)?.message ?? err) },
      "youtube shorts-probe: fetch failed (non-fatal → media_type stays NULL)",
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Probe a single video id. The DECIDER — returns "short" / "video" / null.
 *
 * Flow: one manual-redirect GET → classify. On a consent interstitial, retry
 * ONCE with `Cookie: SOCS=CAI` (consent-accepted) and re-classify; if still
 * ambiguous, return null (leave media_type NULL — NEVER guess a Short).
 */
export async function probeIsShort(videoId: string): Promise<ShortsProbeResult> {
  const first = await probeOnce(videoId);
  if (first === null) return null; // network failure → unknown.

  const verdict = classify(first.status, first.location);
  if (verdict !== "consent") return verdict;

  // EU consent wall — retry once with the consent-accepted cookie.
  const retry = await probeOnce(videoId, { Cookie: "SOCS=CAI" });
  if (retry === null) return null;
  const retryVerdict = classify(retry.status, retry.location);
  // A second consent (or any non-decisive result) stays ambiguous → null.
  return retryVerdict === "consent" ? null : retryVerdict;
}
