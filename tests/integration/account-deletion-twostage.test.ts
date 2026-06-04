// PRIV-04 (D-14) — two-stage account-deletion verification, end-to-end.
//
// VERIFICATION ONLY. No service / route / schema code is added or modified by
// this plan (06-05). The soft-delete → restore → purge backbone is fully
// shipped (account.ts softDeleteAccount/restoreAccount, purge-account.ts
// purgeAccount). The per-stage invariants already have dedicated coverage in
// account.test.ts (soft-delete cascade, restore-within-window, restore-410) and
// account-purge.test.ts (purge cascade, idempotency, cross-tenant integrity,
// audit-survives-purge). What was missing — and what this file adds — is the
// COMBINED two-stage walk end-to-end plus the load-bearing PRIV-04 audit
// guarantee, so the phase has one clear D-14 gate.
//
// The two stages (ROADMAP SC#2):
//   A. Reversible during the soft-delete window:
//      softDeleteAccount → children soft-deleted at the marker timestamp,
//      api_keys_steam hard-deleted, sessions gone, `account.deleted` audited;
//      restoreAccount WITHIN RETENTION_DAYS → children whose deletedAt === the
//      marker are restored, `account.restored` audited.
//   B. Purge after the retention window:
//      softDeleteAccount → purgeAccount → every content row gone, and the
//      deletion event(s) (`account.deleted` + `purge.completed`) SURVIVE in the
//      audit log — the act of deletion is itself permanently auditable.
//
// On the audit-log invariant (the one subtlety worth being precise about):
// ROADMAP SC#2 phrases the goal as "after purge, only the deletion event itself
// remains in the audit log." Taken literally that would require DELETEing the
// user's pre-deletion activity rows from audit_log — which is impossible by
// design: audit_log is INSERT-only and the application DB role has no
// UPDATE/DELETE grant on it (AGENTS.md §4; src/lib/server/audit.ts;
// audit-log.ts header). purgeAccount's cascade deliberately does NOT touch
// audit_log; migration 0011 dropped the audit_log.user_id FK precisely so the
// deletion audit row SURVIVES the user delete. So the code-true, strongest
// invariant — the one this test asserts — is: after purge the DELETION events
// survive and remain queryable, while all of the user's CONTENT rows are gone.
// That survival (not erasure) is the meaningful PRIV-04 guarantee: a user's
// deletion is permanently auditable and cannot be silently undone.

import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { user as userTable, session } from "../../src/lib/server/db/schema/auth.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { apiKeysSteam } from "../../src/lib/server/db/schema/api-keys-steam.js";
import { softDeleteAccount, restoreAccount } from "../../src/lib/server/services/account.js";
import { purgeAccount } from "../../src/lib/server/services/purge-account.js";
import { createGame } from "../../src/lib/server/services/games.js";
import { createSource } from "../../src/lib/server/services/data-sources.js";
import { createEvent } from "../../src/lib/server/services/events.js";
import { createSteamKey } from "../../src/lib/server/services/api-keys-steam.js";
import * as SteamApi from "../../src/lib/server/integrations/steam-api.js";
import { seedUserDirectly } from "./helpers.js";

