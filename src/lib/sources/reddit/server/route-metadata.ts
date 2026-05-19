// POST /api/reddit/fetch-metadata — on-demand Reddit post preview call
// from the /events/new paste form.
//
// This is the "Get from Reddit" button (mirrors /api/youtube/fetch-metadata).
// Routed via handlePostSingle → /api/info?id=t3_X (same endpoint the
// cron + refresh-now paths use). Returns title + selftext + submittedAt
// for the form to pre-fill.
//
// The generic cross-source POST /api/events/preview-url ALSO supports
// Reddit (via adapter.fetchEventPreviewMetadata); this Reddit-specific
// route stays for clients that prefer the per-adapter shape and as
// parity with YouTube. Both surfaces share the same cap gate so a
// preview never bypasses the user_post counter.
//
// Auth: tenantScope chain (anonymous → 401). Per-user cap enforcement is
// injected by the adapter barrel so this route stays HTTP-only and does
// not import the cross-source adapter registry/quota graph.
//
// Mount: redditAdapter.registerRoutes(app) calls app.route("/api", redditMetadataRoutes).

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getAuditContext } from "$lib/server/http/middleware/audit-ip.js";
import { mapErr } from "$lib/server/http/routes/_shared.js";
import { redditParsePostUrl } from "./url.js";
import { assertRedditConfigured } from "./credentials.js";
import { AppError } from "$lib/server/services/errors.js";
import { AdapterError } from "$lib/sources/errors.js";
import type { HandlePostSingleResult } from "./handlers/post-single.js";

const fetchMetadataSchema = z.object({
  url: z.string().url(),
});

export function createRedditMetadataRoutes(deps: {
  fetchPostSingleWithCapGate(args: {
    postId: string;
    userId: string;
    ipAddress: string;
  }): Promise<HandlePostSingleResult>;
}): Hono<{ Variables: { userId: string; sessionId: string } }> {
  const routes = new Hono<{
    Variables: { userId: string; sessionId: string };
  }>();

  routes.post(
    "/reddit/fetch-metadata",
    zValidator("json", fetchMetadataSchema, (r, c) => {
      if (!r.success) {
        return c.json({ error: "validation_failed", details: r.error.issues }, 422);
      }
    }),
    async (c) => {
      const ctx = getAuditContext(c);
      try {
        assertRedditConfigured();
        const url = c.req.valid("json").url;
        const parsed = redditParsePostUrl(url);
        if (parsed === null) {
          throw new AppError("Not a Reddit post URL", "invalid_url", 422, { url });
        }
        let result;
        try {
          result = await deps.fetchPostSingleWithCapGate({
            postId: parsed.externalId,
            userId: ctx.userId,
            ipAddress: ctx.ipAddress,
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
          cached: !result.fetched,
        });
      } catch (err) {
        return mapErr(c, err, "POST /api/reddit/fetch-metadata");
      }
    },
  );

  return routes;
}
