// Twitter (X) oEmbed integration — public, no API key, BEST-EFFORT.
//
// Unlike fetchYoutubeOembed (which is the validate-first gate for INSERT —
// failure must reject with 422/502), this fetch is intentionally non-fatal:
// the events row is created either way (with a placeholder title built from
// the URL path if oEmbed fails). Reasoning: Twitter's oEmbed is rate-limited
// and frequently flaky for niche accounts; failing the user's paste because
// publish.twitter.com hiccupped would be worse than missing the author name.
//
// Pitfall 8 — the orchestrator MUST canonicalize x.com → twitter.com BEFORE
// calling this function, because publish.twitter.com only accepts twitter.com
// host strings. The url-parser handles this; this integration assumes it.
//
// 5s AbortController timeout matches the rest of the integration layer.

import { logger } from "../logger.js";

export interface TwitterOembed {
  authorName: string;
  authorHandle: string;
  /** Raw oEmbed HTML; events.notes stores it for forensics + future render. */
  html: string;
}

/**
 * Fetch the publish.twitter.com/oembed record for a canonicalized twitter.com
 * status URL. Returns null on any error or non-2xx response — the caller MUST
 * handle null by creating the events row with a placeholder title rather than
 * surfacing the failure to the user (D-29 / Pitfall 8 best-effort contract).
 */
export async function fetchTwitterOembed(canonicalUrl: string): Promise<TwitterOembed | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(
      `https://publish.twitter.com/oembed?url=${encodeURIComponent(canonicalUrl)}&omit_script=1`,
      {
        signal: ctrl.signal,
        headers: { "user-agent": "neotolis-game-promotion-diary/0.1" },
      },
    );
    if (!res.ok) {
      logger.warn({ status: res.status, url: canonicalUrl }, "twitter oembed non-2xx");
      return null;
    }
    const j = (await res.json()) as Record<string, unknown>;
    // canonicalUrl path: /<handle>/status/<id>
    const handle = new URL(canonicalUrl).pathname.split("/").filter(Boolean)[0] ?? "unknown";
    return {
      authorName: String(j.author_name ?? handle),
      authorHandle: handle,
      html: String(j.html ?? ""),
    };
  } catch (err) {
    // Non-fatal: events row creates with placeholder title.
    logger.warn({ err: (err as Error).message, url: canonicalUrl }, "twitter oembed fetch threw");
    return null;
  } finally {
    clearTimeout(timer);
  }
}
