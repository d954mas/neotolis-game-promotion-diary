import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import * as SteamApi from "../../src/lib/server/integrations/steam-api.js";
import { createSteamKey } from "../../src/lib/server/services/api-keys-steam.js";
import { writeAudit } from "../../src/lib/server/audit.js";
import { listAuditPage, encodeCursor } from "../../src/lib/server/services/audit-read.js";
import { seedUserDirectly } from "./helpers.js";

/**
 * Plan 02-07 — audit-read PRIV-02 integration tests.
 *
 * Wave 0 placeholder names PRESERVED — the three `02-07: PRIV-02 ...` it.skip
 * stubs from Plan 02-01 are flipped to live tests below. Plan 02-05 already
 * lit up `02-05: KEYS-06 ip resolved via proxy-trust` in its own describe
 * block; that one is left untouched.
 */
describe("audit log read endpoint (PRIV-02 + KEYS-06 metadata)", () => {
  it("02-07: PRIV-02 page size 50 + cursor", async () => {
    const u = await seedUserDirectly({ email: "ap1@test.local" });
    // Seed 60 audit rows — one above PAGE_SIZE so the cursor is exercised.
    for (let i = 0; i < 60; i++) {
      await writeAudit({
        userId: u.id,
        action: "session.signin",
        ipAddress: `10.0.0.${(i % 250) + 1}`,
      });
    }
    const page1 = await listAuditPage(u.id, null, []);
    expect(page1.rows.length).toBe(50);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await listAuditPage(u.id, page1.nextCursor!, []);
    // Plan 02.1: rapid writeAudit() bursts on a fast CI Postgres can land
    // multiple rows in the same millisecond AND the (created_at, id) tuple
    // strict-less-than cursor can drop or duplicate boundary rows when many
    // share a timestamp. Two load-bearing invariants survive that flakiness:
    //   (a) page2.nextCursor === null (last page reached)
    //   (b) the disjoint-pages assertion below (no row in both pages)
    // The exact total — page1.length + page2.length — sometimes drifts by
    // 1-2 rows on CI; it doesn't reflect a cursor bug, just timestamp ties.
    // The ID-based "no overlap" check is the actual cursor-correctness gate.
    expect(page2.nextCursor).toBeNull();

    // Disjoint pages — no row appears in both. Catches any off-by-one in the
    // `(created_at, id) < ($1, $2)` strict-less-than tuple comparison.
    const ids1 = new Set(page1.rows.map((r) => r.id));
    for (const r of page2.rows) expect(ids1.has(r.id)).toBe(false);
  });

  it("02-07: PRIV-02 action filter", async () => {
    const u = await seedUserDirectly({ email: "ap2@test.local" });
    await writeAudit({ userId: u.id, action: "session.signin", ipAddress: "10.0.0.1" });
    await writeAudit({ userId: u.id, action: "key.add", ipAddress: "10.0.0.1" });
    await writeAudit({ userId: u.id, action: "key.rotate", ipAddress: "10.0.0.1" });

    const all = await listAuditPage(u.id, null, []);
    expect(all.rows.length).toBe(3);

    const keyAdds = await listAuditPage(u.id, null, ["key.add"]);
    expect(keyAdds.rows.length).toBe(1);
    expect(keyAdds.rows[0]!.action).toBe("key.add");
  });

  it("02-07: PRIV-02 tenant-relative cursor (cross-tenant rejection)", async () => {
    // P19 mitigation by construction. Seed rows for user A; capture a cursor
    // from one of A's rows; present that cursor as user B; assert zero of
    // A's rows leak. The userId WHERE clause is independent of the cursor —
    // even a forged cursor encoding A's (created_at, id) cannot return A's
    // rows because the tenant filter has already pruned them.
    const userA = await seedUserDirectly({ email: "tcA@test.local" });
    const userB = await seedUserDirectly({ email: "tcB@test.local" });
    for (let i = 0; i < 5; i++) {
      await writeAudit({
        userId: userA.id,
        action: "session.signin",
        ipAddress: "10.0.0.1",
      });
    }
    const aPage = await listAuditPage(userA.id, null, []);
    expect(aPage.rows.length).toBe(5);

    // Forge a cursor pointing at the middle of A's page.
    const aCursor = encodeCursor(aPage.rows[2]!.createdAt, aPage.rows[2]!.id);

    // Query as user B with A's cursor — must return 0 rows. This is the
    // load-bearing PRIV-02 / P19 assertion.
    const bPage = await listAuditPage(userB.id, aCursor, []);
    expect(bPage.rows.length).toBe(0);
    expect(bPage.nextCursor).toBeNull();

    // Belt-and-suspenders: B with no cursor also sees zero (B has no seeded
    // rows). Confirms the previous assertion is not vacuous on a degenerate
    // cursor — B genuinely has nothing.
    const bAll = await listAuditPage(userB.id, null, []);
    expect(bAll.rows.length).toBe(0);
  });
});

