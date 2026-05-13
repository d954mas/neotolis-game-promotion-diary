// SourceRegistry — Map<SourceKind, DataSourceAdapter> populated by
// explicit per-source barrel imports.
//
// Today only youtube_channel is wired; future per-platform adapters add
// entries here.
import type { DataSourceAdapter, SourceKind } from "./adapter.js";
import { youtubeAdapter } from "./youtube/server/index.js";

const registry = new Map<SourceKind, DataSourceAdapter>([["youtube_channel", youtubeAdapter]]);

export function getAdapter(kind: SourceKind): DataSourceAdapter {
  const adapter = registry.get(kind);
  if (adapter === undefined) {
    throw new Error(`No adapter registered for kind=${kind as string}`);
  }
  return adapter;
}

/** Whether an adapter is registered for the given kind. Used by cross-source
 *  code that needs to call optional adapter methods (validateEventInput,
 *  fetchEventPreviewMetadata, etc.) without throwing on yet-to-be-implemented
 *  kinds. */
export function hasAdapter(kind: SourceKind): boolean {
  return registry.has(kind);
}

/** Iterating order is registration order — load-bearing for the
 *  first-match-wins URL router. */
export const allAdapters: DataSourceAdapter[] = Array.from(registry.values());
