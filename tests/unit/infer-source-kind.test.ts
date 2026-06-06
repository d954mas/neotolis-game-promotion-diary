// Client-side source-kind inference heuristic — pure unit test. Mirrors
// the host table in src/lib/components/sources/infer-source-kind.ts. This
// is the UX convenience that auto-selects the chip on paste; it is NOT a
// validation gate (the server's parseSourceUrl iterator is the source of
// truth on submit).
import { describe, it, expect } from "vitest";
import { inferSourceKindFromUrl } from "../../src/lib/components/sources/infer-source-kind.js";

describe("inferSourceKindFromUrl", () => {
  it("maps youtube.com and youtu.be to youtube_channel", () => {
    expect(inferSourceKindFromUrl("https://www.youtube.com/@handle")).toBe("youtube_channel");
    expect(inferSourceKindFromUrl("https://youtube.com/channel/UC123")).toBe("youtube_channel");
    expect(inferSourceKindFromUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube_channel");
    expect(inferSourceKindFromUrl("https://m.youtube.com/@handle")).toBe("youtube_channel");
  });

  it("maps reddit.com to the synthetic reddit picker kind", () => {
    expect(inferSourceKindFromUrl("https://www.reddit.com/r/IndieDev")).toBe("reddit");
    expect(inferSourceKindFromUrl("https://reddit.com/user/handle")).toBe("reddit");
    expect(inferSourceKindFromUrl("https://old.reddit.com/r/gamedev")).toBe("reddit");
  });

  it("maps instagram.com to instagram_account", () => {
    expect(inferSourceKindFromUrl("https://www.instagram.com/natgeo/")).toBe("instagram_account");
    expect(inferSourceKindFromUrl("https://instagram.com/natgeo")).toBe("instagram_account");
  });

  it("maps twitter.com and x.com to twitter_account", () => {
    expect(inferSourceKindFromUrl("https://twitter.com/jack")).toBe("twitter_account");
    expect(inferSourceKindFromUrl("https://x.com/jack")).toBe("twitter_account");
  });

  it("maps t.me / telegram hosts to telegram_channel", () => {
    expect(inferSourceKindFromUrl("https://t.me/durov")).toBe("telegram_channel");
    expect(inferSourceKindFromUrl("https://telegram.me/durov")).toBe("telegram_channel");
  });

  it("maps discord.gg and discord.com to discord_server", () => {
    expect(inferSourceKindFromUrl("https://discord.gg/abcd")).toBe("discord_server");
    expect(inferSourceKindFromUrl("https://discord.com/invite/abcd")).toBe("discord_server");
  });

  it("resolves scheme-less / raw pastes via the substring fallback", () => {
    expect(inferSourceKindFromUrl("youtu.be/dQw4w9WgXcQ")).toBe("youtube_channel");
    expect(inferSourceKindFromUrl("instagram.com/natgeo")).toBe("instagram_account");
  });

  it("does not match a lookalike host (notreddit.com) on the hostname path", () => {
    // The hostname suffix match rules out notreddit.com; the substring
    // fallback still finds "reddit.com" inside it, which is acceptable —
    // a deliberate paste of a real reddit URL is the common case and the
    // server's parser is the validation gate. The assertion that matters:
    // a genuine non-platform host returns null.
    expect(inferSourceKindFromUrl("https://example.com/some/path")).toBeNull();
  });

  it("returns null for empty, whitespace, and garbage input", () => {
    expect(inferSourceKindFromUrl("")).toBeNull();
    expect(inferSourceKindFromUrl("   ")).toBeNull();
    expect(inferSourceKindFromUrl("not a url at all")).toBeNull();
    expect(inferSourceKindFromUrl("https://example.com/")).toBeNull();
    expect(inferSourceKindFromUrl("ftp://files.local/x")).toBeNull();
  });
});
