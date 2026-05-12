// POST /api/youtube/fetch-metadata — on-demand YouTube videos.list call
// from the /events/new paste form.
//
// This is the "Get from YouTube" button: user pastes a watch URL, taps the
// button, we resolve video_id → call videos.list?part=snippet (1 quota
// unit), return title + description + channel title for the form to
// pre-fill. Distinct from POST /api/events/preview-url, which uses oEmbed
// and is auto-triggered on URL blur — this one is explicit-button and uses
// the richer YouTube Data API surface.
//
// Auth: tenantScope chain (anonymous → 401). Per-user rate-limit: cache
// hits are free (no Google call); cache misses run inside withQuotaGuard
// against the youtube_metadata_fetches_per_day kind (default 50/day,
// rolling 24h, counted in youtube_metadata_fetch_log). Closes the
// operator-quota burn loop a scripted-loop attacker could otherwise
// exploit by mass-pasting random video ids.
//
// Mount: app.route("/api/youtube", youtubeMetadataRoutes). Lives under the
// per-source folder so adding e.g. Reddit's per-source routes follows the
// same pattern.

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { fetchVideoMetadataByUrl } from "./metadata.js";
import { getAuditContext } from "$lib/server/http/middleware/audit-ip.js";
import { mapErr } from "$lib/server/http/routes/_shared.js";

const fetchMetadataSchema = z.object({
  url: z.string().url(),
});

export const youtubeMetadataRoutes = new Hono<{
  Variables: { userId: string; sessionId: string };
}>();

youtubeMetadataRoutes.post(
  "/youtube/fetch-metadata",
  zValidator("json", fetchMetadataSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    try {
      const meta = await fetchVideoMetadataByUrl(
        c.req.valid("json").url,
        ctx.userId,
        ctx.ipAddress,
      );
      return c.json({
        videoId: meta.videoId,
        title: meta.title,
        description: meta.description,
        channelTitle: meta.channelTitle,
        channelId: meta.channelId,
        publishedAt: meta.publishedAt,
        cached: meta.cached,
      });
    } catch (err) {
      return mapErr(c, err, "POST /api/youtube/fetch-metadata");
    }
  },
);
