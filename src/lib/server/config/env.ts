// This module is the SOLE reader of process.env in the entire codebase.
// Every other module imports `env` from here. Boot fails fast on missing
// or malformed values; KEKs are decoded, length-checked, and the source
// env vars are scrubbed from process.env after consumption so they cannot
// leak via accidental console.log or stack traces.
//
// The `eslint-disable-next-line no-restricted-properties` comments below are
// the ONLY approved exceptions to the project-wide ban on `process.env` access.

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Load `.env` first, then layer `.env.local` on top with override. Mirrors
// vite's standard convention (.env shared, .env.local for per-machine
// overrides - gitignored). In production containers neither file exists;
// dotenv silently no-ops and `process.env` is populated by docker. Keeping
// this in the SOLE env.ts reader so we don't sprinkle dotenv calls
// across the codebase.
//
// Test isolation: vitest sets NODE_ENV=test before module load. We skip
// .env.local in that case so per-test withEnv() / withYoutubeKeys() helpers
// can stub process.env without local-machine secrets bleeding through.
loadDotenv({ quiet: true });
// dotenv probe BEFORE we parse env; this is the boot-time gate that
// decides whether to layer .env.local. env.ts is the single legitimate
// process.env reader, so the no-restricted-properties rule does not
// apply here.
if (process.env.NODE_ENV !== "test") {
  loadDotenv({ path: ".env.local", override: true, quiet: true });
}

const RawSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_ROLE: z.enum(["app", "worker", "scheduler"]).default("app"),
  APP_MODE: z.enum(["saas", "selfhost"]).default("selfhost"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  // OAuth identity provider - Google by default in both SaaS and self-host.
  // Self-host operators MAY override OAUTH_DISCOVERY_URL + OAUTH_PROVIDER_ID
  // to point at any OIDC-compatible IdP (Keycloak, Authentik, Auth0, ...).
  // This is unsupported / advanced for self-host: SaaS only ships Google,
  // and the project's auth UX, message strings, and audit semantics are
  // written assuming Google. SaaS env never overrides any of these.
  //
  // OAUTH_PROVIDER_ID is the value written to `account.providerId` in the
  // Better Auth schema and the value passed to genericOAuth's `providerId`.
  // If you switch IdP, switch this too - otherwise rows are mislabelled
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
  // Soft-delete retention window in days. The purge worker hard-deletes
  // rows where deleted_at < now() - RETENTION_DAYS::interval. Self-host
  // operators may set their own value; SaaS uses the default.
  RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(60),
  APP_KEK_BASE64: z.string().min(1),
  KEK_CURRENT_VERSION: z.coerce.number().int().min(1).default(1),
  // Override Better Auth's secure-cookie default (which tracks NODE_ENV ===
  // "production"). Self-host operators running the production image behind a
  // TLS-terminating proxy over plain HTTP between proxy and app must set this
  // to "false" or Better Auth refuses to set the `__Secure-` cookie prefix
  // over HTTP. Smoke tests do the same - they exercise the production image
  // over plain HTTP. Leave unset in real production deployments.
  BETTER_AUTH_SECURE_COOKIES: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),

  // Support contact email shown on /privacy, /terms, /about, footer.
  // Self-host operators MUST configure for GDPR compliance. Empty default
  // preserves self-host parity - boot succeeds with empty value; pages
  // render "support email not configured" placeholder via Paraglide
  // message picker.
  SUPPORT_EMAIL: z.string().default(""),

  // Per-user abuse limits (active rows; soft-deleted excluded).
  // Defaults are indie-friendly; operators may raise via .env.
  LIMIT_GAMES_PER_USER: z.coerce.number().int().positive().default(50),
  LIMIT_SOURCES_PER_USER: z.coerce.number().int().positive().default(50),
  // Rolling 24h limit on event creation (NOT calendar-day reset).
  LIMIT_EVENTS_PER_DAY: z.coerce.number().int().positive().default(500),
  // Per-user cap on cache-miss YouTube metadata fetches ("Get from YouTube"
  // button on /events/new). Closes the operator-quota burn loop a
  // scripted-loop attacker could exploit on /api/youtube/fetch-metadata.
  // 50/day default; cache hits don't count. Operator can raise via .env
  // if their users need more.
  LIMIT_YOUTUBE_METADATA_FETCHES_PER_DAY: z.coerce.number().int().positive().default(50),

  // Image tag override for docker-compose.prod.yml. The application code
  // never reads this directly (compose substitutes it at boot via
  // ${IMAGE_TAG:-latest}); we accept it in the schema so .env files
  // including IMAGE_TAG=<sha> for rollback do not fail zod parse.
  IMAGE_TAG: z.string().default("latest"),

  // Production domain for nginx server_name + OAuth redirect. Empty
  // default preserves self-host parity; SaaS prod sets to registered
  // CF domain. Application code does not read this directly
  // (BETTER_AUTH_URL already carries the canonical URL); we accept it
  // so prod .env passes zod.
  DOMAIN: z.string().default(""),

  // ---- Polling-pipeline plumbing ----

  // Comma-separated operator-owned YouTube Data API v3 keys. The polling
  // worker rotates across this set when the per-key 10k units/day ceiling
  // is approached. Empty default => auto-import + scheduled polling are
  // disabled (smoke + self-host parity preserved by construction).
  // Stored plaintext in env (not envelope-encrypted) - these are the
  // operator's own keys, not user secrets; existing pino redact paths cover
  // the field name `apiKey` and the YouTube response surface.
  SERVICE_YOUTUBE_API_KEYS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    ),

  // Phase 03.1 - Reddit operator User-Agent (DV-RDT-7: public-`.json` adapter).
  // Reddit's ToS REQUIRES a compliant UA. Default UAs (urllib, axios, node-fetch)
  // are aggressively rate-limited. Empty default => Reddit cleanly disabled
  // (self-host parity preserved - paste returns 422 reddit_not_configured,
  // /admin/quota Reddit tab shows "not configured", smoke gate validates).
  // Non-empty MUST match `<platform>:<id>:<version> (by /u/<handle>)`.
  // Stored plaintext in env (not envelope-encrypted) - the operator's UA, not
  // a user secret; Pino redact still covers the field name to keep ops logs
  // hygienic.
  REDDIT_USER_AGENT: z
    .string()
    .default("")
    .superRefine((ua, ctx) => {
      if (ua === "") return;
      const REDDIT_UA_RE = /^[^\s:]+:[^\s:]+:[^\s:]+\s+\(by\s+\/u\/[A-Za-z0-9_-]+\)$/;
      if (!REDDIT_UA_RE.test(ua)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "REDDIT_USER_AGENT must match `<platform>:<id>:<version> (by /u/<handle>)` per Reddit ToS (DV-RDT-7). " +
            "Example: 'node:com.neotolis.gpd:0.1.0 (by /u/operator)'. " +
            "Default UAs are aggressively rate-limited by Reddit.",
        });
      }
    }),

  // Comma-separated admin user emails (case-insensitive - the admin
  // middleware lowercases + trims before lookup). Empty default =>
  // /admin/* returns 404 for everyone (self-host parity preserved by
  // construction - no admin UI exists for self-host operators by default).
  // Changes require a container restart (parsed once at boot).
  ADMIN_EMAIL_ALLOWLIST: z
    .string()
    .default("")
    .transform(
      (s) =>
        new Set(
          s
            .split(",")
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean),
        ),
    ),

  // YouTube Data API v3 base URL. Production default = the official
  // endpoint; the smoke-gate harness overrides to a mock reverse-proxy URL.
  // Validated as a URL by zod so a typo fails fast at boot.
  YOUTUBE_API_BASE_URL: z.string().url().default("https://www.googleapis.com/youtube/v3"),

  // Reddit base URL - production default = the official reddit.com endpoint.
  // The CI smoke gate sets this to a mock reverse-proxy URL
  // (http://localhost:<port>) so the worker's chargedFetch redirects to the
  // mock without touching live Reddit. Mirrors YOUTUBE_API_BASE_URL precedent.
  // Validated as a URL so typos fail fast at boot.
  // DO NOT set in production - leaving unset (or set to the default) is the
  // only supported live behavior.
  REDDIT_BASE_URL_OVERRIDE: z.string().url().optional(),

  // Optional outbound HTTP proxy for Reddit fetches. When set, every
  // `redditFetch` routes through this proxy via undici's ProxyAgent.
  // Format: `http://user:pass@host:port` (Webshare static-residential
  // shape). Empty/unset = direct fetch (self-host operators on residential
  // IPs need nothing).
  //
  // Why this exists: Reddit aggressively 403's outbound traffic from
  // datacenter IP ranges (Hetzner, DO, Linode, AWS, Cloudflare Workers).
  // The author's prod VPS hits this fence. Routing through a residential
  // proxy makes Reddit see a consumer-ISP IP and respond normally.
  // See docs/deploy/MANUAL-DEPLOY.md for the operator decision tree.
  REDDIT_PROXY_URL: z.string().url().optional(),

  // Deployment hint for operators. Adapter-owned workers are protected by
  // per-adapter singleton locks or DB-backed claim gates; this value is no
  // longer a global quota safety guard.
  WORKER_REPLICA_COUNT: z.coerce.number().int().min(1).default(1),

  // Phase 7 — Observability. Consumed only by the Grafana container in
  // docker-compose.monitoring.yml — the app never reads this at runtime.
  // Accepted in the schema so .env files including it pass zod parse
  // (same pattern as IMAGE_TAG / DOMAIN). No .url() validation: an
  // invalid webhook must not crash the app boot.
  ALERT_WEBHOOK_URL: z.string().default(""),

  // Bearer token protecting /metrics. Empty (default) = /metrics returns
  // 404 to any caller. Self-host bare-port operators are safe by default;
  // operators who enable monitoring set a random token here and configure
  // Prometheus `bearer_token` to match.
  METRICS_BEARER_TOKEN: z.string().default(""),

  // ---- Phase 8 — Social provider port + Instagram + cost guardrails ----

  // Which provider implementation serves the `instagram` platform. Empty
  // default => Instagram is NOT configured: the add-source IG chip renders
  // disabled (SOC-05 graceful degrade), and no scraper credits are ever
  // spent. Boot succeeds with this unset, preserving self-host parity (no
  // APP_MODE branch — "not configured" is the empty-env state, not a mode).
  // Today the only implementation is `scrapecreators`; later platforms add
  // their own per-platform provider-selection env.
  INSTAGRAM_PROVIDER: z.enum(["scrapecreators"]).or(z.literal("")).default(""),

  // Operator's prepaid ScrapeCreators API key (the `x-api-key` header).
  // Plaintext env, NOT envelope-encrypted — per CONTEXT D-03 (REVISED
  // 2026-06-05): this is operator config like SERVICE_YOUTUBE_API_KEYS /
  // REDDIT_USER_AGENT, never a per-user DB secret. Envelope encryption
  // protects per-user secrets keyed by the env KEK; an operator key IS the
  // operator's env config, so it does not apply. Empty default => provider
  // not configured (graceful degrade). The Pino redact path `apiKey` already
  // covers the field-name surface; scrubKekFromEnv strips it from
  // process.env after parse (see SECRET_KEYS below).
  SCRAPECREATORS_API_KEY: z.string().default(""),

  // ScrapeCreators API base URL. Production default = the official endpoint;
  // the smoke-gate / provider-mock harness overrides to a local reverse-proxy
  // URL (mirrors YOUTUBE_API_BASE_URL). Validated as a URL so a typo fails
  // fast at boot.
  SCRAPECREATORS_BASE_URL: z.string().url().default("https://api.scrapecreators.com"),

  // Per-user fair-share cap on social-provider requests (QUOTA-03 / D-19).
  // ≈ $0.10/day at 50 requests. The per-user pool funds only user-initiated
  // work (initial backfill on add, manual refresh-now, history expansion);
  // ongoing background polling is operator-funded (the cron pool), so 50/day
  // covers bursts and paces history expansion. Exceed => 429 via the existing
  // graceful per-user-quota path.
  LIMIT_SOCIAL_REQUESTS_PER_DAY: z.coerce.number().int().positive().default(50),

  // Backfill post-count cap (D-10): the cost-meaningful internal ceiling.
  // Default 48 = 4 pages of 12. The walker stops at this OR the date window,
  // whichever first — cost is independent of archive size (BACK-01).
  SOCIAL_BACKFILL_MAX_POSTS: z.coerce.number().int().positive().default(48),

  // Default backfill date window in days (D-10). The user may self-expand to
  // any window incl. "everything" via the existing BackfillPicker /
  // backfill_target_since flow; this is the default boundary on add.
  SOCIAL_BACKFILL_WINDOW_DAYS: z.coerce.number().int().positive().default(30),

  // Operator daily spend envelope in credits (D-16). Reuses the YouTube
  // 80/95 throttle + midnight-Pacific daily-reset machinery: the daily cap
  // RESETS each day. 0 default => no spend allowed until the operator sets it
  // (safe default; moot while INSTAGRAM_PROVIDER is empty). Operators who
  // think monthly set daily = monthly / 30.
  SOCIAL_PROVIDER_DAILY_CAP_CREDITS: z.coerce.number().int().nonnegative().default(0),

  // Operator's funded prepaid balance in credits — the ABSOLUTE hard ceiling
  // (D-16, Pitfall 3). Unlike the daily cap, this does NOT reset daily: it is
  // monotonically decremented as credits are spent ("cannot spend what isn't
  // there"). The quota_reset cron clears only the daily-cap counter, never
  // this balance. 0 default => degrade.
  SOCIAL_PROVIDER_PREPAID_BALANCE_CREDITS: z.coerce.number().int().nonnegative().default(0),

  // Concurrency of the social-provider per-post Refresh lane (#69 follow-on).
  // The single-post endpoint can't batch (1 request = 1 post), so the lane
  // worker claims up to N rows per tick and fetches them CONCURRENTLY — this is
  // the parallelism knob, NOT a batch-in-one-request size like YouTube's 50.
  // Keep conservative to respect ScrapeCreators rate limits; raise per plan.
  SOCIAL_REFRESH_LANE_CONCURRENCY: z.coerce.number().int().positive().default(10),
});

