// URL ingest parser — pure host-detection + canonicalization (D-18, Pitfall 8).
//
// This module is the FIRST step in the validate-first ingest pipeline (D-19;
// INGEST-04). It performs zero I/O and zero DB writes — just URL parsing,
// host classification, and canonicalization. The orchestrator
// (`services/ingest.ts`) calls oEmbed integrations AFTER this returns a
// non-`unsupported` kind, then INSERTs ONLY after oEmbed succeeds.
//
// Pitfall 8 (RESEARCH.md §"Pitfall 8"): x.com is canonicalized to twitter.com
// because publish.twitter.com/oembed only accepts the twitter.com host. The
// canonicalization happens here once so every downstream call (oEmbed, DB
// row, audit metadata) uses the same string. mobile.twitter.com is also
// canonicalized to twitter.com for the same reason.
//
// D-18 host routing rules (canonical):
//   youtube.com / youtu.be / m.youtube.com → youtube_video (with extracted videoId)
//   x.com / twitter.com / mobile.twitter.com → twitter_post (canonicalized to twitter.com)
//   t.me                                  → telegram_post
//   reddit.com / redd.it / old.reddit.com → reddit_deferred (D-18 friendly inline message)
//   anything else                         → unsupported

export type ParsedUrl =
  | { kind: "youtube_video"; videoId: string; canonicalUrl: string }
  | { kind: "twitter_post"; canonicalUrl: string }
  | { kind: "telegram_post"; canonicalUrl: string }
  | { kind: "reddit_deferred" }
  | { kind: "unsupported" };

const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const X_HOSTS = new Set(["twitter.com", "x.com", "mobile.twitter.com"]);
const TG_HOSTS = new Set(["t.me"]);
const RD_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com", "redd.it"]);

export function parseIngestUrl(input: string): ParsedUrl {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { kind: "unsupported" };
  }
  const host = url.hostname.toLowerCase();
  if (YT_HOSTS.has(host)) {
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) return { kind: "unsupported" };
    return {
      kind: "youtube_video",
      videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }
  if (X_HOSTS.has(host)) {
    // Pitfall 8: canonicalize x.com / mobile.twitter.com → twitter.com so
    // publish.twitter.com/oembed accepts the URL. The canonical form is what
    // gets stored in events.url and audit metadata.
    const canonical =
      host === "x.com" || host === "mobile.twitter.com"
        ? `https://twitter.com${url.pathname}${url.search}`
        : url.toString();
    return { kind: "twitter_post", canonicalUrl: canonical };
  }
  if (TG_HOSTS.has(host)) return { kind: "telegram_post", canonicalUrl: url.toString() };
  if (RD_HOSTS.has(host)) return { kind: "reddit_deferred" };
  return { kind: "unsupported" };
}

function extractYouTubeVideoId(u: URL): string | null {
  // Accepted forms (live verified 2026-04-27):
  //   /watch?v=XXX
  //   youtu.be/XXX
  //   /shorts/XXX
  //   /live/XXX
  //   /embed/XXX
  if (u.hostname.includes("youtu.be")) {
    const id = u.pathname.replace(/^\//, "").split("/")[0];
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  }
  const v = u.searchParams.get("v");
  if (v && /^[\w-]{11}$/.test(v)) return v;
  const shortsMatch = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{11})/);
  if (shortsMatch) return shortsMatch[2]!;
  return null;
}
