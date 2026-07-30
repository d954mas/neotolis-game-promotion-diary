import pino from "pino";
import { env } from "./config/env.js";

// Redaction paths. Every secret-shaped key path lives here so a stray
// `logger.info({ user })` cannot leak an api_key, refresh_token, KEK material,
// or an Authorization/Cookie header. Add new paths here whenever a new
// secret-shaped field is introduced anywhere in the codebase.
//
// Pino's fast-redact only supports `*` as a full-segment wildcard (e.g.
// `*.password` or `req.headers.*`); fragment-globs like `encrypted_*` are
// silently ignored, so each `encrypted_<thing>` field is enumerated explicitly.
//
// Privacy floor enforcement (AGENTS.md "Privacy & multi-tenancy" item 6):
// the redact-coverage test in tests/unit/logger.test.ts is the
// load-bearing guarantee — it scans src/lib/server/db/schema/*.ts for
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
  // Ciphertext column shapes (api_keys_steam.secret_*/dek_*/kek_version +
  // future ciphertext-bearing tables). Both camel + snake forms because
  // row dumps surface in either shape depending on the call site (Drizzle
  // returns camel; raw pg returns snake). The schema-introspection test
  // enforces this list against the current schema on every run.
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
  // Operator's YouTube API key envelope. Lives plaintext in the parsed
  // env-singleton (env.ts splits
  // SERVICE_YOUTUBE_API_KEYS on comma into a string[]). scrubKekFromEnv()
  // wipes it from process.env after boot, but the env-singleton itself
  // retains it for the lifetime of the process — a stray
  // logger.info({ env }) or logger.info({ config }) would otherwise leak
  // every operator key. Both shapes covered: the env-key (uppercase
  // snake) and the singleton field name (lowerCamel).
  "*.SERVICE_YOUTUBE_API_KEYS",
  "*.serviceYoutubeApiKeys",
  // Operator's prepaid ScrapeCreators API key. Same lifetime trap as the
  // YouTube key envelope above: scrubKekFromEnv() wipes SCRAPECREATORS_API_KEY
  // from process.env after boot (see SECRET_KEYS in env.ts), but the env
  // singleton retains it for the process lifetime — a stray logger.info({ env })
  // would leak it. The transitive *.apiKey / *.api_key paths do NOT match the
  // singleton field name, so the key gets its own dedicated paths (env-key
  // uppercase snake + singleton lowerCamel), mirroring the YouTube entries.
  "*.SCRAPECREATORS_API_KEY",
  "*.scrapecreatorsApiKey",
  // Operator's prepaid twitterapi.io API key (Phase 11). Same env-singleton
  // lifetime trap as the ScrapeCreators key above: scrubKekFromEnv() wipes
  // TWITTERAPIIO_API_KEY from process.env after boot (see SECRET_KEYS in env.ts),
  // but the env singleton retains it for the process lifetime — a stray
  // logger.info({ env }) would leak it. The transitive *.apiKey / *.api_key paths
  // do NOT match the singleton field name, so the key gets its own dedicated
  // paths (env-key uppercase snake + singleton lowerCamel). The key otherwise
  // rides ONLY in the X-API-Key request header (never logged as a field).
  "*.TWITTERAPIIO_API_KEY",
  "*.twitterapiioApiKey",
  // Generic secret-shaped fields + HTTP auth headers (defense-in-depth): a stray
  // structured-fetch dump or request-log must never surface a bearer token, an OAuth
  // client secret, or an Authorization / Cookie header. (*.access_token /
  // *.refresh_token are already redacted above, D-24.)
  "*.bearer",
  "*.client_secret",
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.x-api-key",
  "*.headers.x-api-key",
  "*.x-api-key",
  // Phase 7 — Observability.
  "*.ALERT_WEBHOOK_URL",
  "*.alertWebhookUrl",
  "*.METRICS_BEARER_TOKEN",
  "*.metricsBearerToken",
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  // pino-pretty is dev-only. Production emits stdout JSON.
  ...(env.NODE_ENV === "development"
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }
    : {}),
});
