// POST /api/youtube/fetch-metadata — on-demand YouTube videos.list call from
// the /events/new paste form (Phase 3.0 post-build, UAT 2026-05-06).
//
// This is the "Get from YouTube" button: user pastes a watch URL, taps the
// button, we resolve video_id → call videos.list?part=snippet (1 quota
// unit), return title + description + channel title for the form to
// pre-fill. Distinct from POST /api/events/preview-url (Plan 02.1-17),
// which uses oEmbed and is auto-triggered on URL blur — this one is
// explicit-button and uses the richer YouTube Data API surface.
//
// Auth: tenantScope chain (anonymous → 401). Per-user rate-limit: the
// existing events_per_day abuse quota is the cap (a paste-spam loop can
// only burn quota up to that ceiling per day per user).
//
// Mount: app.route("/api/youtube", youtubeMetadataRoutes).

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { fetchVideoMetadataByUrl } from "../../services/youtube-metadata.js";
import { mapErr } from "./_shared.js";

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
    try {
      const meta = await fetchVideoMetadataByUrl(c.req.valid("json").url, c.var.userId);
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
