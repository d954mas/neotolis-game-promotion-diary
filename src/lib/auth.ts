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
// against real Google in production and the mock IdP in CI/smoke.
//
// The account row's `providerId` is env-driven via OAUTH_PROVIDER_ID
// (default "google" — SaaS never overrides). Self-host operators who
// override OAUTH_DISCOVERY_URL to point at a non-Google IdP MUST also
// override OAUTH_PROVIDER_ID, otherwise rows are mislabelled (a Keycloak
// account stored as `providerId="google"`). See env.ts for the full
// rationale on the OAUTH_* family of env vars and the SaaS-vs-self-host
// support contract.

import { betterAuth } from "better-auth";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { encryptedDrizzleAdapter } from "./server/auth-adapter.js";
import { db } from "./server/db/client.js";
import * as authSchema from "./server/db/schema/auth.js";
import { env } from "./server/config/env.js";

export const auth = betterAuth({
  // CLAUDE.md "Secrets at rest" + D-11: OAuth provider tokens
  // (accessToken / refreshToken / idToken on the `account` row) are
  // envelope-encrypted in src/lib/server/auth-adapter.ts. The wrapper sits
  // between Better Auth and the official drizzleAdapter without changing
  // schema columns — the `text` column now holds an `ev1:`-prefixed JSON
  // blob; decryption happens transparently on read.
  database: encryptedDrizzleAdapter(db, {
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
    // genericOAuth plugin — discoveryUrl + providerId are env-driven via
    // the OAUTH_* family. SaaS uses defaults (Google). Self-host can override
    // to any OIDC-compatible IdP at their own risk; see env.ts for the
    // support contract.
    genericOAuth({
      config: [
        {
          providerId: env.OAUTH_PROVIDER_ID,
          clientId: env.OAUTH_CLIENT_ID,
          clientSecret: env.OAUTH_CLIENT_SECRET,
          discoveryUrl: env.OAUTH_DISCOVERY_URL,
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
    // BETTER_AUTH_SECURE_COOKIES override (review blocker P1 fix): a self-host
    // operator running the production image behind a TLS-terminating reverse
    // proxy over plain HTTP between proxy and app must set the env var to
    // "false". Otherwise Better Auth emits the `__Secure-` cookie prefix and
    // browsers refuse to set it over HTTP. Default tracks NODE_ENV.
    useSecureCookies: env.BETTER_AUTH_SECURE_COOKIES ?? env.NODE_ENV === "production",
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
    },
  },
});

export type Auth = typeof auth;
