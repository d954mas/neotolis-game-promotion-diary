// UI-side registry — Phase 03.0.1 D-14. Plan 09 wires per-kind UI
// module re-exports (toCardProps + Svelte components).
import type { SourceKind } from "./adapter.js";

export interface AdapterUiServer {
  /** Pure-function mapper safe to call from +page.server.ts (no Svelte
   *  component imports). */
  toCardProps: (event: unknown) => import("./card-props.js").CardProps;
}

const uiRegistry = new Map<SourceKind, AdapterUiServer>([
  // Plan 09: ["youtube_channel", youtubeUiServer],
]);

export function getAdapterUI(kind: SourceKind): AdapterUiServer {
  const ui = uiRegistry.get(kind);
  if (ui === undefined) throw new Error(`No UI registered for kind=${kind as string}`);
  return ui;
}
