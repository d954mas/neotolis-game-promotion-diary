import { randomBytes } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { pool } from "../setup.js";

// Integration-test helpers. Per RESEARCH.md Pattern 8 ("Test fixtures bypass OAuth"),
// `seedUserDirectly` inserts a user row + session row directly so each test doesn't pay
// the OAuth dance roundtrip cost. The `fetchAs` helper injects the resulting cookie.
//
// Wave 0 shipped stable signatures; Plan 01-05 (this commit) lands the real bodies.
// Review-blocker fix (I1/I2): Better Auth's session cookie value is HMAC-signed —
// `<token>.<signature>`, where the signature is `makeSignature(token, BETTER_AUTH_SECRET)`.
// `getSignedCookie` rejects any cookie missing or failing the signature check, so a
// "raw token" cookie fails session lookup with no error trail (just a null session).
// We mirror Better Auth's own `createCookieHeaders` test util (see
// node_modules/better-auth/dist/plugins/test-utils/cookie-builder.mjs) by signing the
// token value with the same secret the running auth instance uses.

export async function setupTestDb(): Promise<void> {
  // Plan 01-03 owns programmatic migrate; here we just confirm the pool is reachable.
  // The session-level `tests/setup.ts` runs migrations once before the suite starts.
  await pool.query("select 1");
}

export interface CreatedUser {
  id: string;
  email: string;
  /** Full `Cookie:` header value, including `Path=/` and `HttpOnly` attributes. */
  sessionCookie: string;
  /** Raw, unsigned session token (matches the value stored in `session.token`). */
  sessionToken: string;
  /**
   * The cookie value as Better Auth writes it to the browser:
   * `<sessionToken>.<HMAC-SHA256(sessionToken, BETTER_AUTH_SECRET)>`.
   * This is what `getSignedCookie` will accept.
   */
  signedSessionCookieValue: string;
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
 * (D-05 — see src/lib/auth.ts `advanced.cookiePrefix = 'neotolis'`). The
 * value is HMAC-signed against `BETTER_AUTH_SECRET` so Better Auth's
 * `getSignedCookie` accepts it on subsequent requests.
 */
export async function seedUserDirectly(opts: {
  email: string;
  name?: string;
}): Promise<CreatedUser> {
  // Lazy-import the Drizzle layer so unit tests don't pull pg.Pool when not needed.
  const { db } = await import("../../src/lib/server/db/client.js");
  const { user, session } = await import("../../src/lib/server/db/schema/auth.js");
  const { uuidv7 } = await import("../../src/lib/server/ids.js");
  const { env } = await import("../../src/lib/server/config/env.js");

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

  // Better Auth signs the cookie value with HMAC-SHA256 using BETTER_AUTH_SECRET.
  // The wire format is `<token>.<signature>` — see better-auth/cookies/index.mjs's
  // `setSignedCookie(name, session.token, secret, ...)` and the matching read path
  // `getSignedCookie(name, secret)` in api/routes/session.mjs.
  const signature = await makeSignature(sessionToken, env.BETTER_AUTH_SECRET);
  const signedSessionCookieValue = `${sessionToken}.${signature}`;
  const sessionCookie = `neotolis.session_token=${signedSessionCookieValue}; Path=/; HttpOnly; SameSite=Lax`;

  return {
    id: userId,
    email: opts.email,
    sessionCookie,
    sessionToken,
    signedSessionCookieValue,
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
 * fetchAs(sessionCookieOrToken, path, init?) — make an authenticated request.
 *
 * Accepts either:
 *   - a literal cookie header value (contains `=`) — used as-is. Pass
 *     `CreatedUser.sessionCookie` here.
 *   - a signed session-cookie value (`<token>.<signature>` from
 *     `CreatedUser.signedSessionCookieValue`) — wrapped into a
 *     `neotolis.session_token=<value>` header.
 *
 * NOTE: Better Auth requires the cookie value to be HMAC-signed against
 * `BETTER_AUTH_SECRET`. Passing a raw, unsigned `sessionToken` will fail
 * `getSignedCookie` verification and produce a null session.
 */
export async function fetchAs(
  sessionCookieOrToken: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const cookie = sessionCookieOrToken.includes("=")
    ? sessionCookieOrToken
    : `neotolis.session_token=${sessionCookieOrToken}`;
  const baseUrl = process.env.TEST_BASE_URL ?? "http://localhost:3000";
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  return fetch(new URL(path, baseUrl), { ...init, headers });
}
