// UI-side registry — CLIENT entry.
//
// Companion to registry-ui.ts (server-safe). This file imports per-source
// `./<kind>/ui/index.ts` (client-safe — may transitively import .svelte
// files) so /feed/+page.svelte and other client components can dispatch
// to a per-source `cardComponent` override when one is registered.
//
// Why two files: registry-ui.ts is consumed by +page.server.ts loaders; it
// MUST stay free of .svelte imports. This file is the parallel client
// surface — `cardComponent` is a Svelte `Component` value, which can only
// flow through the client bundle.
//
// Adapters that want to override the universal /feed FeedCard ship their
// own component under `sources/<kind>/ui/<Whatever>Card.svelte` and
// re-export it from `sources/<kind>/ui/index.ts` as `cardComponent`. The
// universal `FeedCard` is the fallback when no override exists.

import type FeedCard from "$lib/components/FeedCard.svelte";
import type { EventKind, SourceKind } from "./adapter.js";
import { eventKindToSourceKind } from "./event-to-source-kind.js";
import * as youtubeUiClient from "./youtube/ui/index.js";
import * as redditUiClient from "./reddit/ui/index.js";
import * as instagramUiClient from "./instagram/ui/index.js";
import * as telegramUiClient from "./telegram/ui/index.js";

/** Card-component contract — adapters that override /feed rendering must
 *  ship a Svelte component with the same props as the universal FeedCard.
 *  `typeof FeedCard` resolves to Svelte's Component<{event, source, game,
 *  games, onChanged}> shape, so any override that drifts from the contract
 *  fails `pnpm exec tsc --noEmit`. */
export type FeedCardComponent = typeof FeedCard;

export interface AdapterUiClient {
  /** Optional per-source override for the /feed event card. When omitted,
   *  /feed renders the universal `FeedCard.svelte` (handles every
   *  event.kind via internal switches). When present, dispatch picks this
   *  component via `getCardComponent(eventKind)` — per-platform adapters
   *  may want a different visual without bloating the universal card with
   *  kind-specific branches. */
  cardComponent?: FeedCardComponent;

  /** Client-side URL predicate for the /events/new "Get info" paste-
   *  preview button. Returns true if the adapter can preview this URL
   *  (host + path heuristic). Pure function — no network calls. */
  detectPreviewUrl?(url: string): boolean;

  /** Server endpoint the universal /events/new preview button POSTs to
   *  when `detectPreviewUrl` returns true. Each adapter mounts its own
   *  route via `registerRoutes` in its server-side index.ts; this is the
   *  client-side handle for the UI. */
  previewEndpoint?: string;
}

const uiClientRegistry = new Map<SourceKind, AdapterUiClient>([
  ["youtube_channel", youtubeUiClient as unknown as AdapterUiClient],
  // reddit_account + reddit_subreddit both map to the same Reddit UI
  // client module — same reasoning as registry-ui.ts.
  ["reddit_account", redditUiClient as unknown as AdapterUiClient],
  ["reddit_subreddit", redditUiClient as unknown as AdapterUiClient],
  ["instagram_account", instagramUiClient as unknown as AdapterUiClient],
  ["telegram_channel", telegramUiClient as unknown as AdapterUiClient],
]);

/**
 * Look up the per-source card component override for an EventKind.
 *
 * Returns `undefined` when:
 *   - The event kind has no source-kind mapping (conference / talk / press /
 *     other / post — these are user-curated, not poll-driven, so they have
 *     no adapter and thus no override).
 *   - The mapped source kind has no client-side UI registration.
 *   - The adapter is registered but doesn't provide `cardComponent`.
 *
 * Callers (notably /feed/+page.svelte) fall back to the universal
 * `FeedCard.svelte` when this returns `undefined`.
 */
export function getCardComponent(eventKind: EventKind): FeedCardComponent | undefined {
  const sourceKind = eventKindToSourceKind(eventKind);
  if (sourceKind === null) return undefined;
  return uiClientRegistry.get(sourceKind)?.cardComponent;
}

/**
 * Generic preview-adapter dispatch for the /events/new "Get info" button.
 * Iterates registered UI clients, returns the first one whose
 * `detectPreviewUrl` accepts the URL. Returns `{previewEndpoint, sourceKind}`
 * for the UI to POST to, or `null` if no adapter can preview.
 *
 * Each adapter contributes detection via its `<kind>/ui/index.ts`
 * (detectPreviewUrl + previewEndpoint exports). Adding a new adapter
 * with paste-preview support is a 2-line change in that file — no UI
 * code in /events/new needs to know about specific platforms.
 *
 * Dedup pass: reddit_account and reddit_subreddit map to the SAME
 * client module so we iterate distinct modules, not registry entries.
 */
export function findPreviewAdapter(
  url: string,
): { sourceKind: SourceKind; previewEndpoint: string } | null {
  const seen = new Set<AdapterUiClient>();
  for (const [sourceKind, client] of uiClientRegistry.entries()) {
    if (seen.has(client)) continue;
    seen.add(client);
    if (
      typeof client.detectPreviewUrl === "function" &&
      typeof client.previewEndpoint === "string" &&
      client.detectPreviewUrl(url)
    ) {
      return { sourceKind, previewEndpoint: client.previewEndpoint };
    }
  }
  return null;
}