describe("PRIV-04 two-stage account deletion (soft-delete → restore | purge)", () => {
  // createSteamKey calls validateSteamKey + fetchSteamAppDetails internally —
  // same mocks as account.test.ts / account-purge.test.ts.
  const validateSpy = vi.spyOn(SteamApi, "validateSteamKey").mockResolvedValue(true);
  const fetchSpy = vi.spyOn(SteamApi, "fetchSteamAppDetails").mockResolvedValue(null);
  void validateSpy;
  void fetchSpy;

  const uniq = (): string => Math.random().toString(36).slice(2, 10);

  it("Stage A — soft-delete then restore WITHIN the window reverses children and re-activates the account", async () => {
    const u = await seedUserDirectly({ email: `twostage-a-${uniq()}@test.local` });

    // Seed one row in each soft-cascade table + a steam key (hard-deleted).
    const game = await createGame(u.id, { title: `G-${uniq()}` }, "127.0.0.1");
    const source = await createSource(
      u.id,
      { kind: "youtube_channel", handleUrl: `https://www.youtube.com/@u${uniq()}` },
      "127.0.0.1",
    );
    const event = await createEvent(
      u.id,
      { gameIds: [game.id], kind: "twitter_post", occurredAt: new Date(), title: `T-${uniq()}` },
      "127.0.0.1",
    );
    await createSteamKey(
      u.id,
      { label: `K-${uniq()}`, plaintext: `STEAM-TWOSTAGE-A-${uniq()}AB12` },
      "127.0.0.1",
    );

    // ── Soft-delete ──────────────────────────────────────────────────────
    await softDeleteAccount(u.id, "127.0.0.1");

    const [userAfterDelete] = await db.select().from(userTable).where(eq(userTable.id, u.id));
    const markerTs = userAfterDelete!.deletedAt;
    expect(markerTs).not.toBeNull();

    // Children soft-deleted at the marker timestamp.
    const [gDel] = await db.select().from(games).where(eq(games.id, game.id));
    expect(gDel!.deletedAt!.getTime()).toBe(markerTs!.getTime());
    const [sDel] = await db.select().from(dataSources).where(eq(dataSources.id, source.id));
    expect(sDel!.deletedAt!.getTime()).toBe(markerTs!.getTime());
    const [eDel] = await db.select().from(events).where(eq(events.id, event.id));
    expect(eDel!.deletedAt!.getTime()).toBe(markerTs!.getTime());

    // api_keys_steam hard-deleted; sessions gone.
    expect(await db.select().from(apiKeysSteam).where(eq(apiKeysSteam.userId, u.id))).toHaveLength(
      0,
    );
    expect(await db.select().from(session).where(eq(session.userId, u.id))).toHaveLength(0);

    // account.deleted audit row written.
    const delAudits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "account.deleted")));
    expect(delAudits).toHaveLength(1);

    // ── Restore within window ────────────────────────────────────────────
    await restoreAccount(u.id, "127.0.0.1");

    const [userAfterRestore] = await db.select().from(userTable).where(eq(userTable.id, u.id));
    expect(userAfterRestore!.deletedAt).toBeNull();

    // Children whose deletedAt === marker are restored (deletedAt back to null).
    const [gRestored] = await db.select().from(games).where(eq(games.id, game.id));
    expect(gRestored!.deletedAt).toBeNull();
    const [sRestored] = await db.select().from(dataSources).where(eq(dataSources.id, source.id));
    expect(sRestored!.deletedAt).toBeNull();
    const [eRestored] = await db.select().from(events).where(eq(events.id, event.id));
    expect(eRestored!.deletedAt).toBeNull();

    // account.restored audit row written.
    const restoreAudits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "account.restored")));
    expect(restoreAudits).toHaveLength(1);
  });

  it("Stage B — soft-delete then purge removes all content rows; the deletion events survive in the audit log", async () => {
    const u = await seedUserDirectly({ email: `twostage-b-${uniq()}@test.local` });

    // Seed content + pre-deletion activity that emits audit rows (createGame /
    // createSource / createEvent / createSteamKey each write at least one).
    const game = await createGame(u.id, { title: `G-${uniq()}` }, "127.0.0.1");
    const source = await createSource(
      u.id,
      { kind: "youtube_channel", handleUrl: `https://www.youtube.com/@u${uniq()}` },
      "127.0.0.1",
    );
    const event = await createEvent(
      u.id,
      { gameIds: [game.id], kind: "twitter_post", occurredAt: new Date(), title: `T-${uniq()}` },
      "127.0.0.1",
    );
    await createSteamKey(
      u.id,
      { label: `K-${uniq()}`, plaintext: `STEAM-TWOSTAGE-B-${uniq()}AB12` },
      "127.0.0.1",
    );

    // Precondition: there ARE pre-deletion activity audit rows.
    const preDeletionActivity = await db.select().from(auditLog).where(eq(auditLog.userId, u.id));
    expect(preDeletionActivity.length).toBeGreaterThan(0);

    // ── Soft-delete (writes account.deleted) ─────────────────────────────
    await softDeleteAccount(u.id, "127.0.0.1");

    // ── Purge (immediate-purge path; writes purge.completed) ─────────────
    const result = await purgeAccount(u.id, { ignoreRetention: true });
    expect(result.purged).toBe(true);
    expect(result.rowCounts!.user).toBe(1);

    // Every CONTENT row for the user is gone.
    expect(await db.select().from(userTable).where(eq(userTable.id, u.id))).toHaveLength(0);
    expect(await db.select().from(games).where(eq(games.id, game.id))).toHaveLength(0);
    expect(await db.select().from(dataSources).where(eq(dataSources.id, source.id))).toHaveLength(
      0,
    );
    expect(await db.select().from(events).where(eq(events.id, event.id))).toHaveLength(0);
    expect(await db.select().from(apiKeysSteam).where(eq(apiKeysSteam.userId, u.id))).toHaveLength(
      0,
    );
    expect(await db.select().from(session).where(eq(session.userId, u.id))).toHaveLength(0);

    // ── The load-bearing PRIV-04 audit guarantee ─────────────────────────
    // The deletion EVENTS survive the purge and remain queryable by user_id.
    // (audit_log is INSERT-only; migration 0011 dropped the user FK so the
    // deletion rows outlive the user row — they are NOT cascade-deleted.)
    const surviving = await db.select().from(auditLog).where(eq(auditLog.userId, u.id));
    const survivingActions = surviving.map((a) => a.action);

    // Both deletion events are present.
    expect(survivingActions).toContain("account.deleted");
    expect(survivingActions).toContain("purge.completed");
    // Exactly one of each (no duplication; the deletion act is auditable once).
    expect(survivingActions.filter((a) => a === "account.deleted")).toHaveLength(1);
    expect(survivingActions.filter((a) => a === "purge.completed")).toHaveLength(1);

    // The purge.completed row carries the row_counts metadata proving the
    // cascade ran (this is the durable forensic record of the deletion).
    const [purgeRow] = surviving.filter((a) => a.action === "purge.completed");
    const meta = purgeRow!.metadata as { row_counts?: { user?: number } } | null;
    expect(meta?.row_counts?.user).toBe(1);
  });

  it("Stage B cross-tenant — user A's purge leaves user B's content AND audit rows untouched", async () => {
    const userA = await seedUserDirectly({ email: `twostage-xt-a-${uniq()}@test.local` });
    const userB = await seedUserDirectly({ email: `twostage-xt-b-${uniq()}@test.local` });

    const gameA = await createGame(userA.id, { title: `GA-${uniq()}` }, "127.0.0.1");
    void gameA;
    const gameB = await createGame(userB.id, { title: `GB-${uniq()}` }, "127.0.0.1");

    const bAuditsBefore = await db.select().from(auditLog).where(eq(auditLog.userId, userB.id));
    expect(bAuditsBefore.length).toBeGreaterThan(0);

    await softDeleteAccount(userA.id, "127.0.0.1");
    await purgeAccount(userA.id, { ignoreRetention: true });

    // User B's content survives.
    const [uB] = await db.select().from(userTable).where(eq(userTable.id, userB.id));
    expect(uB!.id).toBe(userB.id);
    const [gB] = await db.select().from(games).where(eq(games.id, gameB.id));
    expect(gB!.id).toBe(gameB.id);

    // User B's audit log is byte-for-byte intact.
    const bAuditsAfter = await db.select().from(auditLog).where(eq(auditLog.userId, userB.id));
    expect(bAuditsAfter.map((a) => a.id).sort()).toEqual(bAuditsBefore.map((a) => a.id).sort());
  });
});
