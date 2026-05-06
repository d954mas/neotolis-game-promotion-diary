---
title: Continuation backfill — slow-drain history for big channels
captured: 2026-05-06
captured_during: Phase 3.0 UAT
priority: P2 — quality-of-life, not a launch blocker
related_phase: 3.0 (initial backfill capped at 1000 videos)
---

## Context

Phase 3.0 initial backfill (`youtube.channel_context_backfill` worker) hard-
caps at 1000 most-recent videos per source (20 pages × 50). For a channel
with >1000 videos, or a user who picked "Everything" against a big channel,
we stop at the cap and the remaining history is **never** loaded.

User feedback during UAT 2026-05-06:
> "Я вот добавил канал. У меня будет статистика по каналу позже верно?
>  Вот что если я захочу загрузить все данные информацию по каналу?
>  Как будто можно условно 10% квоты выделить на подгрузку старых видео,
>  у каналов которые мы еще не загрузили полностью до конца?"

Excellent suggestion — bounded operator-side reserve drained slowly across
many channels = no quota wallop, full history eventually arrives.

## Proposed design

### Schema delta

`data_sources` table gains two columns:

```sql
ALTER TABLE data_sources
  ADD COLUMN backfill_complete boolean NOT NULL DEFAULT true,
  ADD COLUMN backfill_next_page_token text NULL;
```

`backfill_complete=false` AND `backfill_next_page_token IS NOT NULL` is the
"more pages await" state. `backfill_complete=true` is reached when:
1. The initial backfill ran to no-more-pages naturally, OR
2. The continuation worker walks the playlist to the end.

The initial backfill handler stops on `hard_cap` → writes `complete=false` +
the `nextPageToken` it didn't follow. On `no_more_pages` or `cutoff_crossed`
→ writes `complete=true`.

### New worker queue

```
QUEUE: youtube.backfill_continuation
SCHEDULE: pg-boss cron, hourly
HANDLER: pickOneIncompleteSource() → fetch one more page → save token
```

### Quota gate

Reserve threshold env var (operator setting):
```
SERVICE_YOUTUBE_BACKFILL_RESERVE_PCT=10  # default
```

The continuation handler skips its tick if `today_usage > (100 - reserve)%`.
This guarantees the reserve fraction stays for the operator's "fast lane"
(scheduled `poll.active` / user-driven `poll.user`).

### Fairness

`pickOneIncompleteSource` orders by `(last_continuation_at NULLS FIRST,
created_at)` so:
- Sources never touched by continuation come first (newest backfills)
- Among already-touched, oldest-poked goes next (round-robin)

Add `last_continuation_at` to data_sources for this ordering — third new
column on the migration.

### Worker handler outline

```typescript
async function continueBackfill(): Promise<void> {
  const usage = await getTodayQuotaUsage();
  if (usage.pct > 100 - env.SERVICE_YOUTUBE_BACKFILL_RESERVE_PCT) return;

  const source = await pickOneIncompleteSource();
  if (!source) return;

  const items = await fetchOnePlaylistPage({
    playlistId: source.uploadsPlaylistId,
    pageToken: source.backfillNextPageToken,
  });

  await seedSnapshots(items);   // 1 videos.list call (1 unit)
  await db.update(dataSources)
    .set({
      backfillNextPageToken: items.nextPageToken,
      backfillComplete: items.nextPageToken === null,
      lastContinuationAt: new Date(),
    })
    .where(eq(dataSources.id, source.id));
}
```

### Audit + observability

- New audit verb: `youtube.backfill_continued`
- /admin/quota dashboard gains a "Backfill queue" section showing
  sources still incomplete + ETA at current drain rate.

## Out of scope for this todo

- Per-user quota gates (Phase 3.0 deferred KEYS-01 trigger)
- Backfill of channels that have been deleted from YouTube (handle gracefully)
- Continuation cancellation UI (operator cancels a stuck backfill)

## Acceptance hint

A new Phase plan would split this into:
- W0: Schema migration + handler stub
- W1: Continuation worker + cron + quota gate
- W2: Initial backfill writes the leftover token (instead of dropping)
- W3: /admin/quota panel + audit verb
- W4: Integration tests + smoke gate
- W5: VERIFICATION

Estimated 2–3 days of work depending on test coverage depth.
