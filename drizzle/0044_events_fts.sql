-- Postgres full-text search on events (Plan 03.4-10 follow-up).
--
-- Adds a generated tsvector column `search_vec` derived from
-- `title` + `notes` (the two free-text fields the user types into) plus a
-- GIN index so `search_vec @@ plainto_tsquery('english', $q)` is index-
-- backed at /feed cursor pagination scale.
--
-- `to_tsvector('english', ...)` stems English content; non-English chars
-- pass through unchanged. Russian / mixed content gets a follow-up
-- enhancement in a later phase (per-user locale config OR `simple` regconfig
-- fallback) if/when needed — for v1 the indie author's content is
-- English-first and an English stemmer is already a 90% win over LIKE.
--
-- Forward-only. Idempotent: the IF NOT EXISTS guard on the column AND
-- the index keeps re-running safe (drizzle-migrator does NOT re-run, but
-- the operator-friendly shape protects against accidental manual replays).
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS search_vec tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(title, '') || ' ' || coalesce(notes, '')
    )
  ) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_events_search_vec ON events USING GIN(search_vec);
