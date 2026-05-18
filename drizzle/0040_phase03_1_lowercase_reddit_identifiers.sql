-- Phase 03.1 case-insensitive Reddit identifiers — schema FK CASCADE +
-- data lowercase migration.
--
-- Reddit treats subreddit names and usernames as case-insensitive:
-- `r/IndieDev`, `r/indiedev`, and `r/INDIEDEV` all resolve to the same
-- subreddit. Same for `/user/MyHandle` and `/user/myhandle`. Pre-fix,
-- the adapter stored whatever case the user pasted, which split the
-- cache into two parallel rows for the same canonical identifier — two
-- walker states, two fan-out lanes, double work on every poll.
--
-- Going forward the parser + upsert helpers lowercase at the write
-- boundary (see src/lib/sources/reddit/server/url.ts +
-- src/lib/sources/reddit/server/upsert.ts). This migration:
--
--   (a) ALTERs the three child→parent FKs on the cache PKs to use
--       ON UPDATE CASCADE / ON DELETE CASCADE. Pre-fix the FKs were
--       NO ACTION which would FAIL the cache-PK lowercase UPDATE when
--       any snapshot/baseline rows already existed. CASCADE is the
--       correct long-term semantics for case-insensitive identifiers:
--       a parent PK rename re-points children automatically; a parent
--       row drop (collision dedup) also drops its derived snapshots.
--
--   (b) Backfills existing rows to the canonical lowercase form so the
--       new code path and the historical data agree (cache PKs +
--       descriptive columns + jsonb metadata on data_sources + events).
--
--   (c) Lowercases data_sources.handle_url for Reddit kinds so the
--       (user_id, handle_url) unique index in
--       `data_sources_user_handle_active_unq` actually catches the
--       case-insensitive duplicate that the duplicate-source check in
--       services/data-sources.ts compares exact-equality against.
--       Without this, a pre-existing `.../r/IndieDev` row would coexist
--       with a freshly canonicalised `.../r/indiedev` paste.
--
-- Collision handling: where the same lowercase identifier already
-- exists with a different display case (e.g. cache row for both
-- "IndieDev" and "indiedev"), the older row is dropped. With ON DELETE
-- CASCADE the loser's derived snapshots cascade with it — losing a
-- handful of stale rows is acceptable; the next poll repopulates from
-- the surviving canonical row.

-- ---------------------------------------------------------------------
-- 0. ALTER FKs to ON UPDATE CASCADE / ON DELETE CASCADE before any
--    UPDATE/DELETE on the parent PKs. Three child FKs need this:
--      reddit_subreddit_snapshots.subreddit  → reddit_subreddits_cache.name
--      reddit_subreddit_baselines.subreddit  → reddit_subreddits_cache.name
--      reddit_user_snapshots.username        → reddit_users_cache.username
-- ---------------------------------------------------------------------
ALTER TABLE "reddit_subreddit_snapshots"
  DROP CONSTRAINT IF EXISTS "reddit_subreddit_snapshots_subreddit_fk";
ALTER TABLE "reddit_subreddit_snapshots"
  ADD CONSTRAINT "reddit_subreddit_snapshots_subreddit_fk"
    FOREIGN KEY ("subreddit") REFERENCES "reddit_subreddits_cache"("name")
    ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "reddit_subreddit_baselines"
  DROP CONSTRAINT IF EXISTS "reddit_subreddit_baselines_subreddit_fk";
ALTER TABLE "reddit_subreddit_baselines"
  ADD CONSTRAINT "reddit_subreddit_baselines_subreddit_fk"
    FOREIGN KEY ("subreddit") REFERENCES "reddit_subreddits_cache"("name")
    ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "reddit_user_snapshots"
  DROP CONSTRAINT IF EXISTS "reddit_user_snapshots_username_fk";
ALTER TABLE "reddit_user_snapshots"
  ADD CONSTRAINT "reddit_user_snapshots_username_fk"
    FOREIGN KEY ("username") REFERENCES "reddit_users_cache"("username")
    ON UPDATE CASCADE ON DELETE CASCADE;

-- ---------------------------------------------------------------------
-- 1. reddit_subreddits_cache.name (PK). Drop collisions first (cascade
--    drops their derived snapshot/baseline rows). Then UPDATE remaining
--    rows — the cascade re-points child snapshots to the lowercase PK.
-- ---------------------------------------------------------------------
DELETE FROM reddit_subreddits_cache a
USING reddit_subreddits_cache b
WHERE a.name <> b.name
  AND LOWER(a.name) = LOWER(b.name)
  AND a.ctid > b.ctid;
