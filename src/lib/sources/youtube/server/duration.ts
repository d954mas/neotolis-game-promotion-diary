// ISO-8601 duration parsing + the Shorts duration PREFILTER.
//
// videos.list?part=contentDetails returns each video's duration as an ISO-8601
// string ("PT15S", "PT4M13S", "PT1H2M3S"). Two callers want this:
//   - the adapter, to attach duration_seconds to a StatsSnapshot, and
//   - the poll worker's classifier, to PREFILTER which videos even warrant a
//     redirect probe.
//
// DURATION IS A PREFILTER, NOT THE DECIDER (user-locked 2026-06-12). A short
// runtime does NOT prove a Short — a ≤3-minute video can be a perfectly ordinary
// horizontal video. So duration only ever SKIPS work: a video longer than the
// Shorts ceiling (3 min) can NEVER be a Short, so we mark it "video" and never
// probe. Everything at-or-under the ceiling is a probe CANDIDATE; the redirect
// probe (shorts-probe.ts) makes the actual call.

/** YouTube's hard Shorts ceiling: 3 minutes = 180s, plus 1s slack for the
 *  occasional 3:00.x encode that rounds to 181. A duration STRICTLY above this
 *  cannot be a Short → skip the probe, classify "video". Mirrors the value the
 *  detection design locked (≤181s = probe candidate). */
export const SHORTS_DURATION_CEILING_SECONDS = 181;

/**
 * Parse an ISO-8601 video duration into whole seconds. Handles the
 * hours/minutes/seconds subset YouTube emits ("PT1H2M3S", "PT4M13S", "PT15S",
 * "PT1M", "PT0S"). Returns null on an unparseable / empty string so callers can
 * distinguish "no duration known" from a real 0-second value.
 */
export function parseIso8601Duration(iso: string): number | null {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return null;
  const [, h, m, s] = match;
  // "PT" with no H/M/S component is not a real duration.
  if (h === undefined && m === undefined && s === undefined) return null;
  return Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
}

/**
 * The duration prefilter verdict for one video:
 *   - "skip-video": duration is known AND > the Shorts ceiling → it can never be
 *     a Short. Classify "video" WITHOUT probing.
 *   - "probe": duration is ≤ the ceiling (a Shorts candidate) OR unknown — the
 *     redirect probe must decide. (Unknown duration is treated as a candidate so
 *     a contentDetails-less response never silently skips classification.)
 */
export function durationPrefilter(durationSeconds: number | null): "skip-video" | "probe" {
  if (durationSeconds !== null && durationSeconds > SHORTS_DURATION_CEILING_SECONDS) {
    return "skip-video";
  }
  return "probe";
}
