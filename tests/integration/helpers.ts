import { randomBytes } from "node:crypto";
import { pool } from "../setup.js";

// Integration-test helpers. Per RESEARCH.md Pattern 8 ("Test fixtures bypass OAuth"),
// `seedUserDirectly` inserts a user row + session row directly so each test doesn't pay
// the OAuth dance roundtrip cost. The `fetchAs` helper injects the resulting cookie.
//
// Wave 0 shipped stable signatures; Plan 01-05 (this commit) lands the real bodies.

export async function setupTestDb(): Promise<void> {
  // Plan 01-03 owns programmatic migrate; here we just confirm the pool is reachable.
  // The session-level `tests/setup.ts` runs migrations once before the suite starts.
  await pool.query("select 1");
}

export interface CreatedUser {
  id: string;
  email: string;
  sessionCookie: string;
  sessionToken: string;
}

/**
 * Seed a user + a session directly into the Better Auth canonical tables.
 *
 * Bypasses the full OAuth flow (Plan 01-10 smoke test exercises that path);
 * here we only need a logged-in user to drive AUTH-02 / AUTH-03 / PRIV-01
 * tests cheaply.
 *
 * Returns the cookie string the SvelteKit hook (Plan 01-06) will recognize —
 * cookie name follows Better Auth's `cookiePrefix + '.session_token'` rule
 * (D-05 — see src/lib/auth.ts `advanced.cookiePrefix = 'neotolis'`).
 */
export async function seedUserDirectly(opts: {
  email: string;
  name?: string;
}): Promise<CreatedUser> {
  // Lazy-import the Drizzle layer so unit tests don't pull pg.Pool when not needed.
  const { db } = await import("../../src/lib/server/db/client.js");
  const { user, session } = await import("../../src/lib/server/db/schema/auth.js");
  const { uuidv7 } = await import("../../src/lib/server/ids.js");

  const userId = uuidv7();
  await db.insert(user).values({
    id: userId,
    email: opts.email,
    name: opts.name ?? opts.email.split("@")[0]!,
    emailVerified: true,
  });

  const sessionToken = randomBytes(32).toString("base64url");
  const sessionId = uuidv7();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await db.insert(session).values({
    id: sessionId,
    userId,
    token: sessionToken,
    expiresAt,
  });

  // Better Auth cookie name format: `${cookiePrefix}.session_token`. Plan 01-05's
  // src/lib/auth.ts sets cookiePrefix = 'neotolis'. The hook in Plan 01-06 reads
  // this via Better Auth's getSession helper — tests just need to hand back a
  // cookie string in that exact shape.
  const sessionCookie = `neotolis.session_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`;

  return {
    id: userId,
    email: opts.email,
    sessionCookie,
    sessionToken,
  };
}

/** Backwards-compatible alias for code that wrote `createUser` against the Wave 0 stub. */
export async function createUser(email: string): Promise<CreatedUser> {
  return seedUserDirectly({ email });
}

// Phase 2 lands the games table; this stub stays so Plan 10's smoke test imports
// the same module shape that Phase 2 will fill in.
export async function createGame(_userId: string, _title: string): Promise<{ id: string }> {
  throw new Error("games table arrives in Phase 2");
}

/**
 * fetchAs(sessionTokenOrCookie, path, init?) — make an authenticated request.
 *
 * Accepts either:
 *   - a literal cookie string (contains `=`) — used as-is.
 *   - a raw session token — wrapped into the `neotolis.session_token=...` cookie.
 */
export async function fetchAs(
  sessionTokenOrCookie: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const cookie = sessionTokenOrCookie.includes("=")
    ? sessionTokenOrCookie
    : `neotolis.session_token=${sessionTokenOrCookie}`;
  const baseUrl = process.env.TEST_BASE_URL ?? "http://localhost:3000";
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  return fetch(new URL(path, baseUrl), { ...init, headers });
}
