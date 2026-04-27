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
// tests/unit/logger.test.ts exercises every path here against a sentinel value
// — a typo here will fail that test loudly instead of silently disabling the
// protection (PITFALL P2 mitigation).
const REDACT_PATHS = [
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
