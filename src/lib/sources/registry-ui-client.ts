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
}

const uiClientRegistry = new Map<SourceKind, AdapterUiClient>([
  ["youtube_channel", youtubeUiClient as unknown as AdapterUiClient],
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
