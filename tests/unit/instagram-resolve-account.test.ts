// resolveAccount profile-parsing regression (Phase 08 add-source bug).
//
// The LIVE profile shape (real ScrapeCreators key, `nasa`, 2026-06-06) nests
// the user object at `data.user`, NOT at `data`:
//   { success, credits_remaining, status, data: { user: { id, username, full_name, ... } } }
// The original code read `body.data ?? body.user`, so `user` pointed at the
// `{ user: {...} }` WRAPPER (no `id`) → accountId always null → resolveAccount
// returned null → every "add Instagram account" failed with
// "Could not resolve that Instagram handle". This test pins the real nesting.
//
// We mock the http boundary (instagramFetch) so no live network call happens;
// the provider's endpoint/cursor choice + parsing is the unit under test.
import { describe, it, expect, vi, beforeEach } from "vitest";

const instagramFetch = vi.fn();
vi.mock("$lib/sources/instagram/server/http.js", () => ({
  instagramFetch: (...args: unknown[]): unknown => instagramFetch(...args),
}));

import { scrapeCreatorsProvider } from "$lib/sources/instagram/server/provider/scrapecreators.js";

// Minimal Response-like stub — resolveAccount only calls `.json()`.
function jsonResponse(body: unknown): { json: () => Promise<unknown> } {
  return { json: async () => body };
}

describe("scrapeCreatorsProvider.resolveAccount (profile parsing)", () => {
  beforeEach(() => {
    instagramFetch.mockReset();
  });

  it("reads the real data.user nesting → { accountId, displayName, ...entity fields }", async () => {
    // The exact live shape (trimmed) plus the entity-metadata fields read off the
    // SAME response (no extra fetch) to populate instagram_accounts.
    instagramFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        credits_remaining: 91,
        status: "ok",
        data: {
          user: {
            id: "528817151",
            username: "nasa",
            full_name: "NASA",
            profile_pic_url: "https://cdn/nasa.jpg",
            follower_count: 98000000,
          },
        },
      }),
    );

    const result = await scrapeCreatorsProvider.resolveAccount("instagram", "nasa");

    // Pre-fix this is null (user pointed at the { user } wrapper, no id).
    expect(result).toEqual({
      accountId: "528817151",
      displayName: "NASA",
      username: "nasa",
      fullName: "NASA",
      avatarUrl: "https://cdn/nasa.jpg",
      followerCount: 98000000,
    });
  });

  it("falls back to username for displayName + edge_followed_by.count for followers; null avatar/follower when absent", async () => {
    instagramFetch.mockResolvedValueOnce(
      jsonResponse({
        data: { user: { id: "42", username: "handleonly", edge_followed_by: { count: 7 } } },
      }),
    );

    const result = await scrapeCreatorsProvider.resolveAccount("instagram", "handleonly");

    expect(result).toEqual({
      accountId: "42",
      displayName: "handleonly",
      username: "handleonly",
      fullName: null,
      avatarUrl: null,
      followerCount: 7,
    });
  });

  it("returns null for the not-found shape (data: null)", async () => {
    instagramFetch.mockResolvedValueOnce(jsonResponse({ success: false, data: null }));

    const result = await scrapeCreatorsProvider.resolveAccount("instagram", "ghost");

    expect(result).toBeNull();
  });

  it("returns null when data.user is null", async () => {
    instagramFetch.mockResolvedValueOnce(jsonResponse({ data: { user: null } }));

    const result = await scrapeCreatorsProvider.resolveAccount("instagram", "ghost");

    expect(result).toBeNull();
  });
});
