import { describe, it, expect } from "vitest";
import {
  telegramChannelHandleLabel,
  type CardSourceLite,
} from "../../src/lib/components/feed/parts/derive-card-data.js";

// telegramChannelHandleLabel is the Telegram feed card's source label. Precedence
// (mirrors SourceRow.handleLabel so /feed and /sources agree):
//   channelTitle (telegram_channels entity, FK at read) → displayName (legacy
//   user label) → @handle from the t.me URL → raw URL (last resort). The @handle
//   fallback keeps a not-yet-polled channel (no entity title) from showing the
//   bare URL.

const base: CardSourceLite = {
  id: "s1",
  displayName: null,
  handleUrl: "https://t.me/d954mas_make_games",
  channelTitle: null,
};

describe("telegramChannelHandleLabel", () => {
  it("prefers the entity channelTitle over everything", () => {
    expect(
      telegramChannelHandleLabel({
        ...base,
        channelTitle: "d954mas | весело и просто делаю игры",
        displayName: "ignored",
      }),
    ).toBe("d954mas | весело и просто делаю игры");
  });

  it("falls back to displayName when channelTitle is null", () => {
    expect(telegramChannelHandleLabel({ ...base, displayName: "My label" })).toBe("My label");
  });

  it("falls back to @handle (not the raw URL) for a not-yet-polled channel", () => {
    // The @handle URL-parsing edge cases live in telegram-handle.test.ts; here we
    // only assert this label COMPOSES that fallback after the title/displayName
    // precedence.
    expect(telegramChannelHandleLabel(base)).toBe("@d954mas_make_games");
  });

  it("returns the raw value when the URL is not a t.me link (defensive last resort)", () => {
    expect(telegramChannelHandleLabel({ ...base, handleUrl: "https://example.com/x" })).toBe(
      "https://example.com/x",
    );
  });

  it("returns '' for a null source", () => {
    expect(telegramChannelHandleLabel(null)).toBe("");
  });
});