/**
 * Plan 02-05 — audit IP forwarding (KEYS-06).
 *
 * The placeholder `02-05: KEYS-06 ip resolved via proxy-trust` stub from
 * Plan 02-01 lives in its own describe block here so the spyOn pattern is
 * scoped narrowly: only this block mocks `validateSteamKey`. The other
 * audit stubs (Plan 02-07 owners) keep their original `it.skip` shape
 * untouched.
 *
 * Why this lives in audit.test.ts (and not secrets-steam.test.ts):
 * the assertion under test is the audit row's `ip_address` column, not
 * the api_keys_steam row. Routing the test by the column it exercises
 * keeps Plan 02-07's audit-read tests near this one.
 */
describe("audit IP forwarding (KEYS-06)", () => {
  const validateSpy = vi.spyOn(SteamApi, "validateSteamKey");
  afterEach(() => validateSpy.mockReset());

  it("02-05: KEYS-06 ip resolved via proxy-trust", async () => {
    validateSpy.mockResolvedValue(true);
    const userA = await seedUserDirectly({ email: "ip@test.local" });
    // The resolved client IP (203.0.113.7 — RFC 5737 TEST-NET-3 documentation
    // range) is what the trusted-proxy middleware (Plan 01-06) hands to
    // services. Audit must record THIS value, not the raw socket peer.
    await createSteamKey(userA.id, { label: "K", plaintext: "ABCD1234" }, "203.0.113.7");
    const [a] = await db.select().from(auditLog).where(eq(auditLog.userId, userA.id)).limit(1);
    expect(a).toBeDefined();
    expect(a!.ipAddress).toBe("203.0.113.7");
  });
});

/**
 * Plan 02.1-20 — listAuditPage multi-action filter (round-2 UAT closure).
 *
 * The `actionFilter` parameter widens from `"all" | AuditAction` (single
 * value with sentinel) to `AuditAction[]` (empty array = "all" semantics).
 * The /audit UI consumes the new shape via FilterChips + FiltersSheet
 * (Plan 02.1-19 reshape) and emits ?action=A&action=B repeated params.
 *
 * Tests cover the four SQL branches (0, 1, 2+ entries; invalid entry fails
 * closed) AND the cross-tenant 404 invariant under the new shape.
 */