UPDATE reddit_subreddits_cache
SET name = LOWER(name)
WHERE name <> LOWER(name);

-- 2. reddit_users_cache.username (PK). Same collision + cascade flow.
DELETE FROM reddit_users_cache a
USING reddit_users_cache b
WHERE a.username <> b.username
  AND LOWER(a.username) = LOWER(b.username)
  AND a.ctid > b.ctid;
UPDATE reddit_users_cache
SET username = LOWER(username)
WHERE username <> LOWER(username);

-- 3. reddit_posts.subreddit + reddit_posts.author. No FK on these
--    columns (free-text descriptive); UPDATE is direct.
UPDATE reddit_posts
SET subreddit = LOWER(subreddit)
WHERE subreddit <> LOWER(subreddit);
UPDATE reddit_posts
SET author = LOWER(author)
WHERE author IS NOT NULL
  AND author <> LOWER(author);

-- 4. data_sources.metadata.{subreddit,username} for Reddit sources.
--    These are the fan-out lookup keys; the queue payload + cache
--    primary key both flow from this jsonb value so it must match.
--
--    Enum cast through text (`kind::text = '…'`) is load-bearing: drizzle
--    wraps all pending migrations in one transaction, and the
--    `reddit_subreddit` / `reddit_account` values may have been ADDed to
--    the source_kind enum earlier in the same batch. Postgres
--    error 55P04 ("unsafe use of new value") forbids referencing a
--    not-yet-committed enum value as a literal in the same tx — the
--    text cast sidesteps the safety check by treating each row's value
--    as a string before comparison.
UPDATE data_sources
SET metadata = jsonb_set(metadata, '{subreddit}', to_jsonb(LOWER(metadata->>'subreddit')))
WHERE kind::text = 'reddit_subreddit'
  AND metadata ? 'subreddit'
  AND metadata->>'subreddit' <> LOWER(metadata->>'subreddit');
UPDATE data_sources
SET metadata = jsonb_set(metadata, '{username}', to_jsonb(LOWER(metadata->>'username')))
WHERE kind::text = 'reddit_account'
  AND metadata ? 'username'
  AND metadata->>'username' <> LOWER(metadata->>'username');

-- 5. data_sources.handle_url for Reddit kinds.
--    Lowercased so the unique-index dup check
--    `(user_id, handle_url) WHERE deleted_at IS NULL` actually catches a
--    second paste of the same subreddit in different case. Without this
--    step `'.../r/IndieDev'` and `'.../r/indiedev'` are distinct strings
--    and both rows would coexist for one user.
--
--    Collision: if the unique index would be violated (the SAME user
--    has BOTH casings of the same handle as active rows), soft-delete
--    the loser (older created_at, with id as a deterministic tie-breaker)
--    so the active-row partial index has room for the surviving lowercase
--    form. ON CONFLICT path is needed because the unique index is partial
--    (`WHERE deleted_at IS NULL`); a plain UPDATE would 23505 on the
--    collision.
WITH collisions AS (
  SELECT a.id AS loser_id
  FROM data_sources a
  JOIN data_sources b
    ON a.user_id = b.user_id
    AND a.id <> b.id
    AND a.deleted_at IS NULL
    AND b.deleted_at IS NULL
    AND LOWER(a.handle_url) = LOWER(b.handle_url)
    AND (
      a.created_at < b.created_at
      OR (a.created_at = b.created_at AND a.id < b.id)
    )
  WHERE a.kind::text IN ('reddit_account', 'reddit_subreddit')
)
UPDATE data_sources
SET deleted_at = NOW()
WHERE id IN (SELECT loser_id FROM collisions);

UPDATE data_sources
SET handle_url = LOWER(handle_url)
WHERE kind::text IN ('reddit_account', 'reddit_subreddit')
  AND handle_url <> LOWER(handle_url);

-- 6. events.metadata.{subreddit,author} for reddit_post events. Display
--    surface only; chips render the canonical lowercase form. Same enum
--    cast rationale as above — `reddit_post` may have been freshly
--    ADDed to the event_kind enum earlier in the same drizzle batch tx.
UPDATE events
SET metadata = jsonb_set(metadata, '{subreddit}', to_jsonb(LOWER(metadata->>'subreddit')))
WHERE kind::text = 'reddit_post'
  AND metadata ? 'subreddit'
  AND metadata->>'subreddit' <> LOWER(metadata->>'subreddit');
UPDATE events
SET metadata = jsonb_set(metadata, '{author}', to_jsonb(LOWER(metadata->>'author')))
WHERE kind::text = 'reddit_post'
  AND metadata ? 'author'
  AND metadata->>'author' <> LOWER(metadata->>'author');
