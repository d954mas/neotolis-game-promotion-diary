// Reddit ui/index.ts — client-safe entry.
//
// Re-exports the server-safe surface AND the per-source FeedCard override
// (RedditFeedCard, an ADAPTIVE self/link/image/gallery card forked from
// TwitterFeedCard — D-06) so the /feed dispatch via getCardComponent("reddit_post")
// returns the Reddit-specific card.
//
// RedditFeedCard enforces the Reddit read paths (AGENTS.md no-denorm rule):
//   - sourceLabel: the subreddit slug (intrinsic to the URL, rename-proof — the safe
//     denormalization) / account handle from data_sources via the `source` prop.
//   - thumbnail + stats: read from event.redditEnrichment (the public-data decoration
//     set by ./server/feed-enrichment.ts) — the post's own polling data, not
//     denormalized. The thumbnail is the raw i.redd.it cover hotlinked directly
//     (12-SPIKE Pitfall 5 — NO proxy; image/gallery variant un-sampled by the spike,
//     confirmed at the Plan 12-06 UAT via the browser hotlink test).
//
// .svelte files MUST import from this barrel (not from ./server.js) when they want
// both the mapper AND the per-source component re-export. SvelteKit +page.server.ts
// loaders and other server modules must import from ./server.js to avoid bundler
// crashes pulling server-only deps into the client.
//
// No paste-preview detectPreviewUrl/previewEndpoint exports here: the Reddit
// paste-preview seam (reddit.com/r/<sub>/comments/<id> + redd.it/<id> URLs) is wired
// via the adapter's fetchEventPreviewMetadata + the universal Add-Event paste flow.
export * from "./server.js";

export { default as cardComponent } from "./RedditFeedCard.svelte";
