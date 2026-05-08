// SourceRegistry — Phase 03.0.1 D-14. Map<SourceKind, DataSourceAdapter>
// populated by explicit per-source barrel imports. Plan 01 ships an
// EMPTY map; Plan 03 wires `youtubeChannelAdapter` once the YouTube
// adapter is moved into sources/youtube/server/.
import type { DataSourceAdapter, SourceKind } from "./adapter.js";

const registry = new Map<SourceKind, DataSourceAdapter>([
  // Plan 03: ["youtube_channel", youtubeAdapter],
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
