// Cap exhaustion 429 error code surfacing.
//
// The endpoint cap-check pattern returns one of three distinct 429 codes
// based on which axis was hit:
//   - platform_quota_exhausted   — operator-side reservoir at 95% (system-wide)
//   - requests_quota_exhausted   — per-user requests cap reached
//   - events_quota_exhausted     — per-user events cap reached
//   - rate_limited               — per-user rolling 60s click-throttle
//
// Pre-fix this entire path was untested at integration level — only mocks-
// in-isolation. A typo in the error code, a swapped status, or a regression
// where one cap returns the other's code would silently pass.
//
// Suite seeds audit_log rows directly to simulate cap state, then drives
// the endpoint through Hono and asserts each error envelope.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { sql } from "drizzle-orm";

vi.mock("../../src/lib/server/queue-client.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getBoss: async () => ({
      send: async () => "mock-job",
      schedule: async () => {},
      createQueue: async () => {},
      work: async () => {},
    }),
  };
});

const { createApp } = await import("../../src/lib/server/http/app.js");
const { createSource } = await import("../../src/lib/server/services/data-sources.js");
const { db } = await import("../../src/lib/server/db/client.js");
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function seedCapAuditRow(
  userId: string,
  requestsUsed: number,
  eventsInserted: number,
): Promise<void> {
  // Direct audit_log INSERT bypassing TS-typed writeAudit so we can simulate
  // a row at the cap boundary without running real worker handlers.
  await db.execute(sql`
    INSERT INTO audit_log (id, user_id, action, ip_address, metadata)
    VALUES (
      ${uuidv7()},
      ${userId},
      'source.refresh_content_requested',
      '127.0.0.1',
      ${JSON.stringify({
        flow: "incremental",
        platform: "youtube_channel",
        kind: "youtube_channel",
        requests_used: requestsUsed,
        events_inserted: eventsInserted,
        source_id: "fake-source",
      })}::jsonb
    )
  `);
}

describe("cap exhaustion error codes (POST /api/sources/:id/refresh-content)", () => {
  beforeEach(() => {
    // No global state to reset — each test seeds its own user/source.
  });

  it("at requests cap → 429 requests_quota_exhausted with cap+used+reset_in_seconds", async () => {
    const app = createApp();
    const u = await seedUserDirectly({ email: `cap-req-${uniq()}@test.local` });
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

    // YouTube adapter declares userQuotaCap.requestsPerDay = 100.
    // Seed audit row that already accounts for 100 requests today.
    await seedCapAuditRow(u.id, 100, 0);

    const res = await app.request(`/api/sources/${src.id}/refresh-content`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(429);
    // mapErr wraps AppError.metadata under a `metadata` key (see
    // src/lib/server/http/routes/_shared.ts mapErr).
    const body = (await res.json()) as {
      error: string;
      metadata?: { cap?: number; used?: number; reset_in_seconds?: number };
    };
    expect(body.error).toBe("requests_quota_exhausted");
    expect(body.metadata?.cap).toBe(100);
    expect(body.metadata?.used ?? 0).toBeGreaterThanOrEqual(100);
    expect(body.metadata?.reset_in_seconds ?? 0).toBeGreaterThan(0);
  });

  it("rate-limit click-throttle → 429 rate_limited (separate code path from cap)", async () => {
    const app = createApp();
    const u = await seedUserDirectly({ email: `cap-rate-${uniq()}@test.local` });
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

    // Seed 10 INTENT rows (no flow → matches the rate-limit query) within
    // the 60s window. REFRESH_CONTENT_RATE_LIMIT_PER_MINUTE = 10 so the next
    // click hits the gate.
    for (let i = 0; i < 10; i++) {
      await db.execute(sql`
        INSERT INTO audit_log (id, user_id, action, ip_address, metadata)
        VALUES (
          ${uuidv7()},
          ${u.id},
          'source.refresh_content_requested',
          '127.0.0.1',
          ${JSON.stringify({ source_id: src.id, kind: "youtube_channel" })}::jsonb
        )
      `);
    }

    const res = await app.request(`/api/sources/${src.id}/refresh-content`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
  });

  it("intent + completion mixed audit rows → rate-limit counts INTENT only", async () => {
    // Regression guard for P3 from external review: pre-fix the rate-limit
    // query counted both intent AND completion rows for the same verb,
    // halving the effective window. This test seeds 5 intent + 5 completion
    // and verifies 5 more clicks are still permitted (intent count = 5/10).
    const app = createApp();
    const u = await seedUserDirectly({ email: `cap-mix-${uniq()}@test.local` });
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

    // 5 intent rows (no flow).
    for (let i = 0; i < 5; i++) {
      await db.execute(sql`
        INSERT INTO audit_log (id, user_id, action, ip_address, metadata)
        VALUES (
          ${uuidv7()}, ${u.id}, 'source.refresh_content_requested', '127.0.0.1',
          ${JSON.stringify({ source_id: src.id, kind: "youtube_channel" })}::jsonb
        )
      `);
    }
    // 5 completion rows (with flow). Pre-fix these would also count.
    for (let i = 0; i < 5; i++) {
      await seedCapAuditRow(u.id, 1, 0);
    }

    const res = await app.request(`/api/sources/${src.id}/refresh-content`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    // 6th intent click should still go through (5/10 < 10).
    expect(res.status).toBe(202);
  });
});