const raw = RawSchema.parse(process.env);

// Canonical env key set — the single source of truth the .env.example
// drift test (tests/unit/env-example-drift.test.ts, D-19a) reads. Reading
// RawSchema.shape (NOT process.env) keeps this within the env.ts boundary:
// it inspects the schema, not the environment, so no-restricted-properties
// does not fire.
export const RAW_ENV_KEYS: readonly string[] = Object.freeze(Object.keys(RawSchema.shape));

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

// Scrub the original env vars from process.env so the raw KEK material
// cannot leak via accidental console.log(process.env) or debug dumps.
// The decoded buffers live in `kekVersions` Map only.
//
// IMPORTANT - call this AFTER all bundles that depend on env have loaded.
// SvelteKit's vite build produces its own bundled copy of this module
// (inside build/server/chunks/...). When build/handler.js is dynamically
// imported, SvelteKit's bundled env.ts re-parses process.env. If we scrub
// before that import resolves, the bundled parse sees
// APP_KEK_BASE64=undefined and throws.
//
// Boot sequence is therefore:
//   1. import env (this module) -> kekVersions populated, process.env still
//      carries the raw values
//   2. import handler.js -> bundled env.ts parses process.env successfully
//   3. server.ts calls scrubKekFromEnv() once startup is complete
export function scrubKekFromEnv(): void {
  // env.ts is the SOLE legitimate process.env reader; scrub is the
  // inverse - clearing the secret fields after they've been parsed into
  // the env-singleton so a later console.log(process.env) at runtime
  // can't leak them. Scrub coverage spans every credential/secret env
  // var landed via the schema. Pino redact still covers logger output;
  // this is the second layer for direct process.env reads. The
  // no-restricted-properties rule does not apply inside env.ts.
  const SECRET_KEYS = [
    "APP_KEK_BASE64",
    "BETTER_AUTH_SECRET",
    "OAUTH_CLIENT_SECRET",
    "SERVICE_YOUTUBE_API_KEYS",
    "SCRAPECREATORS_API_KEY", // operator's prepaid scraper key (D-03)
    "DATABASE_URL", // contains the postgres password
  ];
  for (const k of SECRET_KEYS) delete process.env[k];
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
  RETENTION_DAYS: raw.RETENTION_DAYS,
  KEK_CURRENT_VERSION: raw.KEK_CURRENT_VERSION,
  KEK_VERSIONS: kekVersions,
  BETTER_AUTH_SECURE_COOKIES: raw.BETTER_AUTH_SECURE_COOKIES,
  SUPPORT_EMAIL: raw.SUPPORT_EMAIL,
  LIMIT_GAMES_PER_USER: raw.LIMIT_GAMES_PER_USER,
  LIMIT_SOURCES_PER_USER: raw.LIMIT_SOURCES_PER_USER,
  LIMIT_EVENTS_PER_DAY: raw.LIMIT_EVENTS_PER_DAY,
  LIMIT_YOUTUBE_METADATA_FETCHES_PER_DAY: raw.LIMIT_YOUTUBE_METADATA_FETCHES_PER_DAY,
  IMAGE_TAG: raw.IMAGE_TAG,
  DOMAIN: raw.DOMAIN,
  SERVICE_YOUTUBE_API_KEYS: raw.SERVICE_YOUTUBE_API_KEYS,
  REDDIT_USER_AGENT: raw.REDDIT_USER_AGENT,
  ADMIN_EMAIL_ALLOWLIST: raw.ADMIN_EMAIL_ALLOWLIST,
  YOUTUBE_API_BASE_URL: raw.YOUTUBE_API_BASE_URL,
  REDDIT_BASE_URL_OVERRIDE: raw.REDDIT_BASE_URL_OVERRIDE,
  REDDIT_PROXY_URL: raw.REDDIT_PROXY_URL,
  WORKER_REPLICA_COUNT: raw.WORKER_REPLICA_COUNT,
  ALERT_WEBHOOK_URL: raw.ALERT_WEBHOOK_URL,
  METRICS_BEARER_TOKEN: raw.METRICS_BEARER_TOKEN,
  INSTAGRAM_PROVIDER: raw.INSTAGRAM_PROVIDER,
  SCRAPECREATORS_API_KEY: raw.SCRAPECREATORS_API_KEY,
  SCRAPECREATORS_BASE_URL: raw.SCRAPECREATORS_BASE_URL,
  LIMIT_SOCIAL_REQUESTS_PER_DAY: raw.LIMIT_SOCIAL_REQUESTS_PER_DAY,
  SOCIAL_BACKFILL_MAX_POSTS: raw.SOCIAL_BACKFILL_MAX_POSTS,
  SOCIAL_BACKFILL_WINDOW_DAYS: raw.SOCIAL_BACKFILL_WINDOW_DAYS,
  SOCIAL_PROVIDER_DAILY_CAP_CREDITS: raw.SOCIAL_PROVIDER_DAILY_CAP_CREDITS,
  SOCIAL_PROVIDER_PREPAID_BALANCE_CREDITS: raw.SOCIAL_PROVIDER_PREPAID_BALANCE_CREDITS,
  SOCIAL_REFRESH_LANE_CONCURRENCY: raw.SOCIAL_REFRESH_LANE_CONCURRENCY,
} as const;

export type Env = typeof env;
