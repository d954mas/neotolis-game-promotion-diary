---
title: youtube_channels handle/alias index for ingest cache
captured: 2026-05-06
captured_during: Phase 3.0 pre-push code review (BUG-3)
priority: P2 — quota efficiency, not a correctness bug
related_phase: 3.0
---

## Context

Pre-push reviewer's BUG-3:
> ingest.ts:238-252 для `/@handle`-URL'ов использует сам `authorUrl` как ключ
> кеша и `singletonKey`. youtube-channel-context-backfill.ts потом пишет в
> `youtube_channels` под канонический UCxxx. Следствие: повторные пасты
> того же канала через `/@handle` всегда получают cache miss →
> `singletonHours: 24` спасает на 24 часа, дальше каждый день лишний
> backfill (= 9 квотных юнитов на ровном месте).

Mitigation already shipped (commit `b95e531` neighbour): `singletonHours`
bumped from 24h to 30d for handle URLs. Reduces waste by ~30× but still
fires monthly per channel where the user keeps pasting via `/@handle`.

## Proper fix

Two parts.

### Schema delta

`youtube_channels` gains a `handle_aliases text[]` column (or a sibling
`youtube_channel_aliases (alias text PRIMARY KEY, channel_id text)` table
if cardinality grows past a handful per channel).

### Worker fill-in

After `youtube-channel-context-backfill` resolves a handle → UC channelId,
it appends the original handle URL to `handle_aliases` (or inserts the
alias row). Subsequent pastes of the same handle URL hit the cache.

### Ingest lookup

`maybeEnqueueChannelContextBackfill` extends the cache check:

```sql
SELECT channel_id FROM youtube_channels
WHERE channel_id = $1                  -- direct UC id hit
   OR $1 = ANY(handle_aliases)         -- handle URL alias hit
LIMIT 1;
```

A simple GIN index on `handle_aliases` keeps the OR-branch cheap.

## Out of scope

- Resolving handles upstream of ingest (call channels.list?forHandle= in
  the request path) — adds 1 quota unit + 100ms latency to every paste.
  Not worth it.
- Migrating to `pg_trgm` or other fuzzy match — handle URLs are exact
  strings, no need for substring matching.

## Estimated effort

Single migration + 5-line worker UPDATE + 3-line ingest WHERE extension +
unit/integration test. Half a day with tests.
