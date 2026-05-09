# Adding a New Platform Adapter — Checklist

Step-by-step guide for adding a platform (Reddit, Twitter, Telegram, Discord, etc.) to `src/lib/sources/`. Follow in order. Reference the YouTube tree (`src/lib/sources/youtube/`) as the canonical reference implementation — it's production code with all edge cases handled, but ~30% of its content is platform-specific (tier polling, oEmbed metadata, channel-context-backfill) that doesn't translate. Filter signal from noise as you copy.

For deeper conceptual context (why backfill state machine, why two-layer cap, why pool_kind discriminator), read `SOURCE-REFERENCE.md` §8–9.

---

## 0. Pre-work — domain decisions

Before any code:

- [ ] **Quota model.** Document the platform's API rate-limit shape: per-key daily envelope (YouTube), per-OAuth-token rolling window (Reddit), per-app-bearer (Twitter), unlimited (Telegram). Determines `userQuotaCap` shape and `usesInProcessRateLimiter` declaration.
- [ ] **Auth shape.** Operator static keys (YouTube), per-user OAuth (Reddit/Twitter), unauthenticated scrape (Telegram public). Determines `observability.auth` declaration.
- [ ] **Pool attribution.** Will adapter use cron pool, user pool, or both? See §9 of SOURCE-REFERENCE.md. YouTube uses both.
- [ ] **External id stability.** What's the canonical id for posts/videos? Are URLs immutable? Determines `parseUrl` regex and `events.external_id` semantics.
- [ ] **Rolling-window cap shape.** If platform's quota is rolling (e.g., 600 req / 10 min), pick one of three documented options in `SOURCE-REFERENCE.md` §9 «Window-shape extensibility»: daily-equivalent / undefined / contract-extension.

---

## 1. Schema (per-source tables)

- [ ] Create `src/lib/sources/<kind>/server/schema/` directory.
- [ ] Define platform-specific tables in `<kind>/server/schema/*.ts`. Examples: `reddit_posts`, `reddit_metadata_fetch_log`, `reddit_token_refresh_log`. Public-data (cross-tenant) tables: NO `userId` column. Per-tenant tables: `userId` column required (AGENTS.md invariant 1).
- [ ] Re-export tables from `<kind>/server/schema/index.ts`.
- [ ] Add re-export to `src/lib/server/db/schema/index.ts` — **one line**: `export * from "$lib/sources/<kind>/server/schema/index.js";`. This is the only barrel-level edit needed for schema.
- [ ] Generate migration: `pnpm exec drizzle-kit generate`. Add migration to `drizzle/meta/_journal.json` if generated separately.
- [ ] Apply migration locally: `npx tsx -e "import('./src/lib/server/db/migrate.js').then(m => m.runMigrations())"`. Verify column shapes with `\d <table_name>` in psql.
- [ ] Document migration rollback in the migration's header comment (see `drizzle/0024_*.sql`, `drizzle/0026_*.sql` for examples). Forward-only by AGENTS.md, but documented rollback gives operators an emergency recovery path.

---

## 2. Adapter contract — required methods

Open `src/lib/sources/adapter.ts` and read `interface DataSourceAdapter`. Implement every required method in `<kind>/server/adapter.ts`. Reference: `src/lib/sources/youtube/server/adapter.ts`.

- [ ] `kind: SourceKind` — literal type from `SourceKind` enum in `db/schema/data-sources.ts`. Must be added to the enum if not already present (separate migration).
- [ ] `parseUrl(url): ParsedUrl | null` — first-match-wins URL recognizer. Returns `{kind, externalId}` on match, `null` otherwise. **Must be pure and side-effect-free** — registry iterates all adapters until one matches.
- [ ] `pollContent(source, since): Promise<{events, unitsUsed}>` — pull events newer than `since`. Returns exact `unitsUsed` count of upstream HTTP requests made. Empty `events` array means platform CONFIRMED no events newer than `since` (worker marks `backfill_complete=true`). Throws `AdapterError` for inability-to-fetch (rate-limit, network, parse error).
- [ ] `pollStats(events[], source, picked)` — user-driven stats refresh batch.
- [ ] `pollStatsByVideoId(externalIds[], quotaUser, picked)` — service-driven stats refresh (cron tier polls). May not apply to all platforms; YouTube uses this for video stats.
- [ ] `observability: AdapterObservability` — auth + quota + per-user cap declaration. Spread it from a separate file (`<kind>/server/observability.ts`).
- [ ] `registerQueues(boss)` — adapter owns its pg-boss queues. Worker bootstrap iterates all adapters and calls each.
- [ ] `scheduleCronTicks(boss)` — adapter owns its cron schedules.
- [ ] `backfillSource(source, ctx)` — enqueue a backfill job for this source. Returns `{jobId, queue}`.

## 2a. Adapter contract — optional methods

Implement only those that apply to your platform.

- [ ] `canRefreshPoll?(eventKind)` — opt into the «Refresh now» button per event kind.
- [ ] `reconcileRuntimeState?()` — sync in-process state (e.g., RateLimiterMemory reservoirs) with persistent counters at worker boot. Skip if adapter uses persistent state only.
- [ ] `canonicalizeOnCreate?(input, ctx)` — URL canonicalization at create time (e.g., resolve handle → channel id).
- [ ] `onSourceCreated?(source, opts)` — fire-and-forget hook after createSource (e.g., enqueue first backfill).
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
- [ ] `usesInProcessRateLimiter?` — true if adapter holds in-process state (RateLimiterMemory). Worker bootstrap refuses to start with `WORKER_REPLICA_COUNT > 1` if any adapter has this set.

---

