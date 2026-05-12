// mapErr sanitization regression guard.
//
// POST /api/sources/:id/refresh-content uses mapErr (src/lib/server/http/routes/_shared.ts)
// to translate any unhandled error into the wire envelope. mapErr's contract:
//
//   - AppError → {error: code, metadata?}        — known recoverable, route ships
//                                                   the error.metadata explicitly.
//   - NotFoundError → {error: "not_found"}        — fixed envelope.
//   - anything else → {error: "internal_server_error"} status 500.
//
// The fixed-envelope branch is load-bearing: a runtime exception during
// adapter.backfillSource (rate-limit-flexible reservoir reject, pg-boss
// internal error, transient DB error) must NOT leak its `err.message` /
// `err.stack` into the response body. The body for a 500 path is the
// literal `{"error":"internal_server_error"}` string and nothing else;
// the route logs the raw err via `logger.error({err, route}, ...)` server-
// side only.
//
// This test fakes a backfillSource that throws a deliberately PII-shaped
// error message (`apiKey=<base64>`, `secret_ct=<hex>`, `wrappedDek=<...>`)
// and asserts:
//   1. status === 500
//   2. body === '{"error":"internal_server_error"}' EXACTLY (no metadata leak)
//   3. body lowercase contains NONE of the leak-shaped substrings
//
// Mocking strategy: vi.mock on the queue-client module so getBoss().send
// throws the leak-shaped error. The route's adapter.backfillSource
// (composed in src/lib/sources/youtube/server/index.ts) calls boss.send
// directly, so a throwing send is the closest simulation of "adapter
// runtime error mid-call" without writing a fake adapter.

import { describe, it, expect, vi, beforeEach } from "vitest";

const LEAK_MARKERS = [
  "apiKey=AKfycbz_ENCRYPTED_PROBE_PII_BASE64_LIKE_DO_NOT_LEAK",
  "secret_ct=deadbeefcafebabe1234567890abcdef",
  "wrappedDek=base64-shaped-PROBE-pii-token-x9y8z7",
] as const;

vi.mock("../../src/lib/server/queue-client.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getBoss: async () => ({
      send: async () => {
        // Concatenate every leak marker into the message so the assertion
        // below catches any field-name shape, not just one. A real bug
        // path leaks one of these via Error.message → JSON.stringify(err)
        // → res.body. mapErr's fixed envelope keeps them all out.
        throw new Error(
          `chargedFetch failed: ${LEAK_MARKERS.join("; ")} (probe error — never seen by client)`,
        );
      },
    }),
  };
});

const { createApp } = await import("../../src/lib/server/http/app.js");
const { createSource } = await import("../../src/lib/server/services/data-sources.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

describe("POST /api/sources/:id/refresh-content — adapter throw path sanitization", () => {
  beforeEach(() => {
    // No global state to reset; the throwing mock fires every send call.
  });

  it("adapter.backfillSource throws → 500 envelope contains NO leak-shaped substrings", async () => {
    const app = createApp();
    const u = await seedUserDirectly({ email: `rc-leak-${uniq()}@test.local` });
    const src = await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/UC${uniq()}${uniq().slice(0, 8)}aa`,
        isOwnedByMe: true,
        autoImport: false,
      },
      "127.0.0.1",
    );

    const res = await app.request(`/api/sources/${src.id}/refresh-content`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });

    // Wire envelope is exactly the fixed 500 shape — no err.message,
    // no err.stack, no metadata leak.
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toBe('{"error":"internal_server_error"}');

    // Per-marker assertion — defense-in-depth in case the JSON shape
    // changes. The leak markers are case-sensitive base64/hex shapes;
    // we lowercase both sides for the field-name patterns ('apikey',
    // 'secret_ct', 'wrappeddek') as those would survive a `.toLowerCase()`
    // accidental write at the boundary.
    const textLower = text.toLowerCase();
    for (const marker of LEAK_MARKERS) {
      expect(textLower).not.toContain(marker.toLowerCase());
    }
    // Common credential field-name shapes — explicit per-name asserts so
    // any future leak vector (e.g. JSON.stringify(err) accidentally
    // included) trips the closest-named assertion.
    expect(textLower).not.toContain("apikey");
    expect(textLower).not.toContain("secret_ct");
    expect(textLower).not.toContain("wrappeddek");
    expect(textLower).not.toContain("dek=");
    // Stack-trace shape — node Error.stack lines start with "at " followed
    // by a function/file ref; assert absent in the response body.
    expect(text).not.toContain("\n    at ");
    expect(text).not.toContain("chargedFetch failed");
  });
});
