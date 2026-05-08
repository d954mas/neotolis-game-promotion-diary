// Phase 03.0.1 Plan 10 — POST /api/sources/:id/refresh-content endpoint.
//
// Activates the 7 it.skip scaffolds from Plan 01 (Wave 0). The endpoint
// dispatches via getAdapter(source.kind).backfillSource; for YouTube the
// adapter enqueues a youtube.backfill.user job. pg-boss is mocked the
// same way refresh-now.test.ts / sources-backfill.test.ts do — vi.mock
// over queue-client.js with a sentJobs accumulator — so the test runs
// without a live boss schema.
//
// AGENTS.md invariants pinned here:
//   1. Tenant scoping — getSourceById(userId, params.id) is the entry
//      point; no unfiltered query.
//   2. Cross-tenant 404 not 403 — body never contains 'forbidden' or
//      'permission' (PRIV-01 / AGENTS.md invariant 2).
//   3. Anonymous-401 — sweep + per-route assertion both fire (the sweep
//      lives in tests/integration/anonymous-401.test.ts; the explicit
//      assertion is in this file).
//   4. Audit INSERT-only — writeAudit fires after the enqueue with
//      action 'source.refresh_content_requested'; metadata carries
//      source_id, kind, queue, job_id.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";

const sentJobs: Array<{
  queue: string;
  data: Record<string, unknown>;
  options: Record<string, unknown>;
}> = [];