## 3. Worker handlers

In `<kind>/server/handlers/`:

- [ ] **Backfill handler.** Reference: `src/lib/sources/youtube/server/handlers/backfill-user.ts`. Required logic:
  - [ ] Tenant-scoped source lookup (filter by `userId`).
  - [ ] `computeSinceForRefresh` to derive newSide / oldSide boundaries (shared helper, no adapter-specific code needed).
  - [ ] `flow` upgrade: if `oldSide !== null && flow === 'incremental'`, upgrade to `'historical'`.
  - [ ] Empty result → `markSourceBackfillComplete` + audit row with `unitsUsed`.
  - [ ] Non-empty: pre-INSERT SELECT for idempotency, INSERT events, update frontier, mark last_polled_at, audit row with adapter's reported `unitsUsed`.
  - [ ] Audit metadata MUST include `platform: '<kind>'` (cap query filter — see SOURCE-REFERENCE.md §9.1) AND `flow: AuditFlow` (closed enum — see `src/lib/server/audit.ts`).
- [ ] **Auto-backfill cron handler** (if applicable). Picks incomplete sources, enqueues passive backfill jobs.
- [ ] **Stats poll handlers** (if applicable). Tier-based (Active/Cold) for platforms with stable refresh windows.
- [ ] **Refresh-now handler** (if applicable). User-driven single-event poll. Bypasses cooldown gates handled at endpoint.

---

## 4. UI integration

- [ ] Create `<kind>/ui/server.ts` — `toCardProps(event): CardProps` projection for feed display.
- [ ] Create `<kind>/ui/index.ts` — optional client-side `cardComponent` override if FeedCard default doesn't fit.
- [ ] Register both in `src/lib/sources/registry-ui.ts` and `src/lib/sources/registry-ui-client.ts` — **one line each**.

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
- [ ] **End-to-end catch-up flow.** Click refresh-content → endpoint → boss enqueue → handler → events INSERT → audit row → cap counter increments. Mock `getBoss` and adapter's `pollContent`.
- [ ] **Cap exhaustion error codes.** Seed audit rows at cap, verify endpoint returns 429 with correct error code (`requests_quota_exhausted` / `events_quota_exhausted` / `platform_quota_exhausted` / `rate_limited`).
- [ ] **parseUrl coverage.** Each URL shape supported by the platform.
- [ ] **AuditFlow sync.** Update `tests/unit/audit-flow-sync.test.ts` if adding new flow values (also requires migration to extend the CHECK constraint — see Phase 03.0.1 lockstep convention).

---

## 7. Documentation

- [ ] Update `SOURCE-REFERENCE.md` if adapter introduces new patterns (rolling-window cap, OAuth refresh logic, etc.). Add platform-specific notes to existing sections.
- [ ] Document quota model in adapter's `observability.ts` header (cap shape, why `usesInProcessRateLimiter` is set or not).
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

## Known gaps (Phase 03.0.1 reference state)

These are documented gaps that future platform authors may bump into. None are blockers — workarounds exist — but flagging here so you're not surprised:

- **PickedKey threading** (Plan 04 deferred). `pollContent` / `pollStats` / `pollStatsByVideoId` accept `PickedKey` from the caller (caller-side credential picking). YouTube round-robins across multiple operator API keys. If your platform has N≥2 OAuth tokens and wants round-robin per request, you'll need to thread PickedKey through the same way. Plan 04 will refactor this so the adapter picks internally; until then, copy the YouTube pattern verbatim.
- **Rolling-window quota shapes** (Issue 6 deferred). `userQuotaCap` only supports daily windows. Platforms with rolling caps (Reddit 600/10min) pick one of three documented options in `SOURCE-REFERENCE.md` §9.
- **UI server cast** (registry-ui.ts:26). `as unknown as AdapterUiServer` cast is a known type-narrowing smell. Will be cleaned up when the second UI adapter lands and the actual abstraction shape becomes concrete.

---

## Reference: YouTube file map

For copy-paste reference, the YouTube tree organizes as:

```
src/lib/sources/youtube/
├── server/
│   ├── adapter.ts                     ← core contract methods
│   ├── observability.ts               ← AdapterObservability declaration
│   ├── http.ts                        ← chargedFetch + RateLimiterMemory
│   ├── quota.ts                       ← incrementUsage + threshold gates
│   ├── snapshots.ts                   ← writeSnapshot (per-event stats UPSERT)
│   ├── metadata.ts                    ← oEmbed / video metadata fetch
│   ├── url.ts                         ← parseUrl regex
│   ├── route-metadata.ts              ← /api/youtube/fetch-metadata route
│   ├── index.ts                       ← barrel + youtubeAdapter declaration
│   ├── schema/                        ← per-source tables
│   └── handlers/
│       ├── backfill-user.ts           ← refresh-content + auto-passive
│       ├── channel-context-backfill.ts ← onboarding (initial pull)
│       ├── auto-backfill-cron.ts      ← daily passive backfill picker
│       ├── poll-active.ts             ← Active-tier stats refresh (24h)
│       ├── poll-cold.ts               ← Cold-tier stats refresh (28d)
│       ├── poll-user.ts               ← Refresh-now button
│       ├── poll-cron.ts               ← cron dispatcher
│       ├── quota-reset.ts             ← daily quota reset hook
│       └── rehab-unavailable.ts       ← weekly privacy-flip recovery
└── ui/
    ├── server.ts                      ← toCardProps
    └── index.ts                       ← optional client-side override
```

Most files are platform-specific. For Reddit/Twitter, `metadata.ts` / `route-metadata.ts` / some handlers may not apply — adapt as needed.
