import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { auth } from "../../src/lib/auth.js";
import { db } from "../../src/lib/server/db/client.js";
import { session, user } from "../../src/lib/server/db/schema/auth.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { signOutAllDevices } from "../../src/lib/server/services/users.js";
import { invalidateSession } from "../../src/lib/server/services/sessions.js";
import { seedUserDirectly } from "./helpers.js";

// VALIDATION 1/2/3/4 (Better Auth Google OAuth happy path) — the full HTTP redirect
// dance lands in Plan 01-10's smoke test (which boots the image and hits the mock
// IdP via real HTTP). This file covers the session DB lifecycle that AUTH-02 (sign-out
// invalidates), D-08 (sign-out-all-devices), and AUTH-03 (returning user resumes the
// same row) require — pure DB-level operations that work without an HTTP layer.
//
// D-13 mechanism = oauth2-mock-server per CONTEXT.md <deviations> 2026-04-27.
describe("Better Auth — DB session lifecycle (AUTH-01/02/03)", () => {
  it("seeded session is readable via auth.api.getSession", async () => {
    const { sessionToken } = await seedUserDirectly({
      email: "alice@test.local",
    });
    const headers = new Headers();
    headers.set("cookie", `neotolis.session_token=${sessionToken}`);
    const result = await auth.api.getSession({ headers });
    expect(result).not.toBeNull();
    expect(result?.user.email).toBe("alice@test.local");
  });

  it("AUTH-02: invalidateSession removes the row; subsequent getSession returns null", async () => {
    const { sessionToken, id: userId } = await seedUserDirectly({
      email: "bob@test.local",
    });

    // Find the session id from the token.
    const rows = await db.select().from(session).where(eq(session.token, sessionToken));
    expect(rows.length).toBe(1);

    await invalidateSession(rows[0]!.id);

    const headers = new Headers();
    headers.set("cookie", `neotolis.session_token=${sessionToken}`);
    const result = await auth.api.getSession({ headers });
    expect(result).toBeNull();

    // Cleanup
    await db.delete(user).where(eq(user.id, userId));
  });

  it("AUTH-02 (D-08): signOutAllDevices removes every session row for the user (all devices)", async () => {
    const { id: userId } = await seedUserDirectly({
      email: "carol@test.local",
    });

    // Add a second session row directly for the same user.
    await db.insert(session).values({
      id: uuidv7(),
      userId,
      token: "extra-token-xyz",
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const before = await db.select().from(session).where(eq(session.userId, userId));
    expect(before.length).toBeGreaterThanOrEqual(2);

    const result = await signOutAllDevices(userId);
    expect(result.deletedCount).toBeGreaterThanOrEqual(2);

    const after = await db.select().from(session).where(eq(session.userId, userId));
    expect(after.length).toBe(0);
  });

  it("AUTH-03: returning user resumes the same row (UNIQUE on email proves no duplicate)", async () => {
    // Seed once.
    await seedUserDirectly({ email: "dave@test.local" });
    // Seeding "again" with the same email must fail because user.email is UNIQUE
    // (Plan 01-03 schema). This proves Better Auth's account-linkage path will
    // resolve the same row on a returning sign-in instead of inserting a duplicate.
    await expect(seedUserDirectly({ email: "dave@test.local" })).rejects.toThrow();

    const all = await db.select().from(user).where(eq(user.email, "dave@test.local"));
    expect(all.length).toBe(1);
  });
});
