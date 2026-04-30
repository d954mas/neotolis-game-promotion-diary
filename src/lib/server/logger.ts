import pino from "pino";
import { env } from "./config/env.js";

// D-24 redaction paths. Every secret-shaped key path lives here so a stray
// `logger.info({ user })` cannot leak an api_key, refresh_token, KEK material,
// or an Authorization/Cookie header. Add new paths here whenever a new
// secret-shaped field is introduced anywhere in the codebase.
//
// Pino's fast-redact only supports `*` as a full-segment wildcard (e.g.
// `*.password` or `req.headers.*`); fragment-globs like `encrypted_*` are
// silently ignored, so each `encrypted_<thing>` field is enumerated explicitly.
//
// Privacy floor enforcement (AGENTS.md "Privacy & multi-tenancy" item 6):
// the redact-coverage test in tests/unit/logger.test.ts (Plan 02.1-36) is
// the load-bearing guarantee — it scans src/lib/server/db/schema/*.ts for
// every `bytea("...")` ciphertext column declaration AND for the
// `kek_version` smallint, builds the EXPECTED set as the union of camelCase
// Drizzle field names and snake_case DB column names, and asserts every
// entry is present here. Adding a new ciphertext column without a matching
// REDACT_PATHS entry fails the test loudly. Both shapes (camel + snake)
// are listed so a row dump in either Drizzle (camel) or raw pg (snake)
// shape stays redacted. Exported so the schema-introspection test can
// import the canonical list directly instead of grep'ing the source.
export const REDACT_PATHS = [
  "*.password",
  "*.api_key",
  "*.apiKey",
  "*.access_token",
  "*.accessToken",
  "*.refresh_token",
  "*.refreshToken",
  "*.id_token",
  "*.idToken",
  "*.secret",
  "*.encrypted_secret",
  "*.encrypted_dek",
  "*.wrapped_dek",
  "*.wrappedDek",
  "*.dek",
  "*.kek",
  // Plan 02.1-36 / UAT-NOTES.md §5.10 — Phase 2.1 ciphertext column shapes
  // (api_keys_steam.secret_*/dek_*/kek_version + future ciphertext-bearing
  // tables). Both camel + snake forms because row dumps surface in either
  // shape depending on the call site (Drizzle returns camel; raw pg returns
  // snake). The schema-introspection test enforces this list against the
  // current schema on every run.
  "*.secret_ct",
  "*.secretCt",
  "*.secret_iv",
  "*.secretIv",
  "*.secret_tag",
  "*.secretTag",
  "*.dek_iv",
  "*.dekIv",
  "*.dek_tag",
  "*.dekTag",
  "*.kek_version",
  "*.kekVersion",
  "req.headers.authorization",
  "req.headers.cookie",
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  // pino-pretty is dev-only (D-23). Production emits stdout JSON for Loki.
  ...(env.NODE_ENV === "development"
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }
    : {}),
});
