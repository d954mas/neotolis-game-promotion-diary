// POST /api/reddit/fetch-metadata — on-demand Reddit /comments/<id>.json
// call from the /events/new paste form.
//
// This is the "Get from Reddit" button (mirrors /api/youtube/fetch-metadata).
// User pastes a Reddit post URL, taps the button, we resolve the post id
// → fetch /comments/<id>.json → return title + selftext + submittedAt
// for the form to pre-fill. Distinct from POST /api/events/preview-url
// (which is YouTube-only by current contract) — this endpoint is the
// adapter-owned counterpart for Reddit's paste-preview UX.
//
// Auth: tenantScope chain (anonymous → 401). No per-user rate-limit here
// today — the public-`.json` endpoint has its own 10 req/min ceiling
// enforced inside redditFetch, and the preview fetch counts as ONE
// adapter request against that pool. (A future enhancement could enforce
// the post-refresh user cap here too, but the spam-attack vector is
// thin: preview is read-only, no DB write happens here.)
//
// Mount: redditAdapter.registerRoutes(app) calls app.route("/api", redditMetadataRoutes).

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getAuditContext } from "$lib/server/http/middleware/audit-ip.js";
import { mapErr } from "$lib/server/http/routes/_shared.js";
import { redditParsePostUrl } from "./url.js";
import { handlePostSingle } from "./handlers/post-single.js";
import { isRedditConfigured } from "./credentials.js";
import { AppError } from "$lib/server/services/errors.js";
import { AdapterError } from "$lib/sources/errors.js";
import { enforceRedditUserCap } from "$lib/server/services/quota.js";
import { db } from "$lib/server/db/client.js";
import { getAdapter } from "$lib/sources/registry.js";

const fetchMetadataSchema = z.object({
  url: z.string().url(),
});

export const redditMetadataRoutes = new Hono<{
  Variables: { userId: string; sessionId: string };
}>();

redditMetadataRoutes.post(
  "/reddit/fetch-metadata",
  zValidator("json", fetchMetadataSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    try {
      if (!isRedditConfigured()) {
        throw new AppError(
          "Reddit ingest is not available — operator has not configured REDDIT_USER_AGENT",
          "reddit_not_configured",
          503,
        );
      }
      const url = c.req.valid("json").url;
      const parsed = redditParsePostUrl(url);
      if (parsed === null) {
        throw new AppError("Not a Reddit post URL", "invalid_url", 422, { url });
      }
      // Two-axis user-cap enforcement BEFORE the fetch — preview burns
      // a Reddit unit the same as a paste, so it counts against the
      // post-refresh axis (25/5min). handlePostSingle's 60s dedup means
      // a previewed-then-submitted post produces ONE cap tick, but
      // pre-emptive enforce prevents 100-click attacks from sneaking
      // through (each click pre-dedup writes one done-row; the 26th
      // would fire 429 even within the same window).
      const redditAdapter = getAdapter("reddit_account");
      await enforceRedditUserCap(db, redditAdapter, ctx.userId, ctx.ipAddress, "post-refresh");
      let result;
      try {
        result = await handlePostSingle({
          postId: parsed.externalId,
          userId: ctx.userId,
          paste: true,
        });
      } catch (err) {
        if (err instanceof AdapterError) {
          if (err.category === "not-found") {
            throw new AppError("Reddit post not found", "reddit_post_not_found", 404, {
              postId: parsed.externalId,
            });
          }
          if (err.category === "rate-limited") {
            throw new AppError(
              "Reddit rate-limited; try again shortly",
              "reddit_rate_limited",
              429,
            );
          }
          if (err.category === "operator-issue") {
            throw new AppError("Reddit ingest is not available", "reddit_not_configured", 503);
          }
        }
        throw err;
      }
      return c.json({
        externalId: result.postId,
        title: result.title,
        description: result.selftext.length > 0 ? result.selftext : null,
        authorName: result.author,
        authorUrl:
          result.author !== null
            ? `https://www.reddit.com/user/${result.author}`
            : result.permalink,
        publishedAt: result.submittedAt.toISOString(),
        subreddit: result.subreddit,
        cached: false,
      });
    } catch (err) {
      return mapErr(c, err, "POST /api/reddit/fetch-metadata");
    }
  },
);
