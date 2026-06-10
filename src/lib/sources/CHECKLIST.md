# Adding a New Platform Adapter — Checklist

Step-by-step guide for adding a platform (Reddit, Twitter, Telegram, Discord, etc.) to `src/lib/sources/`. Follow in order. Reference the YouTube tree (`src/lib/sources/youtube/`) as the canonical reference implementation — it's production code with all edge cases handled, but ~30% of its content is platform-specific (tier polling, oEmbed metadata, channel-context-backfill) that doesn't translate. Filter signal from noise as you copy.

For deeper conceptual context (why backfill state machine, why two-layer cap, why pool_kind discriminator), read `SOURCE-REFERENCE.md` §8–9.

---

## 0. Pre-work — domain decisions

Before any code:

- [ ] **Quota model.** Document the platform's API rate-limit shape: per-key daily envelope (YouTube), per-OAuth-token rolling window (Reddit), per-app-bearer (Twitter), unlimited (Telegram). Determines `userQuotaCap`, DB claim gates, and whether `requiresSingletonRuntime` is needed.
- [ ] **Auth shape.** Operator static keys (YouTube), per-user OAuth (Reddit/Twitter), unauthenticated scrape (Telegram public). Determines `observability.auth` declaration.
- [ ] **Pool attribution.** Will adapter use cron pool, user pool, or both? See §9 of SOURCE-REFERENCE.md. YouTube uses both.
- [ ] **API safety posture.** For unauthenticated/public endpoints, document conservative cadence, User-Agent requirements, retry/backoff semantics, and UI degraded-state behavior before wiring the worker.
- [ ] **External id stability.** What's the canonical id for posts/videos? Are URLs immutable? Determines `parseUrl` regex and `events.external_id` semantics.
- [ ] **Rolling-window cap shape.** If platform's quota is rolling (e.g., 600 req / 10 min), pick one of three documented options in `SOURCE-REFERENCE.md` §9 «Window-shape extensibility»: daily-equivalent / undefined / contract-extension.

---

## 1. Schema (per-source tables)

- [ ] Create `src/lib/sources/<kind>/server/schema/` directory.
- [ ] Define platform-specific tables in `<kind>/server/schema/*.ts`. Examples: `reddit_posts`, `reddit_metadata_fetch_log`, `reddit_token_refresh_log`. Public-data (cross-tenant) tables: NO `userId` column. Per-tenant tables: `userId` column required (AGENTS.md invariant 1).
- [ ] **Subject/channel entity + full historical storage (REQUIRED for analytics-capable adapters).** Any auto-import adapter SHOULD provide:
  - [ ] **(a) A public-data subject entity table** (channel / account / subreddit) keyed on the platform's INTRINSIC, rename-proof id — the SOURCE OF TRUTH for that subject's OWN upstream metadata (title, avatar, subscriber count, description, handle aliases). This is NOT a denorm of `data_sources` (AGENTS.md no-denorm): `data_sources.display_name` is the user-facing, user-renameable label; the entity row's `title`/`name` is the upstream-scraped value. The two coexist and never alias each other. Populate it via UPSERT on each poll, COALESCE-preserving prior good values on a partial/failed parse so a transient miss never blanks working metadata. References: `youtube_channels` (header comment "this IS our truth"), `reddit_subreddits_cache`, `telegram_channels`, `instagram_accounts`. The `instagram_accounts` case is the canonical "populate without new cost" example — it rides the create-time profile resolve (the richer fields) + the FREE feed owner object (account_id + @handle + avatar), so a PAID adapter gains the subject-entity anchor with ZERO additional provider credits.
  - [ ] **(b) Full per-post + per-post-snapshot historical storage** (public-data, retained FOREVER — no GC, even when the last referencing event / source is deleted), grouped by the subject key (carry the rename-proof subject id as a column on the per-post row, e.g. `telegram_posts.channel_key`). The row IS the historical record; channel-level analytics later require the full history. References: `youtube_videos` + `youtube_video_snapshots`, `reddit_posts` + `reddit_post_snapshots`, `telegram_posts` + `telegram_post_snapshots`.
  - [ ] **(c) [future / optional] Per-subject baselines for percentile context** — a separate public-data aggregate table keyed by the subject key, computed by a nightly cron, surfaced in `/feed` enrichment as "your post vs the subject's median". Build only when the read-path needs it; the canonical pattern to copy is `reddit_subreddit_baselines` (median / p75 over a rolling window, `PERCENTILE_CONT`, `sample_size` gate). Designing the subject entity (a) up front is what makes (c) cheap to add later.
