// Telegram URL parsing — unit tests (Phase 9 Plan 02, TDD).
//
// Two parsers under test (mirror reddit/server/url.ts + instagram/server/url.ts):
//   - telegramParsePostUrl   — EVENT paste flow. `t.me/<channel>/<id>` (and the
//                              tolerated `/s/` variant) → externalId
//                              "<channel>/<id>" (RESEARCH Q3 — message ids are
//                              per-channel sequential, NOT globally unique).
//                              A channel-only URL → null (a channel is a SOURCE).
//   - telegramParseSourceUrl — SOURCE registration flow. `@channel`, bare
//                              `channel`, `t.me/channel`, `t.me/s/channel` →
//                              telegram_channel. A post URL → null.
//
// Both parsers HOST-CHECK FIRST: a foreign host round-trips through `new URL()`
// but is rejected before pattern-matching — leaking a non-Telegram URL into the
// events table as kind=telegram_post would be a data-integrity bug.

import { describe, it, expect } from "vitest";
import { telegramParsePostUrl, telegramParseSourceUrl } from "$lib/sources/telegram/server/url.js";

describe("telegramParsePostUrl (event paste flow)", () => {
  it("t.me/<channel>/<id> → externalId '<channel>/<id>' (RESEARCH Q3)", () => {
    expect(telegramParsePostUrl("https://t.me/durov/505")).toEqual({
      kind: "telegram_post",
      externalId: "durov/505",
      metadata: { channel: "durov", messageId: "505" },
    });
  });

  it("tolerates the /s/ preview variant → same externalId", () => {
    expect(telegramParsePostUrl("https://t.me/s/durov/505")).toEqual({
      kind: "telegram_post",
      externalId: "durov/505",
      metadata: { channel: "durov", messageId: "505" },
    });
  });

  it("accepts the telegram.me / telegram.dog host aliases", () => {
    expect(telegramParsePostUrl("https://telegram.me/durov/505")?.externalId).toBe("durov/505");
    expect(telegramParsePostUrl("https://telegram.dog/durov/505")?.externalId).toBe("durov/505");
  });

  it("foreign host → null (host-check FIRST)", () => {
    expect(telegramParsePostUrl("https://example.com/durov/505")).toBeNull();
  });

  it("channel-only URL (no message id) → null (a channel is a SOURCE)", () => {
    expect(telegramParsePostUrl("https://t.me/durov")).toBeNull();
  });

  it("non-numeric message id → null", () => {
    expect(telegramParsePostUrl("https://t.me/durov/abc")).toBeNull();
  });

  it("garbage input → null", () => {
    expect(telegramParsePostUrl("not a url")).toBeNull();
  });
});

describe("telegramParseSourceUrl (source registration flow)", () => {
  const expected = {
    kind: "telegram_channel",
    handle: "durov",
    externalUrl: "https://t.me/durov",
  };

  it("@channel raw handle (before new URL())", () => {
    expect(telegramParseSourceUrl("@durov")).toEqual(expected);
  });

  it("bare channel name", () => {
    expect(telegramParseSourceUrl("durov")).toEqual(expected);
  });

  it("t.me/channel", () => {
    expect(telegramParseSourceUrl("https://t.me/durov")).toEqual(expected);
  });

  it("t.me/s/channel (preview URL is a valid channel paste)", () => {
    expect(telegramParseSourceUrl("https://t.me/s/durov")).toEqual(expected);
  });

  it("telegram.me / telegram.dog host aliases", () => {
    expect(telegramParseSourceUrl("https://telegram.me/durov")).toEqual(expected);
    expect(telegramParseSourceUrl("https://telegram.dog/durov")).toEqual(expected);
  });

  it("a post URL → null (caller meant parsePostUrl)", () => {
    expect(telegramParseSourceUrl("https://t.me/durov/505")).toBeNull();
  });

  it("a /s/ post URL → null (caller meant parsePostUrl)", () => {
    expect(telegramParseSourceUrl("https://t.me/s/durov/505")).toBeNull();
  });

  it("foreign host → null (host-check FIRST)", () => {
    expect(telegramParseSourceUrl("https://example.com/durov")).toBeNull();
  });

  it("a raw handle with a slash is not a bare handle (falls through to URL parse → null)", () => {
    expect(telegramParseSourceUrl("durov/505")).toBeNull();
  });
});
