import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import * as SteamApi from "../../src/lib/server/integrations/steam-api.js";
import { createSteamKey } from "../../src/lib/server/services/api-keys-steam.js";
import { seedUserDirectly } from "./helpers.js";

/**
 * Wave 0 placeholder test file (Plan 02-01 — Phase 2 Wave 0).
 *
 * Per Phase 1 Wave 0 invariant: every later task ships into a test that
 * already exists. The it.skip stubs below are EXACT names — implementing
 * plans (02-NN) replace `it.skip` with `it` and add the assertions.
 *
 * If you are an executor on a later plan and the test you need is NOT in
 * the it.skip list below, the gap is in this Wave 0 plan — fix it here,
 * NOT by silently adding a new it() in your plan's commit.
 */
describe("audit log read endpoint (PRIV-02 + KEYS-06 metadata)", () => {
  it.skip("02-07: PRIV-02 page size 50 + cursor", () => {
    /* placeholder — implementing plan: 02-07 */
  });
  it.skip("02-07: PRIV-02 action filter", () => {
    /* placeholder — implementing plan: 02-07 */
  });
  it.skip("02-07: PRIV-02 tenant-relative cursor (cross-tenant rejection)", () => {
    /* placeholder — implementing plan: 02-07 */
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
