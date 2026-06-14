// Twitter/X ui/index.ts — client-safe entry.
//
// Re-exports the server-safe surface AND the per-source FeedCard override
// (TwitterFeedCard, an ADAPTIVE media/text card forked from TelegramFeedCard —
// D-06) so the /feed dispatch via getCardComponent("twitter_post") returns the
// Twitter-specific card.
//
// TwitterFeedCard enforces the Twitter read paths (AGENTS.md no-denorm rule):
//   - sourceLabel: the Twitter @handle/displayName from data_sources via the
//     `source` prop (FK lookup at /feed loader time) — NEVER from event
//     metadata (the handle can be renamed by the account owner).
//   - thumbnail + stats: read from event.twitterEnrichment (the public-data
//     decoration set by ./server/feed-enrichment.ts) — the tweet's own polling
//     data, not denormalized from another table. The thumbnail is the RAW
//     pbs.twimg.com cover hotlinked directly (11-SPIKE.md Q6 — NO proxy, unlike
//     TikTok's ORB-blocked CDN).
//
// .svelte files MUST import from this barrel (not from ./server.js) when they
// want both the mapper AND the per-source component re-export. SvelteKit
// +page.server.ts loaders and other server modules must import from ./server.js
// to avoid bundler crashes pulling server-only deps into the client.
//
// No paste-preview detectPreviewUrl/previewEndpoint exports here: the Twitter
// paste-preview seam (x.com/twitter.com /status/<id> URLs) is wired via the
// adapter's fetchEventPreviewMetadata + the universal Add-Event paste flow.
export * from "./server.js";

export { default as cardComponent } from "./TwitterFeedCard.svelte";
