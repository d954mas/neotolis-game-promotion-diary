// Client-safe pure helper: derive the "@handle" from a t.me channel/post URL.
//
// ONE home for the t.me-URL slug shape, used by all three name-rendering
// surfaces so they agree on the "@durov" fallback shown when no channel title
// is resolved yet (a just-added, not-yet-polled channel):
//   - SourceRow (the /sources list)
//   - the /sources/[id] detail-page heading
//   - telegramChannelHandleLabel (the /feed card)
//
// The server has a richer parser (telegram/server/url.ts) but it can't be
// imported into the client bundle (it pulls in adapter/DB types), so this
// mirrors the minimal slug shape — exactly as infer-source-kind.ts mirrors the
// host table for the same client-can't-import-server reason.
export function telegramHandleFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/t\.me\/(?:s\/)?([^/?#]+)/i);
  return m ? `@${m[1]}` : null;
}
