// Phase 3.0 Plan 14 — mock YouTube reverse-proxy for the smoke gate.
//
// CONTEXT D-NEW Smoke + RESEARCH "Don't Hand-Roll" §"Mock YouTube":
// the smoke gate MUST NOT make live YouTube API calls. The Phase 3.0 worker
// reaches Google through `env.YOUTUBE_API_BASE_URL` (default
// `https://www.googleapis.com/youtube/v3`); the smoke shell launches THIS
// stub on a free port and exports `YOUTUBE_API_BASE_URL=http://localhost:$port`
// so worker traffic is intercepted here instead of going live.
//
// Pitfall G (recorded fixtures rejected): real fixtures drift on schema
// changes; a tiny custom stub is the documented choice. The Wave 0 live
// spike (03.0-RESEARCH.md "Open Questions" #1, run 2026-05-06, VERIFIED)
// is the schema-shape assertion against real Google; this stub mirrors
// that exact shape for offline reproducibility.
//
// Endpoints implemented (only what Phase 3.0 worker code actually calls):
//   GET .../videos          → videos.list (50 items, deterministic)
//   GET .../playlistItems   → playlistItems.list (10 items)
//   GET .../channels        → channels.list (1 channel with uploadsPlaylistId)
//
// Anything else returns 404 with `{ error: { code: 404, message: '...' } }`
// in the same shape Google emits; the worker's zod parsers will surface
// the mismatch loudly if a future endpoint gets added without extending
// the stub.
//
// Lifecycle: pure stdlib (`node:http`); no install. Boots on
// `process.env.YOUTUBE_MOCK_PORT` (or 0 = OS-assigned free port). Logs the
// resolved port to stdout so the shell wrapper can capture it.

import { createServer } from "node:http";

const PORT = Number(process.env.YOUTUBE_MOCK_PORT ?? 0);

// Deterministic 50-video response (every 5th item is a Short so worker's
// duration-based detector exercises both branches).
const VIDEOS_RESPONSE = {
  kind: "youtube#videoListResponse",
  pageInfo: { totalResults: 50, resultsPerPage: 50 },
  items: Array.from({ length: 50 }, (_, i) => ({
    kind: "youtube#video",
    id: `mockvideo${String(i).padStart(2, "0")}`,
    snippet: {
      publishedAt: new Date(Date.now() - i * 86_400_000).toISOString(),
      channelId: "UCmockchannel0123456789ab",
      title: `Mock Video ${i}`,
      description: `Mock video ${i} description`,
      channelTitle: "Mock Channel",
    },
    statistics: {
      viewCount: String(1000 + i * 100),
      likeCount: String(50 + i * 5),
      commentCount: String(10 + i),
    },
    contentDetails: {
      duration: i % 5 === 0 ? "PT45S" : "PT4M13S",
    },
  })),
};

const PLAYLIST_ITEMS_RESPONSE = {
  kind: "youtube#playlistItemListResponse",
  pageInfo: { totalResults: 10, resultsPerPage: 10 },
  items: Array.from({ length: 10 }, (_, i) => ({
    kind: "youtube#playlistItem",
    snippet: {
      publishedAt: new Date(Date.now() - i * 86_400_000).toISOString(),
      channelId: "UCmockchannel0123456789ab",
      title: `Mock Upload ${i}`,
      resourceId: { kind: "youtube#video", videoId: `mockvideo${String(i).padStart(2, "0")}` },
    },
    contentDetails: {
      videoId: `mockvideo${String(i).padStart(2, "0")}`,
      videoPublishedAt: new Date(Date.now() - i * 86_400_000).toISOString(),
    },
  })),
};

const CHANNELS_RESPONSE = {
  kind: "youtube#channelListResponse",
  pageInfo: { totalResults: 1, resultsPerPage: 1 },
  items: [
    {
      kind: "youtube#channel",
      id: "UCmockchannel0123456789ab",
      snippet: {
        title: "Mock Channel",
        description: "Smoke-gate mock channel",
        publishedAt: "2020-01-01T00:00:00Z",
      },
      contentDetails: {
        relatedPlaylists: { uploads: "UUmockchannel0123456789ab" },
      },
    },
  ],
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  res.setHeader("Content-Type", "application/json");

  // Match on pathname suffix so both `/videos` (relative base) and
  // `/youtube/v3/videos` (full base) variants work — the worker's
  // YOUTUBE_API_BASE_URL env may include the `/youtube/v3` prefix.
  if (url.pathname.endsWith("/videos")) {
    res.statusCode = 200;
    res.end(JSON.stringify(VIDEOS_RESPONSE));
    return;
  }
  if (url.pathname.endsWith("/playlistItems")) {
    res.statusCode = 200;
    res.end(JSON.stringify(PLAYLIST_ITEMS_RESPONSE));
    return;
  }
  if (url.pathname.endsWith("/channels")) {
    res.statusCode = 200;
    res.end(JSON.stringify(CHANNELS_RESPONSE));
    return;
  }

  res.statusCode = 404;
  res.end(
    JSON.stringify({
      error: {
        code: 404,
        message: `mock not implemented: ${url.pathname}`,
        errors: [{ reason: "notFound", message: "endpoint not stubbed" }],
      },
    }),
  );
});

server.listen(PORT, () => {
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : PORT;
  // Stdout line captured by youtube-mock.sh. Format is documented contract.
  console.log(`youtube-mock listening on :${boundPort}`);
});

// Graceful shutdown — the shell wrapper SIGTERMs us on EXIT trap.
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