- [ ] Re-export tables from `<kind>/server/schema/index.ts`.
- [ ] Add re-export to `src/lib/server/db/schema/index.ts` — **one line**: `export * from "$lib/sources/<kind>/server/schema/index.js";`. This is the only barrel-level edit needed for schema.
- [ ] Generate migration: `pnpm exec drizzle-kit generate`. Add migration to `drizzle/meta/_journal.json` if generated separately.
- [ ] Apply migration locally: `npx tsx -e "import('./src/lib/server/db/migrate.js').then(m => m.runMigrations())"`. Verify column shapes with `\d <table_name>` in psql.
- [ ] Document migration rollback in the migration's header comment (see `drizzle/0024_*.sql`, `drizzle/0026_*.sql` for examples). Forward-only by AGENTS.md, but documented rollback gives operators an emergency recovery path.

---

## 2. Adapter contract - required methods

Open `src/lib/sources/adapter.ts` and read `interface SourceAdapter`. Implement the cross-source surface in `<kind>/server/index.ts`. Keep platform-specific upstream methods local to that adapter's server tree; do not add them to `SourceAdapter` unless at least three adapters need the same call shape.

- [ ] `kind: SourceKind` - literal type from `SourceKind` enum in `db/schema/data-sources.ts`. Must be added to the enum if not already present (separate migration).
- [ ] `parseUrl(url): ParsedUrl | null` - first-match-wins URL recognizer. Returns `{kind, externalId}` on match, `null` otherwise. **Must be pure and side-effect-free** - registry iterates all adapters until one matches.
- [ ] `observability: AdapterObservability` - auth + quota + per-user cap declaration. Spread it from a separate file (`<kind>/server/observability.ts`).
- [ ] `registerQueues(boss)` - adapter owns its pg-boss queues. Worker bootstrap iterates all adapters and calls each.
- [ ] `scheduleCronTicks(boss)` - adapter owns its cron schedules.
- [ ] `backfillSource(source, ctx)` - enqueue source discovery/backfill work. Returns `{jobId, queue}`.

## 2a. Adapter contract — optional methods

Implement only those that apply to your platform.

- [ ] `syncStats?: { fetch(externalId, ctx) }` - opt into an explicit fast path for paste/preview flows. This is allowed only when the caller runs quota/accounting gates first; never hide upstream HTTP behind a generic route fallback.
- [ ] SQL lane workers - when queue order/cadence is part of quota safety, declare it through `workQueue.scheduledWorkers[].laneQueue` and use `createAdapterBatchLaneWorker`. Pick `maxBatchSize` per the upstream API's batch tolerance (number for uniform across lanes, per-lane record when lanes have different batching characteristics). `batchScope: "global"` when one upstream request can safely serve many tenants (quota-efficient shared requests), or `"user"` when the upstream identity is tenant-bound (per-user OAuth/token).

- [ ] `refreshQueue?: { canRefresh(eventKind), enqueue(input) }` — opt into the «Refresh now» button per event kind.
- [ ] `workQueue?: { scheduledWorkers[] }` — opt into adapter-owned interval workers when queue order/cadence is part of the quota contract. Use `laneQueue.strategy="fixed-slot-round-robin"` for SQL lane workers like Reddit.
- [ ] `reconcileRuntimeState?()` — sync process-local runtime state with persistent counters at worker boot. Skip if adapter uses persistent state only.
- [ ] `normalizeSourceOnCreate?(input, ctx)` — pure/cheap local source URL normalization before duplicate/quota prechecks. No upstream I/O here. Use it for canonical URL spelling and metadata injection (Reddit `u/name` -> canonical user URL + `metadata.username`).
- [ ] `canonicalizeOnCreate?(input, ctx)` — URL canonicalization at create time (e.g., resolve handle → channel id).
- [ ] `onSourceCreated?(source, opts)` — transactional hook inside createSource; use `opts.tx` and the shared outbox for first backfill enqueue.
- [ ] `fetchEventPreviewMetadata?(canonicalUrl)` — manual paste preview (oEmbed equivalent).
- [ ] `validateEventInput?(input)` — adapter-specific input shape validation.
- [ ] `fetchPollStateMap?(userId, externalIds)` — read poll state for the «Refresh now» button display.
- [ ] `registerRoutes?(app)` — register adapter-specific HTTP routes (e.g., metadata fetch endpoints).

## 2b. Required observability fields

In `<kind>/server/observability.ts`:

