// SourceRegistry — Phase 03.0.1 D-14. Map<SourceKind, DataSourceAdapter>
// populated by explicit per-source barrel imports.
//
// Plan 03 wires youtube_channel; future Reddit / Twitter / Telegram /
// Discord adapters land in Phase 03.1+ and add entries here.
import type { DataSourceAdapter, SourceKind } from "./adapter.js";
import { youtubeAdapter } from "./youtube/server/index.js";

const registry = new Map<SourceKind, DataSourceAdapter>([
  ["youtube_channel", youtubeAdapter],
]);

export function getAdapter(kind: SourceKind): DataSourceAdapter {
  const adapter = registry.get(kind);
  if (adapter === undefined) {
    throw new Error(`No adapter registered for kind=${kind as string}`);
  }
  return adapter;
}

/** Iterating order is registration order — load-bearing for D-15
 *  first-match-wins URL routing. */
export const allAdapters: DataSourceAdapter[] = Array.from(registry.values());