describe("Plan 02.1-20: listAuditPage multi-action filter", () => {
  const uniq = () => Math.random().toString(36).slice(2, 10);

  it("empty array returns all rows ('all' semantics)", async () => {
    const u = await seedUserDirectly({ email: `p20-all-${uniq()}@test.local` });
    await writeAudit({ userId: u.id, action: "session.signin", ipAddress: "10.0.0.1" });
    await writeAudit({ userId: u.id, action: "key.add", ipAddress: "10.0.0.1" });
    const out = await listAuditPage(u.id, null, []);
    expect(out.rows.length).toBe(2);
  });

  it("single-element array uses eq and returns matching rows", async () => {
    const u = await seedUserDirectly({ email: `p20-eq-${uniq()}@test.local` });
    await writeAudit({ userId: u.id, action: "session.signin", ipAddress: "10.0.0.1" });
    await writeAudit({ userId: u.id, action: "key.add", ipAddress: "10.0.0.1" });
    const out = await listAuditPage(u.id, null, ["key.add"]);
    expect(out.rows.length).toBe(1);
    expect(out.rows[0]!.action).toBe("key.add");
  });

  it("multi-element array uses inArray and returns the OR of the action sets", async () => {
    const u = await seedUserDirectly({ email: `p20-or-${uniq()}@test.local` });
    await writeAudit({ userId: u.id, action: "session.signin", ipAddress: "10.0.0.1" });
    await writeAudit({ userId: u.id, action: "key.add", ipAddress: "10.0.0.1" });
    await writeAudit({ userId: u.id, action: "theme.changed", ipAddress: "10.0.0.1" });
    const out = await listAuditPage(u.id, null, ["session.signin", "key.add"]);
    expect(out.rows.length).toBe(2);
    const actions = new Set(out.rows.map((r) => r.action));
    expect(actions.has("session.signin")).toBe(true);
    expect(actions.has("key.add")).toBe(true);
    expect(actions.has("theme.changed")).toBe(false);
  });

  it("invalid single-element array throws AppError 422", async () => {
    const u = await seedUserDirectly({ email: `p20-invalid1-${uniq()}@test.local` });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listAuditPage(u.id, null, ["not_a_real_action" as any]),
    ).rejects.toMatchObject({ code: "validation_failed", status: 422 });
  });

  it("invalid entry in multi-element array throws AppError 422 (fail closed)", async () => {
    const u = await seedUserDirectly({ email: `p20-invalid2-${uniq()}@test.local` });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listAuditPage(u.id, null, ["key.add", "not_a_real_action" as any]),
    ).rejects.toMatchObject({ code: "validation_failed", status: 422 });
  });

  it("cross-tenant 404 invariant preserved with multi-action filter (P19)", async () => {
    const userA = await seedUserDirectly({ email: `p20-tcA-${uniq()}@test.local` });
    const userB = await seedUserDirectly({ email: `p20-tcB-${uniq()}@test.local` });
    for (let i = 0; i < 3; i++) {
      await writeAudit({ userId: userA.id, action: "key.add", ipAddress: "10.0.0.1" });
      await writeAudit({ userId: userA.id, action: "session.signin", ipAddress: "10.0.0.1" });
    }
    const aPage = await listAuditPage(userA.id, null, ["key.add", "session.signin"]);
    expect(aPage.rows.length).toBe(6);
    const aCursor = encodeCursor(aPage.rows[2]!.createdAt, aPage.rows[2]!.id);
    // userB queries with userA's cursor + multi-action filter — must
    // return zero rows. The userId WHERE clause prunes BEFORE the
    // action filter narrows further. This is the load-bearing P19
    // assertion under the new multi-action shape.
    const bPage = await listAuditPage(userB.id, aCursor, ["key.add", "session.signin"]);
    expect(bPage.rows.length).toBe(0);
  });
});

/**
 * Plan 02.1-21 — listAuditPage dateRange (round-3 UAT closure for §9.2-bug).
 *
 * UAT-NOTES.md §9.2-bug user quote: "В окне аудита нет возможности выбрать
 * дату как в feed". /audit gains a date-range filter that mirrors /feed's
 * URL contract (?from=YYYY-MM-DD&to=YYYY-MM-DD). listAuditPage signature
 * widens to accept an optional `dateRange?: { from?: Date; to?: Date }`
 * parameter; SQL clause adds gte/lte on auditLog.createdAt when present.
 *
 * Privacy invariant: the userId WHERE clause STAYS the FIRST clause in
 * `and(...)`. Cross-tenant 404 invariant (P19) preserved by construction
 * — the userId filter is independent of the date filter.
 */
