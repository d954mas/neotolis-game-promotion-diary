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
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  // Better Auth's genericOAuth plugin reads OIDC discovery from this URL so
  // CI / smoke / self-host can point at oauth2-mock-server while production
  // points at Google. Default = real Google's discovery document.
  GOOGLE_DISCOVERY_URL: z
    .string()
    .url()
    .default("https://accounts.google.com/.well-known/openid-configuration"),
  TRUSTED_ORIGINS: z.string().default(""),
  TRUSTED_PROXY_CIDR: z.string().default(""),
  COOKIE_DOMAIN: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  APP_KEK_BASE64: z.string().min(1),
  KEK_CURRENT_VERSION: z.coerce.number().int().min(1).default(1),
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

// PITFALL P2 mitigation #4: scrub the original env vars after consumption so
// the raw KEK material cannot leak via accidental console.log(process.env) or
// debug dumps. The decoded buffers live in `kekVersions` Map only.
delete process.env.APP_KEK_BASE64;
for (let v = 2; v <= 9; v++) {
  delete process.env[`APP_KEK_V${v}_BASE64`];
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
  GOOGLE_CLIENT_ID: raw.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: raw.GOOGLE_CLIENT_SECRET,
  GOOGLE_DISCOVERY_URL: raw.GOOGLE_DISCOVERY_URL,
  TRUSTED_ORIGINS,
  TRUSTED_PROXY_CIDR: raw.TRUSTED_PROXY_CIDR,
  COOKIE_DOMAIN: raw.COOKIE_DOMAIN,
  LOG_LEVEL: raw.LOG_LEVEL,
  KEK_CURRENT_VERSION: raw.KEK_CURRENT_VERSION,
  KEK_VERSIONS: kekVersions,
} as const;

export type Env = typeof env;