- [ ] `auth.kind` — one of operator-static-key / per-user-oauth / per-user-bearer / unauthenticated.
- [ ] `auth.requiresUserSetup` — true if every user must connect their account before the adapter works.
- [ ] `auth.isOperatorConfigured` — runtime-evaluated (read env). True if operator has provisioned credentials.
- [ ] `quota.getDailyStats(date)` — total operator-side usage for the day. Return shape includes `keys[]` with per-key throttleState classification (adapter computes via internal thresholds).
- [ ] `quota.getRecentAudit(limit)` — recent platform-specific audit_log entries for the /admin/quota dashboard.
- [ ] `quotaCounters?` — declare per-user cap counters here (e.g., `<kind>_metadata_fetches_per_day`).
- [ ] `userQuotaCap?` — declare per-user fair-share cap. Adapters with no daily cap declare `undefined` and the UI renders «no limit» (counter still shown).
- [ ] `requiresSingletonRuntime?` — true only if adapter still has load-bearing process-local state that cannot be protected by a DB claim gate or persistent counter. Worker bootstrap will register that adapter's pg-boss queues/scheduled workers on only one replica via a DB advisory lock.

---

## 3. Worker handlers

In `<kind>/server/handlers/`:

- [ ] **Backfill/source-discovery handler.** Reference: `src/lib/sources/youtube/server/handlers/backfill-channel.ts`. Required logic:
  - [ ] Tenant-scoped source lookup (filter by `userId`).
  - [ ] `computeSinceForRefresh` to derive newSide / oldSide boundaries (shared helper, no adapter-specific code needed).
  - [ ] `flow` upgrade: if `oldSide !== null && flow === 'incremental'`, upgrade to `'historical'`.
  - [ ] Empty result → `markSourceBackfillComplete` + audit row with `unitsUsed`.
  - [ ] Non-empty: pre-INSERT SELECT for idempotency, INSERT events, update frontier, mark last_polled_at, audit row with adapter's reported `unitsUsed`.
  - [ ] Audit metadata MUST include `platform: '<kind>'` (cap query filter — see SOURCE-REFERENCE.md §9.1) AND `flow: AuditFlow` (closed enum — see `src/lib/server/audit.ts`).
- [ ] **Auto-backfill cron handler** (if applicable). Picks incomplete sources, enqueues passive backfill jobs.
- [ ] **Stats poll handlers** (if applicable). Tier-based (Active/Cold) for platforms with stable refresh windows.
- [ ] **Refresh-now enqueue** (if applicable). Implement through `adapter.refreshQueue.enqueue`. Cooldown/cap gates live in `services/refresh-poll.ts`; adapter code only enqueues platform work.
- [ ] **Lane worker** (if applicable). Use shared `adapter_refresh_queue` with `adapterKind`, ordered slots, fallthrough, `replicaPolicy`, and an optional DB-backed `claimGate` for global pacers. For batch queues, document whether batching is global for quota efficiency or user-scoped for tenant-bound upstream credentials.

---

## 4. UI integration

> **Why two of these are explicit, not compile-enforced.** The feed kind-filter
> and the chart event-marker thumbnail are hand-edited surfaces (not
> `satisfies Record<…>`-enforced), so an adapter can ship and be **invisible** in
> filters / charts — Phase 10 D-08/D-09 fixed exactly that IG/Telegram regression
> structurally (derive the filter from `kind-display.ts`; route the marker through
> the enrichment seam). These checklist items prevent it recurring.

- [ ] Create `<kind>/ui/server.ts` — `toCardProps(event): CardProps` projection for feed display.
- [ ] Create `<kind>/ui/index.ts` — optional client-side `cardComponent` override if FeedCard default doesn't fit.
- [ ] Register both in `src/lib/sources/registry-ui.ts` and `src/lib/sources/registry-ui-client.ts` — **one line each**.
- [ ] **Feed kind-filter visibility.** Set `feedFilterable: true` on the new EventKind in `src/lib/sources/kind-display.ts` (EVENT_KIND_DISPLAY). The /feed FiltersSheet derives its KIND axis from `FEED_FILTERABLE_EVENT_KINDS` — do NOT add the kind to any hand-list. Verify the kind appears in the /feed Filters sheet after wiring.
- [ ] **Chart event-marker thumbnail.** Ensure the adapter's `enrichFeedDtos` hangs a `<kind>Enrichment.thumbnailUrl` on the dto AND that `eventThumbnail` in `src/lib/components/charts/wishlist-chart-shared.ts` reads it (add the `<kind>Enrichment` field to its ThumbnailEvent type). The games-chart markers resolve through this seam — a missing thumbnail field means a blank marker. Verify a marker shows the preview on /games/[id].

---

## 5. Registry registration

- [ ] Export `<kind>Adapter` from `<kind>/server/index.ts` barrel.
- [ ] Add to `src/lib/sources/registry.ts` — **one line** in the registry Map.

---

## 6. Tests

Reference patterns:
- `tests/integration/end-to-end-catch-up.test.ts` — full pipeline coverage
- `tests/integration/cap-exhaustion-error-codes.test.ts` — per-axis 429 coverage
- `tests/integration/auto-backfill-cron-picker.test.ts` — cron picker
- `tests/integration/backfill-state-helpers.test.ts` — cross-tenant scoping
- `tests/integration/audit-flow-constraint.test.ts` — flow enum DB-level enforcement

