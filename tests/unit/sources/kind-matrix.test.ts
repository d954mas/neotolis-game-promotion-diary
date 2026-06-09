import { describe, it, expect, vi, afterEach } from "vitest";
import type { SourceKind } from "$lib/sources/adapter.js";

// buildKindMatrix derivation guard (F1).
//
// buildKindMatrix is the SINGLE source of truth both /sources loaders call so
// the AddSourceModal and the /sources/new fallback can never drift in which
// kinds they offer. Before F1 each loader hand-maintained a parallel literal
// kindMatrix array — a telegram/twitter/discord `disabled` flag could drift in
// one file and not the other (the SOURCE-REFERENCE §12 "silent two-file drift"
// failure mode applied to the Add-Source matrix). This test pins every entry's
// derived state to the cross-source inputs so that drift fails HERE:
//
//   - `disabled` / `disabledReason` derive from FUNCTIONAL_KINDS (data-sources.ts)
//     + per-adapter observability.auth.isOperatorConfigured (registry).
//   - telegram_channel → enabled with NO hardcoded literal (it's functional +
//     its adapter reports isOperatorConfigured === true).
//   - twitter_account / discord_server → disabled "not-built" (not functional).
//   - reddit / instagram → disabled "not-configured" when the adapter reports
//     !isOperatorConfigured, enabled when configured.
//
// Pattern: vi.doMock the registry + data-sources modules before a dynamic
// import so the derivation runs against controlled inputs (no real DB / env).
// Mirrors tests/unit/sources/reddit/credentials.test.ts.

// The kinds wired today (mirrors data-sources.ts FUNCTIONAL_KINDS). Telegram is
// in the set WITHOUT any per-kind literal — that's the F1 invariant under test.
const FUNCTIONAL: ReadonlySet<SourceKind> = new Set<SourceKind>([
  "youtube_channel",
  "reddit_account",
  "reddit_subreddit",
  "instagram_account",
  "telegram_channel",
]);

// Build a stub adapter exposing only the field buildKindMatrix reads.
function stubAdapter(isOperatorConfigured: boolean) {
  return { observability: { auth: { isOperatorConfigured } } };
}

/**
 * Load buildKindMatrix with the registry's isOperatorConfigured controlled
 * per-kind. `configured` maps each functional DB kind to its adapter's
 * isOperatorConfigured; kinds absent from the map (twitter/discord) have no
 * adapter (hasAdapter === false), matching reality.
 */
async function loadMatrix(configured: Partial<Record<SourceKind, boolean>>) {
  vi.resetModules();
  vi.doMock("$lib/server/services/data-sources.js", () => ({ FUNCTIONAL_KINDS: FUNCTIONAL }));
  vi.doMock("$lib/sources/registry.js", () => ({
    hasAdapter: (k: SourceKind) => k in configured,
    getAdapter: (k: SourceKind) => {
      const v = configured[k];
      if (v === undefined) throw new Error(`no adapter for ${k}`);
      return stubAdapter(v);
    },
  }));
  const { buildKindMatrix } = await import("$lib/sources/kind-matrix.js");
  return buildKindMatrix();
}

// Operator-configured world: Reddit + Instagram env set, YouTube + Telegram
// always-on. (Twitter / Discord are not functional → no adapter.)
const ALL_CONFIGURED: Partial<Record<SourceKind, boolean>> = {
  youtube_channel: true,
  reddit_account: true,
  instagram_account: true,
  telegram_channel: true,
};

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("$lib/server/services/data-sources.js");
  vi.doUnmock("$lib/sources/registry.js");
  vi.restoreAllMocks();
});

describe("buildKindMatrix — derives disabled/statusKey from the single source of truth", () => {
  it("telegram_channel comes out ENABLED with no per-kind literal (functional + adapter configured)", async () => {
    const matrix = await loadMatrix(ALL_CONFIGURED);
    const tg = matrix.find((e) => e.value === "telegram_channel");
    expect(tg).toBeDefined();
    expect(tg!.disabled).toBe(false);
    expect(tg!.disabledReason).toBeNull();
    expect(tg!.statusKey).toBeNull();
  });

  it("youtube_channel is enabled (functional, no config gate)", async () => {
    const matrix = await loadMatrix(ALL_CONFIGURED);
    const yt = matrix.find((e) => e.value === "youtube_channel");
    expect(yt!.disabled).toBe(false);
    expect(yt!.disabledReason).toBeNull();
    expect(yt!.statusKey).toBeNull();
  });

  it("twitter_account + discord_server are disabled 'not-built' (not in FUNCTIONAL_KINDS)", async () => {
    const matrix = await loadMatrix(ALL_CONFIGURED);
    const tw = matrix.find((e) => e.value === "twitter_account");
    const dc = matrix.find((e) => e.value === "discord_server");
    expect(tw!.disabled).toBe(true);
    expect(tw!.disabledReason).toBe("not-built");
    expect(tw!.statusKey).toBe("source_kind_status_twitter_account");
    expect(dc!.disabled).toBe(true);
    expect(dc!.disabledReason).toBe("not-built");
    expect(dc!.statusKey).toBe("source_kind_status_discord_server");
  });

  it("reddit + instagram are ENABLED when their adapter reports isOperatorConfigured", async () => {
    const matrix = await loadMatrix(ALL_CONFIGURED);
    const rd = matrix.find((e) => e.value === "reddit");
    const ig = matrix.find((e) => e.value === "instagram_account");
    expect(rd!.disabled).toBe(false);
    expect(rd!.disabledReason).toBeNull();
    expect(ig!.disabled).toBe(false);
    expect(ig!.disabledReason).toBeNull();
  });

  it("reddit + instagram are disabled 'not-configured' when their adapter reports !isOperatorConfigured", async () => {
    const matrix = await loadMatrix({
      youtube_channel: true,
      reddit_account: false,
      instagram_account: false,
      telegram_channel: true,
    });
    const rd = matrix.find((e) => e.value === "reddit");
    const ig = matrix.find((e) => e.value === "instagram_account");
    expect(rd!.disabled).toBe(true);
    expect(rd!.disabledReason).toBe("not-configured");
    expect(rd!.statusKey).toBe("source_kind_status_reddit_account");
    expect(ig!.disabled).toBe(true);
    expect(ig!.disabledReason).toBe("not-configured");
    expect(ig!.statusKey).toBe("source_kind_status_instagram_account");
    // Telegram (also functional) stays enabled — the not-configured greying is
    // adapter-specific, not a blanket "everything off" when Reddit/IG are unset.
    const tg = matrix.find((e) => e.value === "telegram_channel");
    expect(tg!.disabled).toBe(false);
  });

  it("exposes exactly the six UI kinds in render order", async () => {
    const matrix = await loadMatrix(ALL_CONFIGURED);
    expect(matrix.map((e) => e.value)).toEqual([
      "youtube_channel",
      "reddit",
      "instagram_account",
      "twitter_account",
      "telegram_channel",
      "discord_server",
    ]);
  });
});
