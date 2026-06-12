// TikTok ui/index.ts — client-safe entry.
//
// Re-exports the server-safe surface AND the per-source FeedCard override
// (TikTokFeedCard, a thin fork of InstagramFeedCard — D-07) so the /feed
// dispatch via getCardComponent("tiktok_post") returns the TikTok-specific card.
//
// TikTokFeedCard enforces the TikTok read paths (AGENTS.md no-denorm rule):
//   - sourceLabel: the TikTok handle/displayName from data_sources via the
//     `source` prop (FK lookup at /feed loader time) — NEVER from event
//     metadata (the handle can be renamed by the account owner).
//   - thumbnail + stats: read from event.tiktokEnrichment (the public-data
//     decoration set by ./server/feed-enrichment.ts) — the post's own polling
//     data, not denormalized from another table.
//
// .svelte files MUST import from this barrel (not from ./server.js) when they
// want both the mapper AND the per-source component re-export. SvelteKit
// +page.server.ts loaders and other server modules must import from ./server.js
// to avoid bundler crashes pulling server-only deps into the client.
//
// No paste-preview detectPreviewUrl/previewEndpoint exports here: the TikTok
// paste-preview seam (vm./vt. short links + canonical video URLs) is wired via
// the adapter's fetchEventPreviewMetadata + the universal Add-Event paste flow.
export * from "./server.js";

export { default as cardComponent } from "./TikTokFeedCard.svelte";