vi.mock("../../src/lib/server/queue-client.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getBoss: async () => ({
      send: async (
        queue: string,
        data: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => {
        sentJobs.push({ queue, data, options });
        return "mock-job-id";
      },
    }),
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { createApp } = await import("../../src/lib/server/http/app.js");
const { createSource } = await import("../../src/lib/server/services/data-sources.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

/**
 * Seed a youtube_channel source via createSource with a /channel/UC… URL so
 * the canonicalizer takes the synchronous path (no videos.list lookup, no
 * network). Returns the row.
 */
async function seedYoutubeSource(
  userId: string,
  opts: { handle?: string; autoImport?: boolean } = {},
): Promise<typeof dataSources.$inferSelect> {
  const handle =
    opts.handle ?? `https://www.youtube.com/channel/UC${uniq()}${uniq().slice(0, 8)}aa`;
  return createSource(
    userId,
    {
      kind: "youtube_channel",
      handleUrl: handle,
      isOwnedByMe: true,
      autoImport: opts.autoImport ?? false,
    },
    "127.0.0.1",
  );
}

describe("POST /api/sources/:id/refresh-content — Phase 03.0.1 Plan 10", () => {
  beforeEach(() => {
    sentJobs.length = 0;
  });

  it("Plan 03.0.1-10: authenticated + own source returns 202 with body { enqueued: true, queue: 'youtube.backfill.user', jobId }", async () => {
    const app = createApp();
    const u = await seedUserDirectly({ email: `rc-ok-${uniq()}@test.local` });
    const src = await seedYoutubeSource(u.id);

    const res = await app.request(`/api/sources/${src.id}/refresh-content`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      enqueued: true,
      queue: "youtube.backfill.user",
      jobId: "mock-job-id",
    });

    // pg-boss send was called with the right payload.
    const enqueues = sentJobs.filter((j) => j.queue === "youtube.backfill.user");
    expect(enqueues).toHaveLength(1);
    const job = enqueues[0]!;
    expect(job.data).toMatchObject({
      sourceId: src.id,
      userId: u.id,
      origin: "user",
    });
    // singletonKey dedups concurrent clicks within ~5min.
    expect((job.options as { singletonKey?: string }).singletonKey).toBe(`backfill-${src.id}`);
    // priority=1 puts user-initiated jobs ahead of cron polls (D-09 reserve).
    expect((job.options as { priority?: number }).priority).toBe(1);
  });

  it("Plan 03.0.1-10: anonymous POST → 401 unauthorized (auth gate fires before route)", async () => {
    const app = createApp();
    const res = await app.request("/api/sources/fixture-id/refresh-content", { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    // No enqueue happened.
    expect(sentJobs.length).toBe(0);
  });

  it("Plan 03.0.1-10: cross-tenant POST returns 404; body NOT containing 'forbidden' or 'permission' (PRIV-01)", async () => {
    const app = createApp();
    const a = await seedUserDirectly({ email: `rc-xtA-${uniq()}@test.local` });
    const b = await seedUserDirectly({ email: `rc-xtB-${uniq()}@test.local` });
    const src = await seedYoutubeSource(a.id);

    const res = await app.request(`/api/sources/${src.id}/refresh-content`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${b.signedSessionCookieValue}` },
    });

    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text.toLowerCase()).not.toContain("forbidden");
    expect(text.toLowerCase()).not.toContain("permission");
    expect(JSON.parse(text)).toEqual({ error: "not_found" });
    // Cross-tenant short-circuits BEFORE enqueue (getSourceById throws
    // NotFoundError; backfillSource never runs).
    expect(sentJobs.length).toBe(0);
  });

  it("Plan 03.0.1-10: non-existent source id returns 404", async () => {
    const app = createApp();
    const u = await seedUserDirectly({ email: `rc-nope-${uniq()}@test.local` });

    const res = await app.request(`/api/sources/${uuidv7()}/refresh-content`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(sentJobs.length).toBe(0);
  });

  it("Plan 03.0.1-10: soft-deleted source returns 404 (deletedAt is invisible to refresh)", async () => {
    const app = createApp();
    const u = await seedUserDirectly({ email: `rc-sd-${uniq()}@test.local` });
    const src = await seedYoutubeSource(u.id);
    // Soft-delete directly via UPDATE so we don't pull in softDeleteSource's
    // audit trail (the assertion below counts audit rows for this user).
    await db
      .update(dataSources)
      .set({ deletedAt: new Date() })
      .where(and(eq(dataSources.userId, u.id), eq(dataSources.id, src.id)));

    const res = await app.request(`/api/sources/${src.id}/refresh-content`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(sentJobs.length).toBe(0);
  });

  it("Plan 03.0.1-10: unsupported source kind returns 422 'kind_not_yet_functional'", async () => {
    const app = createApp();
    const u = await seedUserDirectly({ email: `rc-unsup-${uniq()}@test.local` });

    // Direct INSERT bypassing createSource (which gates kind=reddit_account
    // out at write time per Phase 2.1 FUNCTIONAL_KINDS). The schema enum
    // accepts all 5 kinds; the registry has only 'youtube_channel' wired
    // in 03.0.1. This is the only way to exercise the 422 path before
    // Phase 03.1 lands the Reddit adapter.
    const id = uuidv7();
    await db.insert(dataSources).values({
      id,
      userId: u.id,
      kind: "reddit_account",
      handleUrl: `https://reddit.com/user/${uniq()}`,
      isOwnedByMe: false,
      autoImport: false,
      metadata: {},
    });

    const res = await app.request(`/api/sources/${id}/refresh-content`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("kind_not_yet_functional");
    // No enqueue happened — getAdapter throws before backfillSource runs.
    expect(sentJobs.length).toBe(0);
  });

  it("Plan 03.0.1-10: audit log records 'source.refresh_content_requested' with metadata.source_id / kind / queue / job_id", async () => {
    const app = createApp();
    const u = await seedUserDirectly({ email: `rc-audit-${uniq()}@test.local` });
    const src = await seedYoutubeSource(u.id);

    const res = await app.request(`/api/sources/${src.id}/refresh-content`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(202);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, u.id),
          eq(auditLog.action, "source.refresh_content_requested"),
        ),
      );
    expect(auditRows).toHaveLength(1);
    const row = auditRows[0]!;
    expect(row.metadata).toMatchObject({
      source_id: src.id,
      kind: "youtube_channel",
      queue: "youtube.backfill.user",
      job_id: "mock-job-id",
    });
  });
});
