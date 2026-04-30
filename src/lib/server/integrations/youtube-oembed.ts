// YouTube oEmbed integration — public, no API key, called BEFORE INSERT
// in the validate-first ingest pipeline (D-19; INGEST-04). The discriminated
// return type (W-6 from Plan 02-06 checker iteration) lets the orchestrator
// map cleanly to AppError variants without parsing message strings.
//
// Result kinds (all observed live 2026-04-27 against
// https://www.youtube.com/oembed?url=...):
//   - "ok"           → 200 with title/author/thumbnail JSON; INSERT a row.
//   - "private"      → 401; the video exists but is set to private. The
//                      orchestrator translates to AppError 422 with
//                      metadata: {reason: 'private'} so the route layer
//                      can pick the right Paraglide message.
//   - "unavailable"  → 404 (deleted / region-locked / never existed) and
//                      every other 4xx; orchestrator translates to
//                      AppError 422 with metadata: {reason: 'unavailable'}.
//   - thrown         → 5xx, network errors, AbortError after the 5s
//                      timeout. The orchestrator catches at its boundary
//                      and rethrows as AppError 502
//                      "youtube_oembed_unreachable".
//
// 5s AbortController timeout matches the rest of the integration layer
// (steam-api.ts) — a slow oEmbed must never hang an interactive paste.

import { logger } from "../logger.js";

export type YoutubeOembedResult =
  | {
      kind: "ok";
      data: {
        title: string;
        authorName: string;
        authorUrl: string;
        thumbnailUrl: string;
      };
    }
  | { kind: "unavailable" }
  | { kind: "private" };

/**
 * Fetch the public oEmbed record for a canonicalized YouTube watch URL.
 *
 * Returns a discriminated union for the 200 / 401 / 404 axes; throws on
 * 5xx and network errors so the orchestrator can map them to a single
 * `youtube_oembed_unreachable` 502 without conditional logic on result.kind.
 *
 * Authentication: none. The endpoint is public; do NOT add a Google API
 * key here — that would route through Data API quota for no benefit.
 */
export async function fetchYoutubeOembed(canonicalUrl: string): Promise<YoutubeOembedResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`,
      {
        signal: ctrl.signal,
        headers: { "user-agent": "neotolis-game-promotion-diary/0.1" },
      },
    );
    if (res.status === 401) return { kind: "private" };
    if (res.status === 404) return { kind: "unavailable" };
    if (res.status >= 500) {
      throw new Error("youtube_oembed_5xx");
    }
    if (!res.ok) {
      // Any other 4xx: treat as unavailable (rate-limit, malformed, region-blocked).
      logger.warn(
        { status: res.status, url: canonicalUrl },
        "youtube oembed non-2xx, treating as unavailable",
      );
      return { kind: "unavailable" };
    }
    const j = (await res.json()) as Record<string, unknown>;
    return {
      kind: "ok",
      data: {
        title: String(j.title ?? ""),
        authorName: String(j.author_name ?? ""),
        authorUrl: String(j.author_url ?? ""),
        thumbnailUrl: String(j.thumbnail_url ?? ""),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
