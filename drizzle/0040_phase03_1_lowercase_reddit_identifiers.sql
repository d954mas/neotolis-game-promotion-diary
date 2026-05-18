-- Phase 03.1 case-insensitive Reddit identifiers — data-only migration.
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
-- src/lib/sources/reddit/server/upsert.ts). This migration backfills
-- existing rows to the canonical lowercase form so the new code path
-- and the historical data agree.
--
-- Collision handling: where the same lowercase identifier already
-- exists with a different display case (e.g. cache row for both
-- "IndieDev" and "indiedev"), the older row is dropped — losing a few
-- minutes of stale snapshot data is acceptable; the next poll
-- repopulates the surviving row. ctid comparison picks the newer
-- physical row deterministically.
--
-- No schema change: drizzle/meta/0040_snapshot.json is identical to
-- 0039 (data migration only).

-- 1. reddit_subreddits_cache.name (PK). Drop collisions first.
DELETE FROM reddit_subreddits_cache a
USING reddit_subreddits_cache b
WHERE a.name <> b.name
  AND LOWER(a.name) = LOWER(b.name)
  AND a.ctid > b.ctid;
UPDATE reddit_subreddits_cache
SET name = LOWER(name)
WHERE name <> LOWER(name);

-- 2. reddit_users_cache.username (PK). Same collision drop + lowercase.
DELETE FROM reddit_users_cache a
USING reddit_users_cache b
WHERE a.username <> b.username
  AND LOWER(a.username) = LOWER(b.username)
  AND a.ctid > b.ctid;
UPDATE reddit_users_cache
SET username = LOWER(username)
WHERE username <> LOWER(username);

-- 3. reddit_posts.subreddit + reddit_posts.author. No collisions
--    possible — post_id is the PK; these columns are descriptive.
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

-- 5. events.metadata.{subreddit,author} for reddit_post events. Display
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