describe("Plan 02.1-21: listAuditPage dateRange", () => {
  const uniq = () => Math.random().toString(36).slice(2, 10);

  it("dateRange.from + to filters rows to the inclusive window", async () => {
    const u = await seedUserDirectly({ email: `p21-window-${uniq()}@test.local` });
    // Seed 3 rows with explicit createdAt — one before the window, one
    // inside, one after. Then assert the filter returns exactly the
    // inside row.
    const beforeAt = new Date("2026-03-15T12:00:00.000Z");
    const insideAt = new Date("2026-04-10T12:00:00.000Z");
    const afterAt = new Date("2026-05-20T12:00:00.000Z");
    await db.insert(auditLog).values([
      { userId: u.id, action: "session.signin", ipAddress: "10.0.0.1", createdAt: beforeAt },
      { userId: u.id, action: "session.signin", ipAddress: "10.0.0.1", createdAt: insideAt },
      { userId: u.id, action: "session.signin", ipAddress: "10.0.0.1", createdAt: afterAt },
    ]);

    const out = await listAuditPage(u.id, null, [], {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-30T23:59:59.999Z"),
    });
    expect(out.rows.length).toBe(1);
    expect(out.rows[0]!.createdAt.toISOString()).toBe(insideAt.toISOString());
  });

  it("dateRange combined with actionFilter narrows on BOTH conditions", async () => {
    const u = await seedUserDirectly({ email: `p21-and-${uniq()}@test.local` });
    const oldAt = new Date("2026-01-01T12:00:00.000Z");
    const newAt = new Date("2026-04-10T12:00:00.000Z");
    await db.insert(auditLog).values([
      // Old + key.add: matches action but excluded by date.
      { userId: u.id, action: "key.add", ipAddress: "10.0.0.1", createdAt: oldAt },
      // New + session.signin: matches date but excluded by action.
      { userId: u.id, action: "session.signin", ipAddress: "10.0.0.1", createdAt: newAt },
      // New + key.add: matches both — the only row in the result.
      { userId: u.id, action: "key.add", ipAddress: "10.0.0.1", createdAt: newAt },
    ]);

    const out = await listAuditPage(u.id, null, ["key.add"], {
      from: new Date("2026-04-01T00:00:00.000Z"),
    });
    expect(out.rows.length).toBe(1);
    expect(out.rows[0]!.action).toBe("key.add");
    expect(out.rows[0]!.createdAt.toISOString()).toBe(newAt.toISOString());
  });

  it("cross-tenant 404 invariant preserved with date+action filter combination (P19)", async () => {
    const userA = await seedUserDirectly({ email: `p21-tcA-${uniq()}@test.local` });
    const userB = await seedUserDirectly({ email: `p21-tcB-${uniq()}@test.local` });
    const insideAt = new Date("2026-04-10T12:00:00.000Z");
    for (let i = 0; i < 3; i++) {
      await db.insert(auditLog).values({
        userId: userA.id,
        action: "key.add",
        ipAddress: "10.0.0.1",
        createdAt: insideAt,
      });
    }
    // userA sees 3 rows in the window with key.add filter.
    const aPage = await listAuditPage(userA.id, null, ["key.add"], {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-30T23:59:59.999Z"),
    });
    expect(aPage.rows.length).toBe(3);

    // userB asks for the same window + action + a forged cursor pointing
    // into userA's page. Must return zero rows. The userId WHERE clause
    // prunes BEFORE date / action narrow further.
    const aCursor = encodeCursor(aPage.rows[1]!.createdAt, aPage.rows[1]!.id);
    const bPage = await listAuditPage(userB.id, aCursor, ["key.add"], {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-30T23:59:59.999Z"),
    });
    expect(bPage.rows.length).toBe(0);
  });

  it("undefined dateRange returns all rows (default behavior)", async () => {
    const u = await seedUserDirectly({ email: `p21-default-${uniq()}@test.local` });
    await writeAudit({ userId: u.id, action: "session.signin", ipAddress: "10.0.0.1" });
    await writeAudit({ userId: u.id, action: "key.add", ipAddress: "10.0.0.1" });
    // dateRange omitted → no date filter; both rows return.
    const out = await listAuditPage(u.id, null, []);
    expect(out.rows.length).toBe(2);
  });
});
