// Better Auth 1.6 — single source of truth for the auth instance.
//
// Wired against the Drizzle pg client + canonical Better Auth core schema from
// Plan 01-03 (user / session / account / verification). All env reads go
// through src/lib/server/config/env.ts (D-24, P2 mitigation).
//
// Decisions encoded here:
//   - D-05: database-backed sessions; the cookie carries only `session_id`.
//           `cookieCache: { enabled: false }` is explicit — the entire point of
//           DB-backed sessions is that the server can invalidate instantly. A
//           cookie cache would defeat AUTH-02.
//   - D-07: minimum user record on first sign-in (Better Auth's default user
//           shape matches; no custom `additionalFields`).
//   - D-08: sign-out-from-all-devices is implemented in
//           src/lib/server/services/users.ts on top of these tables.
//   - CLAUDE.md project constraint: Google OAuth ONLY — `emailAndPassword`
//           is explicitly disabled. No password-reset flow, no breach surface.
//
// INFO I2 (issuer URL) — Better Auth 1.6.x's `socialProviders.google` does NOT
// expose an `issuer` or `discoveryUrl` field; the Google endpoints are
// hardcoded inside the provider. Test/CI compatibility with `oauth2-mock-server`
// (D-13 mechanism) is achieved via the mock minting tokens with
// `iss: 'https://accounts.google.com'` (mock-side coercion — see
// tests/setup/oauth.ts and Plan 01-10's smoke test). No code change is needed
// here; we only document the constraint so future readers understand why the
// google block has no `issuer:` field.

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./server/db/client.js";
import * as authSchema from "./server/db/schema/auth.js";
import { env } from "./server/config/env.js";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: authSchema.user,
      session: authSchema.session,
      account: authSchema.account,
      verification: authSchema.verification,
    },
  }),
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: env.TRUSTED_ORIGINS,
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      // INFO I2 (issuer URL): Better Auth 1.6.x's google provider hardcodes
      // https://accounts.google.com — there is no `issuer` / `discoveryUrl`
      // override. CI/integration tests use `oauth2-mock-server` and configure
      // the mock to mint id_tokens with `iss: 'https://accounts.google.com'`
      // (Path 3 of plan 01-05 <execution_notes>). See tests/setup/oauth.ts.
      // No `prompt: "consent"` — the default UX is best.
    },
  },
  session: {
    // D-05: database-backed sessions. cookieCache disabled so every request
    // hits the session table — that's the entire point. Sign-out is instant.
    cookieCache: { enabled: false },
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh idle sessions every 1 day
  },
  emailAndPassword: {
    // CLAUDE.md project constraint: Google OAuth only — no email/password.
    enabled: false,
  },
  advanced: {
    cookiePrefix: "neotolis",
    crossSubDomainCookies: env.COOKIE_DOMAIN
      ? { enabled: true, domain: env.COOKIE_DOMAIN }
      : { enabled: false },
    useSecureCookies: env.NODE_ENV === "production",
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
    },
  },
});

export type Auth = typeof auth;
