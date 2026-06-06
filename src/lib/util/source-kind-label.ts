// Shared helper for the human-facing source-kind label (e.g. "YouTube" /
// "Reddit"). Thin re-export over the central kind-display config so SourceRow /
// FiltersSheet resolve through the SAME single source of truth as every other
// surface — a new SourceKind that's missing from SOURCE_KIND_DISPLAY is a
// compile error there, not a silently-wrong label here.

import { sourceKindDisplayLabel } from "$lib/sources/kind-display.js";
import type { SourceKind } from "$lib/sources/adapter.js";

export type { SourceKind };

export function sourceKindLabel(k: SourceKind): string {
  return sourceKindDisplayLabel(k);
}
