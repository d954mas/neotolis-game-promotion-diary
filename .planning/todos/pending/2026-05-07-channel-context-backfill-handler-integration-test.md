# TODO: integration test — channel-context-backfill handler

**Created:** 2026-05-07 (post-build review of Phase 3.0)
**Why now:** post-build review surfaced two regression-risk areas in
`src/worker/handlers/youtube-channel-context-backfill.ts` for which the
existing test suite has no direct coverage. A single integration test
file would close both at once but requires building fetch-mock
infrastructure for three Google API endpoints (channels.list,
playlistItems.list, videos.list) — substantial work that doesn't
belong in the same PR as the fixes.

## What the test should pin

### Per-source idempotency (Bug 3 closure)

After the post-build fix, the pre-insert SELECT in the handler is
scoped by `eq(events.sourceId, sourceId)`. This is the load-bearing
discipline that lets a user's manual paste event coexist with an
auto-import event from the same channel. Without a test, a future
refactor could revert the scope and silently drop backfill writes.

Test: seed user + data_source(channel_X, auto_import=true) +
events(kind=youtube_video, sourceId=NULL, externalId=video_X) (manual
paste); call handleChannelContextBackfill with channelId=channel_X
mocked to resolve uploads_playlist with [video_X, video_Y]; assert
post-state has THREE events:
- the original manual paste (sourceId=NULL, externalId=video_X)
- a new auto-import for video_X (sourceId=channel_X, externalId=video_X)
- a new auto-import for video_Y (sourceId=channel_X, externalId=video_Y)

Then re-run the handler. Assert post-state STILL has 3 events
(idempotent — pre-insert SELECT scoped by sourceId finds the existing
two and skips both).

### Failed-backfill scenario (post-build review concern, low priority)

Mid-flow failure (e.g. db.update throws while appending to
youtube_channels.handle_aliases) leaves a youtube_channels row but
no alias array entry. Singleton dedup (24h after the post-build
review tightened it from 30d) blocks repeat enqueue within the
window. Test: inject a failure on the handle_aliases UPDATE; run
handler; assert youtube_channels exists but handle_aliases is empty;
re-trigger ingest (within 24h) — assert sentJobs has only the first
enqueue (singleton blocked).

This second case is hard to test reliably without injecting failure
mid-flow. Acceptable to skip in favor of operator visibility (the
shorter 24h window means a real failure surfaces in /admin/quota
within a day, not 30 days).

## Infrastructure needed

- A `youtube-mock.ts` test helper that returns canned responses for
  channels.list, playlistItems.list, videos.list (analogous to
  tests/smoke/lib/youtube-mock.mjs but for vitest). Probably ~80 lines.
- An adapter mock that bypasses the real `fetchWithTimeout` so the
  handler exercises everything except the actual HTTP. Same pattern
  as `tests/integration/poll-worker-tx-boundary.test.ts` uses for the
  adapter.
- A `tests/integration/channel-context-backfill-handler.test.ts` file
  with the test cases above. ~150 lines.

Total: ~250 lines of new test code. Acceptable post-merge work; not
a blocker for the Phase 3.0 PR.

## Inline regression marker

Until this test lands, the load-bearing SELECT scope at
`src/worker/handlers/youtube-channel-context-backfill.ts` (search
for `eq(events.sourceId, sourceId)` in the auto-import block) carries
an inline comment pointing at this todo so a future refactor reader
sees the intent before considering a change.
