-- Phase 3.0 post-build (UAT 2026-05-06) — rename `youtube_channel_metadata_cache`
-- to `youtube_channels`. The `_metadata_cache` suffix was a misnomer: this
-- table is our local copy of public YouTube data, not a regeneratable cache.
-- Sibling rename in 0013 introduced `youtube_videos` (also without the
-- misleading suffix). Forward-only — no down migration. Existing rows
-- preserved by ALTER TABLE RENAME.

ALTER TABLE "youtube_channel_metadata_cache" RENAME TO "youtube_channels";
