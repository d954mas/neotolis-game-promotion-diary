-- Phase 3.0 post-build (UAT 2026-05-06) — drop the redundant non-unique
-- copy of the youtube_video_snapshots (video_id, polled_at) index. The
-- unique index `youtube_video_snapshots_video_polled_unq` (introduced in
-- the same 0010 migration) already covers every read pattern the
-- non-unique sibling could serve (chart loader range scans, idempotent
-- INSERT ON CONFLICT). Carrying both made every snapshot INSERT pay for
-- two B-tree updates instead of one. Forward-only — no down migration.

DROP INDEX IF EXISTS "youtube_video_snapshots_video_id_polled_at_idx";
