import { afterEach, beforeAll } from "vitest";
import pg from "pg";

// Vitest setup file imported by the `integration` project (see vitest.config.ts).
//
// Reads TEST_DATABASE_URL (NOT DATABASE_URL — keep prod and test DBs distinct, see CLAUDE.md
// "Open-source compatibility"), opens a pg.Pool, runs migrations once at suite start, and
// truncates every public table between specs.
//
// `src/lib/server/db/migrate.ts` runs migrations against the truncate
// pool's database; if migrations fail (e.g. no Postgres reachable), the
// beforeAll propagates so integration tests fail loudly rather than
// silently passing against a half-migrated schema.
//
// Env-routing fix: pre-fix the truncate pool used TEST_DATABASE_URL while
// the Drizzle `db` client in src/lib/server/db/client.ts read
// DATABASE_URL. On a developer machine where DATABASE_URL points to the
// local production-data database, every integration test wrote fixtures
// into prod data and the afterEach TRUNCATE hit the wrong DB. Force the
// Drizzle client to share the same DB as this setup file by overwriting
// DATABASE_URL BEFORE any test imports transitively pull in
// $lib/server/config/env.ts (which Zod-validates the value at
// module-load time). vitest setupFiles run before test files, so this
// assignment is in scope for every test process.
const dbUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/neotolis_test";
process.env.DATABASE_URL = dbUrl;

// Social-provider budget envelope for the cost-guardrail integration tests
// (social-budget-throttle). env.ts defaults both to 0 (degrade) for the
// not-configured production case; tests need a concrete daily cap to exercise
// the 80/95 throttle (cap=100 → eighty=80, ninetyfive=95, cron pool=80, user
// pool=20) and a high prepaid balance so the daily-cap gate, not the balance,
// is what the pool tests hit. Tests that specifically assert the
// balance-as-hard-ceiling behavior write a small social_provider_balance row
// directly. env.ts parses these at module load, so they must be set here
// (setupFiles run before any test imports env.ts).
process.env.SOCIAL_PROVIDER_DAILY_CAP_CREDITS ??= "100";
process.env.SOCIAL_PROVIDER_PREPAID_BALANCE_CREDITS ??= "100000";

export const pool = new pg.Pool({ connectionString: dbUrl, max: 5 });

beforeAll(async () => {
  // Migration failure is no longer
  // silently warned. Pre-fix this try/catch suppressed both "no Postgres
  // reachable" (the original intent) AND "schema drift on local
  // neotolis_test DB" (an accidental side effect). Integration tests
  // against a half-migrated DB are vacuous-pass at best and silently
  // wrong at worst; AGENTS.md Validation §4 ("CI gate honesty") forbids
  // both shapes. We now propagate the failure so:
  //   - CI sees a clean migration on every run (fresh DB → no drift
  //     ever surfaces), or fails the integration-tests job loudly.
  //   - Local dev sees the drift immediately and can resolve it via
  //     `docker exec <pg-container> psql -U postgres -c 'DROP DATABASE
  //     neotolis_test;' && pnpm db:migrate` (recreate via the migrate
  //     helper that runs against TEST_DATABASE_URL).
  // The "no Postgres" case still surfaces with a clear ECONNREFUSED that
  // any contributor recognises.
  const { runMigrations } = await import("../src/lib/server/db/migrate.js");
  await runMigrations();
});

afterEach(async () => {
  // Truncate every public table — order-insensitive via TRUNCATE ... CASCADE.
  // Skip pg_catalog and pg_toast.
  try {
    const { rows } = await pool.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public'`,
    );
    if (rows.length === 0) return;
    const names = rows.map((r) => `"${r.tablename}"`).join(", ");
    await pool.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);

    // reddit_pacer is a singleton-row global rate-limit token. TRUNCATE
    // CASCADE empties it; restore the one row + reset next_allowed_at
    // so the next test starts with an immediately-available slot.
    // Without this, an integration test that makes >1 redditFetch
    // would block on the pacer after the first call (slot fires
    // every 7.5s).
    await pool.query(`INSERT INTO "reddit_pacer" ("id", "next_allowed_at") VALUES (1, NOW())
                      ON CONFLICT ("id") DO UPDATE
                      SET next_allowed_at = NOW(),
                          paused_until = NULL,
                          pause_level = 0,
                          last_pause_reason = NULL,
                          last_paused_at = NULL`);

    // twitter_pacer is the same singleton-row pattern (Phase 11 — minus the pause
    // columns). TRUNCATE CASCADE empties it; restore id=1 with an immediately-
    // available slot so any integration test that issues a real twitterFetch is not
    // blocked on a missing/future pacer row.
    await pool.query(`INSERT INTO "twitter_pacer" ("id", "next_allowed_at") VALUES (1, NOW())
                      ON CONFLICT ("id") DO UPDATE SET next_allowed_at = NOW()`);
  } catch {
    // Pre-migration: nothing to truncate. Swallow — integration tests will skip-with-context.
  }
});
