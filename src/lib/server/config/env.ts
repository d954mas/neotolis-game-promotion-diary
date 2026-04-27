// This module is the SOLE reader of process.env in the entire codebase (D-24,
// PITFALL P2 mitigation). Every other module imports `env` from here. Boot
// fails fast on missing or malformed values; KEKs are decoded, length-checked,
// and the source env vars are scrubbed from process.env after consumption so
// they cannot leak via accidental console.log or stack traces.
//
// The `eslint-disable-next-line no-restricted-properties` comments below are
// the ONLY approved exceptions to the project-wide ban on `process.env` access.

import "dotenv/config";
import { z } from "zod";

const RawSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_ROLE: z.enum(["app", "worker", "scheduler"]).default("app"),
  APP_MODE: z.enum(["saas", "selfhost"]).default("selfhost"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  // OAuth identity provider — Google by default in both SaaS and self-host.
  // Self-host operators MAY override OAUTH_DISCOVERY_URL + OAUTH_PROVIDER_ID
  // to point at any OIDC-compatible IdP (Keycloak, Authentik, Auth0, ...).
  // This is unsupported / advanced for self-host: SaaS only ships Google,
  // and the project's auth UX, message strings, and audit semantics are
  // written assuming Google. SaaS env never overrides any of these.
  //
  // OAUTH_PROVIDER_ID is the value written to `account.providerId` in the
  // Better Auth schema and the value passed to genericOAuth's `providerId`.
  // If you switch IdP, switch this too — otherwise rows are mislabelled
  // ("google" against a Keycloak realm) and Better Auth treats them as the
  // same logical provider (which can be intentional for migrations, but is
  // a foot-gun by default).
  OAUTH_PROVIDER_ID: z.string().min(1).default("google"),
  OAUTH_CLIENT_ID: z.string().min(1),
  OAUTH_CLIENT_SECRET: z.string().min(1),
  OAUTH_DISCOVERY_URL: z
    .string()
    .url()
    .default("https://accounts.google.com/.well-known/openid-configuration"),
  TRUSTED_ORIGINS: z.string().default(""),
  TRUSTED_PROXY_CIDR: z.string().default(""),
  COOKIE_DOMAIN: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  APP_KEK_BASE64: z.string().min(1),
  KEK_CURRENT_VERSION: z.coerce.number().int().min(1).default(1),
  // Override Better Auth's secure-cookie default (which tracks NODE_ENV ===
  // "production"). Self-host operators running the production image behind a
  // TLS-terminating proxy over plain HTTP between proxy and app must set this
  // to "false" or Better Auth refuses to set the `__Secure-` cookie prefix
  // over HTTP. Smoke tests do the same — they exercise the production image
  // over plain HTTP. Leave unset in real production deployments.
  BETTER_AUTH_SECURE_COOKIES: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

const raw = RawSchema.parse(process.env);

// Decode and length-validate every KEK version present in env.
// KEK is 32 raw bytes (AES-256). Anything else is a misconfiguration that must
// fail at boot, not at first decrypt.
const kekVersions = new Map<number, Buffer>();

function decodeKek(b64: string, version: number): Buffer {
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== 32) {
    throw new Error(`KEK v${version} must decode to 32 bytes (got ${buf.length})`);
  }
  return buf;
}

kekVersions.set(1, decodeKek(raw.APP_KEK_BASE64, 1));

// Optional rotation versions: APP_KEK_V2_BASE64 .. APP_KEK_V9_BASE64.
for (let v = 2; v <= 9; v++) {
  const b64 = process.env[`APP_KEK_V${v}_BASE64`];
  if (b64) kekVersions.set(v, decodeKek(b64, v));
}

if (!kekVersions.has(raw.KEK_CURRENT_VERSION)) {
  throw new Error(
    `KEK_CURRENT_VERSION=${raw.KEK_CURRENT_VERSION} but no matching APP_KEK_V*_BASE64 provided`,
  );
}

// PITFALL P2 mitigation #4: scrub the original env vars from process.env so
// the raw KEK material cannot leak via accidental console.log(process.env)
// or debug dumps. The decoded buffers live in `kekVersions` Map only.
//
// IMPORTANT — call this AFTER all bundles that depend on env have loaded.
// SvelteKit's vite build produces its own bundled copy of this module
// (inside build/server/chunks/...). When build/handler.js is dynamically
// imported, SvelteKit's bundled env.ts re-parses process.env. If we scrub
// before that import resolves, the bundled parse sees APP_KEK_BASE64=undefined
// and throws — the smoke gate caught this on 2026-04-27 (issue #5).
//
// Boot sequence is therefore:
//   1. import env (this module) → kekVersions populated, process.env still
//      carries the raw values
//   2. import handler.js → bundled env.ts parses process.env successfully
//   3. server.ts calls scrubKekFromEnv() once startup is complete
export function scrubKekFromEnv(): void {
  delete process.env.APP_KEK_BASE64;
  for (let v = 2; v <= 9; v++) {
    delete process.env[`APP_KEK_V${v}_BASE64`];
  }
}

const TRUSTED_ORIGINS = raw.TRUSTED_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const env = {
  NODE_ENV: raw.NODE_ENV,
  APP_ROLE: raw.APP_ROLE,
  APP_MODE: raw.APP_MODE,
  PORT: raw.PORT,
  DATABASE_URL: raw.DATABASE_URL,
  BETTER_AUTH_URL: raw.BETTER_AUTH_URL,
  BETTER_AUTH_SECRET: raw.BETTER_AUTH_SECRET,
  OAUTH_PROVIDER_ID: raw.OAUTH_PROVIDER_ID,
  OAUTH_CLIENT_ID: raw.OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET: raw.OAUTH_CLIENT_SECRET,
  OAUTH_DISCOVERY_URL: raw.OAUTH_DISCOVERY_URL,
  TRUSTED_ORIGINS,
  TRUSTED_PROXY_CIDR: raw.TRUSTED_PROXY_CIDR,
  COOKIE_DOMAIN: raw.COOKIE_DOMAIN,
  LOG_LEVEL: raw.LOG_LEVEL,
  KEK_CURRENT_VERSION: raw.KEK_CURRENT_VERSION,
  KEK_VERSIONS: kekVersions,
  BETTER_AUTH_SECURE_COOKIES: raw.BETTER_AUTH_SECURE_COOKIES,
} as const;

export type Env = typeof env;
