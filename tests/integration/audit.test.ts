import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import * as SteamApi from "../../src/lib/server/integrations/steam-api.js";
import { createSteamKey } from "../../src/lib/server/services/api-keys-steam.js";
import { writeAudit } from "../../src/lib/server/audit.js";
import {
  listAuditPage,
  encodeCursor,
} from "../../src/lib/server/services/audit-read.js";
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
    const page1 = await listAuditPage(u.id, null, "all");
    expect(page1.rows.length).toBe(50);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await listAuditPage(u.id, page1.nextCursor!, "all");
    expect(page2.rows.length).toBe(10);
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

    const all = await listAuditPage(u.id, null, "all");
    expect(all.rows.length).toBe(3);

    const keyAdds = await listAuditPage(u.id, null, "key.add");
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
    const aPage = await listAuditPage(userA.id, null, "all");
    expect(aPage.rows.length).toBe(5);

    // Forge a cursor pointing at the middle of A's page.
    const aCursor = encodeCursor(aPage.rows[2]!.createdAt, aPage.rows[2]!.id);

    // Query as user B with A's cursor — must return 0 rows. This is the
    // load-bearing PRIV-02 / P19 assertion.
    const bPage = await listAuditPage(userB.id, aCursor, "all");
    expect(bPage.rows.length).toBe(0);
    expect(bPage.nextCursor).toBeNull();

    // Belt-and-suspenders: B with no cursor also sees zero (B has no seeded
    // rows). Confirms the previous assertion is not vacuous on a degenerate
    // cursor — B genuinely has nothing.
    const bAll = await listAuditPage(userB.id, null, "all");
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
    await createSteamKey(
      userA.id,
      { label: "K", plaintext: "ABCD1234" },
      "203.0.113.7",
    );
    const [a] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, userA.id))
      .limit(1);
    expect(a).toBeDefined();
    expect(a!.ipAddress).toBe("203.0.113.7");
  });
});
