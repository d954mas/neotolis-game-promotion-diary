// UI-side registry — server entry. Per-kind UI module re-exports
// (toCardProps + future Svelte components per kind).
//
// Imports from `./youtube/ui/server.js` (server-safe entry) so this
// registry can be consumed from +page.server.ts loaders without
// triggering a SvelteKit pre-render crash (which happens when a server
// module transitively imports .svelte files outside a Svelte context).
import type { SourceKind } from "./adapter.js";
import type { CardProps } from "./card-props.js";
import * as youtubeUiServer from "./youtube/ui/server.js";

export interface AdapterUiServer {
  /** Pure-function mapper safe to call from +page.server.ts (no Svelte
   *  component imports). */
  toCardProps: (event: unknown) => CardProps;
}

// Per-kind ui/server.ts modules expose a narrow toCardProps(event: <KindLite>)
// signature; the registry's AdapterUiServer.toCardProps takes `unknown` so
// callers don't have to know the per-kind shape. The cast here is the
// boundary where the per-kind narrow type meets the registry's generic
// surface — same pattern as src/lib/sources/registry.ts's adapter map for
// the server-side DataSourceAdapter contract.
const uiRegistry = new Map<SourceKind, AdapterUiServer>([
  ["youtube_channel", youtubeUiServer as unknown as AdapterUiServer],
]);

export function getAdapterUI(kind: SourceKind): AdapterUiServer {
  const ui = uiRegistry.get(kind);
  if (ui === undefined) throw new Error(`No UI registered for kind=${kind as string}`);
  return ui;
}
