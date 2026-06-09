import { describe, it, expect } from "vitest";
import { telegramHandleFromUrl } from "../../src/lib/util/telegram-handle.js";

// telegramHandleFromUrl is the ONE home for the t.me-URL "@handle" shape, shared
// by SourceRow (/sources list), the /sources/[id] heading, and the /feed card
// label so all three show the same "@durov" fallback when no channel title is
// resolved yet. Stored source handle URLs are always canonical https://t.me/<slug>
// (telegram/server/url.ts canonicalizes to t.me), so matching only t.me is enough.

describe("telegramHandleFromUrl", () => {
  it("derives @handle from a canonical t.me channel URL", () => {
    expect(telegramHandleFromUrl("https://t.me/durov")).toBe("@durov");
    expect(telegramHandleFromUrl("https://t.me/d954mas_make_games")).toBe("@d954mas_make_games");
  });

  it("handles the /s/ preview URL variant", () => {
    expect(telegramHandleFromUrl("https://t.me/s/durov")).toBe("@durov");
  });

  it("stops at a query string or fragment", () => {
    expect(telegramHandleFromUrl("https://t.me/durov?utm=x")).toBe("@durov");
    expect(telegramHandleFromUrl("https://t.me/durov#frag")).toBe("@durov");
  });

  it("returns null for a non-t.me URL (caller falls back to the raw value)", () => {
    expect(telegramHandleFromUrl("https://example.com/durov")).toBeNull();
    expect(telegramHandleFromUrl("https://youtube.com/@durov")).toBeNull();
  });

  it("returns null for empty / null / undefined input", () => {
    expect(telegramHandleFromUrl("")).toBeNull();
    expect(telegramHandleFromUrl(null)).toBeNull();
    expect(telegramHandleFromUrl(undefined)).toBeNull();
  });
});
