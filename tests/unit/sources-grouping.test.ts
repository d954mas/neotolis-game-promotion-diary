// Regression test for the user's blocker: an `instagram_account` source must
// appear in the /sources list. Before the kind-display refactor, the page's
// local PLATFORM_ORDER omitted instagram_account, so the grouping loop
// `continue`-skipped it (silent drop). The grouping derivation now reads from
// the central config (sourcePlatformGroupKey + SOURCE_PLATFORM_GROUPS); this
// test replicates the page's grouping over the config helpers and asserts an
// IG source buckets into a visible "Instagram" group.
//
// Replicating the page's pure grouping reducer here (rather than mounting the
// whole +page.svelte, which pulls $app/navigation + loader data) keeps the
// test tight while exercising the exact config-driven logic the page uses.

import { describe, it, expect } from "vitest";
import {
  SOURCE_PLATFORM_GROUPS,
  sourcePlatformGroupKey,
} from "../../src/lib/sources/kind-display.js";
import type { SourceKind } from "../../src/lib/sources/adapter.js";

type Source = { id: string; kind: SourceKind; displayName: string | null };
type Group = { key: string; order: number; label: string; items: Source[] };

// Mirror of /sources/+page.svelte's groups derivation (config-driven).
function deriveGroups(active: Source[]): Group[] {
  const out: Group[] = [];
  const keyToGroup = new Map<string, Group>();
  for (const s of active) {
    const groupKey = sourcePlatformGroupKey(s.kind);
    let g = keyToGroup.get(groupKey);
    if (!g) {
      const def = SOURCE_PLATFORM_GROUPS.find((p) => p.key === groupKey)!;
      g = { key: def.key, order: def.order, label: def.label, items: [] };
      keyToGroup.set(groupKey, g);
      out.push(g);
    }
    g.items.push(s);
  }
  return out.sort((a, b) => a.order - b.order);
}

describe("/sources grouping (config-driven)", () => {
  it("renders an instagram_account source in an Instagram group (the user's bug)", () => {
    const groups = deriveGroups([{ id: "s1", kind: "instagram_account", displayName: "Nat Geo" }]);
    const ig = groups.find((g) => g.label === "Instagram");
    expect(ig, "instagram_account must produce an Instagram group").toBeDefined();
    expect(ig!.items.map((s) => s.id)).toEqual(["s1"]);
  });

  it("collapses reddit_account + reddit_subreddit into one Reddit group", () => {
    const groups = deriveGroups([
      { id: "a", kind: "reddit_account", displayName: "u/dev" },
      { id: "b", kind: "reddit_subreddit", displayName: "r/gamedev" },
    ]);
    const reddit = groups.filter((g) => g.label === "Reddit");
    expect(reddit).toHaveLength(1);
    expect(reddit[0]!.items.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("orders groups by the config platform order and drops nothing", () => {
    const groups = deriveGroups([
      { id: "i", kind: "instagram_account", displayName: "ig" },
      { id: "y", kind: "youtube_channel", displayName: "yt" },
      { id: "r", kind: "reddit_account", displayName: "rd" },
    ]);
    // youtube(0) < reddit(1) < instagram(2) per the config order.
    expect(groups.map((g) => g.label)).toEqual(["YouTube", "Reddit", "Instagram"]);
    // No source silently skipped.
    expect(groups.flatMap((g) => g.items.map((s) => s.id)).sort()).toEqual(["i", "r", "y"]);
  });
});
