// Instagram ui/index.ts — client-safe entry.
//
// Re-exports the server-safe surface AND the per-source FeedCard override
// (InstagramFeedCard) so the /feed dispatch via
// getCardComponent("instagram_post") returns the Instagram-specific card.
//
// InstagramFeedCard enforces the IG read paths (AGENTS.md no-denorm rule):
//   - sourceLabel: the IG handle/displayName from data_sources via the
//     `source` prop (FK lookup at /feed loader time) — NEVER from event
//     metadata (the handle can be renamed by the account owner).
//   - thumbnail + stats: read from event.instagramEnrichment (the
//     public-data decoration set by ./server/feed-enrichment.ts) — the
//     post's own polling data, not denormalized from another table.
//
// .svelte files MUST import from this barrel (not from ./server.js) when
// they want both the mapper AND the per-source component re-export.
// SvelteKit +page.server.ts loaders and other server modules must import
// from ./server.js to avoid bundler crashes pulling server-only deps into
// the client.
//
// No paste-preview support this phase — IG sources are added by handle via
// the add-source flow, not pasted into /events/new (CONTEXT). So no
// detectPreviewUrl / previewEndpoint exports.
export * from "./server.js";

export { default as cardComponent } from "./InstagramFeedCard.svelte";