Per-platform required tests:

- [ ] **Cross-tenant scoping.** Verify every service function rejects cross-tenant access with NotFoundError (404, not 403).
- [ ] **End-to-end catch-up flow.** Click refresh-content -> endpoint -> enqueue -> handler -> events INSERT -> audit row -> cap counter increments. Mock queue dispatch and the adapter's local upstream client.
- [ ] **Cap exhaustion error codes.** Seed audit rows at cap, verify endpoint returns 429 with correct error code (`requests_quota_exhausted` / `events_quota_exhausted` / `platform_quota_exhausted` / `rate_limited`).
- [ ] **parseUrl coverage.** Each URL shape supported by the platform.
- [ ] **AuditFlow sync.** Update `tests/unit/audit-flow-sync.test.ts` if adding new flow values (also requires migration to extend the CHECK constraint — TS const + migration in lockstep).

---

## 7. Documentation

- [ ] Update `SOURCE-REFERENCE.md` if adapter introduces new patterns (rolling-window cap, OAuth refresh logic, etc.). Add platform-specific notes to existing sections.
- [ ] Document quota model in adapter's `observability.ts` header (cap shape, claim gates, and why `requiresSingletonRuntime` is set or not).
- [ ] Document migration rollback in each migration's header comment.

---

## 8. CI gates

Before merging the platform PR:

- [ ] `pnpm typecheck` — clean (svelte-check)
- [ ] `pnpm lint` — clean (eslint + prettier)
- [ ] `pnpm test:unit` — all pass
- [ ] `pnpm test:integration` — all pass on fresh DB
- [ ] `pnpm test:browser` — all pass (Playwright)
- [ ] CI smoke job — boots production image with no SaaS-only env vars, exercises OAuth, asserts cross-tenant 404 + anonymous-401 invariants.

---

## Known gaps

These are documented gaps that future platform authors may bump into. None are blockers — workarounds exist — but flagging here so you're not surprised:

- **Platform-specific upstream clients.** Keep upstream fetch methods local to the adapter server tree and call them from explicit handlers/capabilities. `SourceAdapter` should expose cross-source orchestration only; queue/quota/accounting boundaries must be visible at the call site.
- **Rolling-window quota shapes.** `userQuotaCap` only supports daily windows. Platforms with rolling caps (Reddit 600/10min) pick one of three documented options in `SOURCE-REFERENCE.md` §9.
- **Reddit public `.json` safety.** Current Reddit uses unauthenticated public JSON with conservative cadence. Before increasing usage, add UA validation, header-aware backoff, escalating adapter pause windows (10m/1h/3h/12h), and a UI degraded state that disables remote refresh chips while still allowing local URL/event/source creation.
- **UI server cast** (registry-ui.ts). `as unknown as AdapterUiServer` cast is a known type-narrowing smell. Will be cleaned up when the second UI adapter lands and the actual abstraction shape becomes concrete.

---

## Reference: YouTube file map

For copy-paste reference, the YouTube tree organizes as:

```
src/lib/sources/youtube/
├── server/
│   ├── adapter.ts                     ← local upstream client/helpers
│   ├── observability.ts               ← AdapterObservability declaration
│   ├── http.ts                        ← chargedFetch + AdapterError taxonomy
│   ├── quota.ts                       ← DB quota reservation + threshold gates
│   ├── snapshots.ts                   ← writeSnapshot (per-event stats UPSERT)
│   ├── metadata.ts                    ← oEmbed / video metadata fetch
│   ├── url.ts                         ← parseUrl regex
│   ├── route-metadata.ts              ← /api/youtube/fetch-metadata route
│   ├── index.ts                       ← barrel + youtubeAdapter declaration
│   ├── schema/                        ← per-source tables
│   └── handlers/
│       ├── backfill-channel.ts        ← refresh-content source discovery
│       ├── channel-context-backfill.ts ← onboarding (initial pull)
│       ├── auto-backfill-cron.ts      ← daily passive backfill picker
│       ├── poll-active.ts             ← Active-tier service_video producer
│       ├── poll-cold.ts               ← Cold-tier service_video producer
│       ├── refresh-queue-tick.ts      ← user_video/service_video SQL worker
│       ├── poll-cron.ts               ← cron dispatcher
│       ├── quota-reset.ts             ← daily quota reset hook
│       └── rehab-unavailable.ts       ← weekly service_video rehab producer
└── ui/
    ├── server.ts                      ← toCardProps
    └── index.ts                       ← optional client-side override
```

Most files are platform-specific. For Reddit/Twitter, `metadata.ts` / `route-metadata.ts` / some handlers may not apply — adapt as needed.
