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
// INFO I2 (issuer URL) — RESOLVED via genericOAuth plugin (review blocker
// P0-2). Better Auth 1.6.x's `socialProviders.google` hardcodes the Google
// authorize/token endpoints, which means the initial /api/auth/sign-in/...
// redirect always points at real Google — incompatible with CI/smoke runs
// that need to talk to oauth2-mock-server. The genericOAuth plugin exposes
// `discoveryUrl` (and explicit endpoint overrides), so the same code works
// against real Google in production and the mock IdP in CI/smoke. The
// account row's `providerId` stays "google" by construction
// (genericOAuth uses the configured providerId verbatim — see
// node_modules/better-auth/dist/plugins/generic-oauth/routes.mjs:246,266).

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
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
  plugins: [
    // genericOAuth plugin used so discoveryUrl is env-driven; CI/smoke point
    // at oauth2-mock-server, prod points at
    // https://accounts.google.com/.well-known/openid-configuration.
    // account.providerId='google' preserved (the plugin uses the configured
    // providerId verbatim for the account row).
    genericOAuth({
      config: [
        {
          providerId: "google",
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          discoveryUrl: env.GOOGLE_DISCOVERY_URL,
          scopes: ["openid", "email", "profile"],
          pkce: true,
        },
      ],
    }),
  ],
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
