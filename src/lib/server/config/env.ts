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
  // 2026-06-05): this is operator config like SERVICE_YOUTUBE_API_KEYS, never
  // a per-user DB secret. Envelope encryption
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
  // Default 1000 ≈ the deepest listing Reddit exposes (~83 pages of 12, well
  // under a dollar at ScrapeCreators rates). The walker stops at this OR the
  // date window, whichever first; deep archives top up ACROSS resumed passes
  // (per-invocation page caps + persisted cursors), so the real spend guards
  // are the daily budget caps + the per-user request quota, not this ceiling.
  SOCIAL_BACKFILL_MAX_POSTS: z.coerce.number().int().positive().default(1000),

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

  // Warm auto-refresh (#69 follow-on). A post is "warm" (gets a PAID single-post
  // refresh via the service_post lane) while it is YOUNGER than this many days
  // AND has gone stale (not refreshed within INSTAGRAM_WARM_STALENESS_HOURS).
  // Older than the window → frozen (manual Refresh only). The first week is where
  // metrics move + wishlist correlation matters; bounding the window caps spend
  // to ≤ window credits/post.
  INSTAGRAM_WARM_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  // Staleness gate: a warm post is re-refreshed only when its last_polled_at is
  // older than this. Must be JUST OVER the 24h free account-poll interval: the
  // daily account poll re-stamps last_polled_at on EVERY page-1 post, so a value
  // >24h keeps page-1 posts UNDER the gate (the free poll covers them — we never
  // pay) and only OFF-page-1 posts (the free poll no longer reaches them) go stale
  // enough to earn a paid warm refresh ~1×/day. A value <24h would pay daily for
  // page-1 posts the free poll already covers — the exact opposite of the cost
  // goal. 26h = 24h interval + 2h margin for free-poll scheduling jitter.
  INSTAGRAM_WARM_STALENESS_HOURS: z.coerce.number().int().positive().default(26),
  // Bound on consecutive non-ok polls before a post drops OUT of warm
  // auto-refresh (IG's HTTP seam collapses transient + budget-exhaustion into
  // last_poll_status='auth_error'; a single blip must NOT freeze a post forever,
  // and a PERSISTENT failure must NOT churn credits forever — poll_failure_count
  // bounds both). Resets to 0 on the next ok poll.
  INSTAGRAM_WARM_MAX_FAILURES: z.coerce.number().int().positive().default(5),

  // Telegram warm per-post auto-refresh (Phase 9, free t.me/s scrape). A post
  // is "warm" (gets a single-post ?embed=1 refresh via the service_post lane)
  // while it is YOUNGER than this many days AND has gone stale (not refreshed
  // within TELEGRAM_WARM_STALENESS_HOURS). Denser than IG's 7d/26h because
  // there is NO paid 24h double-poll to dodge — Telegram is free.
  TELEGRAM_WARM_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  // Staleness gate: a warm post is re-refreshed only when last_polled_at is
  // older than this. 12h > the 6h listing-poll interval, so a post still on
  // the ~20-post listing (re-stamped every 6h) never enters the warm lane —
  // the warm lane only catches posts that scrolled OFF the listing.
  TELEGRAM_WARM_STALENESS_HOURS: z.coerce.number().int().positive().default(12),
  // Bound on consecutive non-ok polls before a post drops OUT of warm
  // auto-refresh (stops hammering a permanently-broken post). Resets on ok.
  TELEGRAM_WARM_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  // Telegram backfill post-count cap (B1) — the dedicated ceiling the ?before
  // walker stops at (collected >= this), so a giant channel costs a bounded
  // number of pages regardless of archive size. Separate knob from the paid
  // SOCIAL_BACKFILL_MAX_POSTS: Telegram is a FREE t.me/s scrape, so its depth
  // is paced (politeness), not credit-bounded.
  TELEGRAM_BACKFILL_MAX_POSTS: z.coerce.number().int().positive().default(1000),

  // TikTok provider selection (Phase 10). Mirrors INSTAGRAM_PROVIDER exactly:
  // empty default => TikTok is NOT configured (the add-source TikTok chip renders
  // disabled, SOC-05 graceful degrade, no scraper credits spent). Boot succeeds
  // with this unset (self-host parity — "not configured" is the empty-env state,
  // not an APP_MODE branch). TikTok REUSES the existing ScrapeCreators account:
  // no new SCRAPECREATORS_API_KEY, no new budget vars — IG + TikTok draw from the
  // ONE shared prepaid balance per provider (D-01). The operator flips this to
  // `scrapecreators` after deploy to enable.
  TIKTOK_PROVIDER: z.enum(["scrapecreators"]).or(z.literal("")).default(""),

  // TikTok warm per-post auto-refresh (Phase 10). Same shape + defaults as the
  // Instagram warm lane (7d window / 26h staleness / 5 failures): a post is
  // "warm" (gets a PAID single-post refresh via the service_post lane) while it
  // is YOUNGER than this many days AND has gone stale (not refreshed within
  // TIKTOK_WARM_STALENESS_HOURS). TikTok is a PAID scraper like IG, so the 26h
  // staleness must stay just over the 24h free account-poll interval to avoid
  // double-paying page-1 posts (same reasoning as the IG warm gate).
  TIKTOK_WARM_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  TIKTOK_WARM_STALENESS_HOURS: z.coerce.number().int().positive().default(26),
  TIKTOK_WARM_MAX_FAILURES: z.coerce.number().int().positive().default(5),

  // Twitter/X provider selection (Phase 11). Mirrors TIKTOK_PROVIDER exactly,
  // EXCEPT the vendor: empty default => Twitter/X is NOT configured (the
  // add-source Twitter chip renders disabled, SOC-05 graceful degrade, no scraper
  // credits spent). Boot succeeds with this unset (self-host parity — "not
  // configured" is the empty-env state, not an APP_MODE branch). Twitter/X uses a
  // NEW, SECOND vendor twitterapi.io (D-01) — NOT ScrapeCreators — so it has its
  // own TWITTERAPIIO_API_KEY (below) and its own per-provider prepaid balance row
  // (D-02; the social_provider_balance per-provider re-key from Plan 10-01 gives
  // it one automatically). It REUSES the same SOCIAL_PROVIDER_* / SOCIAL_BACKFILL_*
  // budget/cap envelope — NO new budget vars. The operator flips this to
  // `twitterapi.io` after deploy to enable.
  TWITTER_PROVIDER: z.enum(["twitterapi.io"]).or(z.literal("")).default(""),

  // twitterapi.io's own prepaid-credit API key (Phase 11, D-01). A SEPARATE
  // secret from SCRAPECREATORS_API_KEY — twitterapi.io is a different vendor with
  // a different prepaid balance. Same shape as SCRAPECREATORS_API_KEY: a plain
  // string, empty default => provider not configured (graceful degrade). The key
  // rides ONLY in the X-API-Key header (Plan 02's http.ts), never logged as a
  // field. Pino redacts it (dedicated REDACT_PATHS entry — the env singleton field
  // name does not match the transitive *.apiKey path, same trap as the
  // ScrapeCreators / YouTube keys) and scrubKekFromEnv strips it from process.env
  // after parse (see SECRET_KEYS below).
  TWITTERAPIIO_API_KEY: z.string().default(""),

  // Twitter/X warm per-post auto-refresh (Phase 11). Same shape + defaults as the
  // Instagram / TikTok warm lane (7d window / 26h staleness / 5 failures): a tweet
  // is "warm" (gets a PAID single-tweet refresh) while it is YOUNGER than this
  // many days AND has gone stale (not refreshed within TWITTER_WARM_STALENESS_
  // HOURS). twitterapi.io is a PAID scraper like IG/TikTok, so the 26h staleness
  // must stay just over the 24h free account-poll interval to avoid double-paying
  // page-1 tweets (same reasoning as the IG/TikTok warm gate).
  TWITTER_WARM_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  TWITTER_WARM_STALENESS_HOURS: z.coerce.number().int().positive().default(26),
  TWITTER_WARM_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  // Global twitterapi.io QPS pacer floor — min ms between any two twitterapi.io calls
  // (one DB slot across all paths + replicas). Default 5000 = 0.2 QPS (the never-paid
  // floor, safe for a free-tier self-host). A paid operator on 3 QPS lowers it to ~400
  // (≈2.5 QPS, margin under the ceiling). Read by twitter/server/pacer.ts.
  TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().positive().default(5000),

  // ---- Phase 12 — Reddit import (ScrapeCreators author/subreddit walk) ----

  // Which provider implementation serves the `reddit` platform. Mirrors
  // INSTAGRAM_PROVIDER / TIKTOK_PROVIDER exactly. Empty default => Reddit is NOT
  // configured (the add-source Reddit chip renders disabled, SOC-05 graceful
  // degrade, no scraper credits spent). The 12-01 live spike returned GO on the
  // ScrapeCreators author path (D-01), so `scrapecreators` is the ONLY buildable
  // value — the Apify fallback (D-03) was not built, so there is no "apify"
  // option. Reddit REUSES the shared SCRAPECREATORS_API_KEY + SOCIAL_* budget
  // envelope (no new key, no new budget vars).
  REDDIT_PROVIDER: z.enum(["scrapecreators"]).or(z.literal("")).default(""),

  // Reddit isolation kill-switch (D-08). STRING-LITERAL-SAFE boolean: ONLY the
  // literal "true" enables import; the gate (Plan 12-03) compares `=== "true"`.
  // NOT z.coerce.boolean() — that maps the STRING "false" to true (Pitfall 2).
  // Default "false" (disabled): even with REDDIT_PROVIDER + the shared
  // SCRAPECREATORS_API_KEY present, Reddit import stays OFF until the operator
  // explicitly sets "true" — the legally-hot platform never auto-enables.
  REDDIT_IMPORT_ENABLED: z.enum(["true", "false"]).default("false"),
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
    "TWITTERAPIIO_API_KEY", // operator's prepaid twitterapi.io key (Phase 11, D-01)
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
  ADMIN_EMAIL_ALLOWLIST: raw.ADMIN_EMAIL_ALLOWLIST,
  YOUTUBE_API_BASE_URL: raw.YOUTUBE_API_BASE_URL,
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
  INSTAGRAM_WARM_WINDOW_DAYS: raw.INSTAGRAM_WARM_WINDOW_DAYS,
  INSTAGRAM_WARM_STALENESS_HOURS: raw.INSTAGRAM_WARM_STALENESS_HOURS,
  INSTAGRAM_WARM_MAX_FAILURES: raw.INSTAGRAM_WARM_MAX_FAILURES,
  TELEGRAM_WARM_WINDOW_DAYS: raw.TELEGRAM_WARM_WINDOW_DAYS,
  TELEGRAM_WARM_STALENESS_HOURS: raw.TELEGRAM_WARM_STALENESS_HOURS,
  TELEGRAM_WARM_MAX_FAILURES: raw.TELEGRAM_WARM_MAX_FAILURES,
  TELEGRAM_BACKFILL_MAX_POSTS: raw.TELEGRAM_BACKFILL_MAX_POSTS,
  TIKTOK_PROVIDER: raw.TIKTOK_PROVIDER,
  TIKTOK_WARM_WINDOW_DAYS: raw.TIKTOK_WARM_WINDOW_DAYS,
  TIKTOK_WARM_STALENESS_HOURS: raw.TIKTOK_WARM_STALENESS_HOURS,
  TIKTOK_WARM_MAX_FAILURES: raw.TIKTOK_WARM_MAX_FAILURES,
  TWITTER_PROVIDER: raw.TWITTER_PROVIDER,
  TWITTERAPIIO_API_KEY: raw.TWITTERAPIIO_API_KEY,
  TWITTER_WARM_WINDOW_DAYS: raw.TWITTER_WARM_WINDOW_DAYS,
  TWITTER_WARM_STALENESS_HOURS: raw.TWITTER_WARM_STALENESS_HOURS,
  TWITTER_WARM_MAX_FAILURES: raw.TWITTER_WARM_MAX_FAILURES,
  TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS: raw.TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS,
  REDDIT_PROVIDER: raw.REDDIT_PROVIDER,
  REDDIT_IMPORT_ENABLED: raw.REDDIT_IMPORT_ENABLED,
} as const;

export type Env = typeof env;
