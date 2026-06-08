// Telegram ui/index.ts — client-safe entry.
//
// Re-exports the server-safe surface AND the per-source FeedCard override
// (TelegramFeedCard) so the /feed dispatch via
// getCardComponent("telegram_post") returns the Telegram-specific card.
//
// TelegramFeedCard enforces the Telegram read paths (AGENTS.md no-denorm
// rule):
//   - sourceLabel: the channel display name / @handle from data_sources
//     via the `source` prop (FK lookup at /feed loader time) — NEVER from
//     event metadata (the @handle can be renamed by the channel owner).
//   - thumbnail + stats: read from event.telegramEnrichment (the
//     public-data decoration set by ./server/feed-enrichment.ts) — the
//     post's own polling data, not denormalized from another table.
//
// .svelte files MUST import from this barrel (not from ./server.js) when
// they want both the mapper AND the per-source component re-export.
// SvelteKit +page.server.ts loaders and other server modules must import
// from ./server.js to avoid bundler crashes pulling server-only deps into
// the client.
//
// No paste-preview support this phase — Telegram channels are added by
// handle via the add-source flow (CONTEXT). So no detectPreviewUrl /
// previewEndpoint exports.
export * from "./server.js";

export { default as cardComponent } from "./TelegramFeedCard.svelte";
