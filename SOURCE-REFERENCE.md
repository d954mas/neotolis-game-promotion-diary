# Source Plugin Reference

Adding a new source — Reddit, Twitter, Telegram, DTF, Pikabu, your-favorite-platform — should be a folder, not a refactor. This document describes how source plugins are organized, what contract each one implements, and the step-by-step path for landing a new one.

The canonical YouTube implementation under `src/lib/sources/youtube/` is the live reference. Read it alongside this document; the patterns shown here are extracted from there. When this document and the code disagree, the code wins — file a doc-update PR.

## 1. Overview

A **source plugin** is a self-contained module under `src/lib/sources/<kind>/` that owns everything a single platform needs:

- HTTP wrapper with rate-limit reservoir (cron / user pools)
- Credential resolution (operator keys today; per-user override post-Phase-6)
- URL parsing (paste flow → `externalId`)
- Polling logic (active tier, cold tier, user-initiated refresh, user-initiated backfill)
- Schema (per-source DB tables — channels metadata, video snapshots, quota counters)
- Worker handlers + queue topology + cron schedules
- UI props mapper (`CardProps` for `/feed`; `/admin/quota` per-kind tab)
- Observability surface (daily stats + recent audit)
- `AdapterError` taxonomy mapping for HTTP error paths

Cross-source plumbing — `events` table, `data_sources` table, `audit_log`, the `/feed` view, the events service, the ingest orchestrator, the source-CRUD service, the audit reader, the purge orchestrator — STAYS in `src/lib/server/` and is import-once / source-agnostic. The Thick Adapter principle (D-01): cross-source code never switches on `source.kind`. Adapters do.

### Why per-source plugins

1. **Isolation.** A bug in YouTube's quota counter cannot affect Reddit's OAuth refresh.
2. **Replaceability.** Swapping the YouTube path for a new vendor / new API version is one folder of edits, not a tour through the codebase.
3. **Discoverability.** "Where does Reddit's URL parser live?" → `src/lib/sources/reddit/server/url.ts`. Always.
4. **Onboarding.** A new contributor reads `src/lib/sources/youtube/` once and can ship `src/lib/sources/reddit/` from there.

The architecture decisions that locked these properties live in `.planning/phases/03.0.1-source-plugin-architecture/03.0.1-CONTEXT.md` (D-01..D-17). This document operationalises them.

## 2. Folder Structure

The shipped tree as of Phase 03.0.1:

```
src/lib/sources/
├── adapter.ts              ← Widened DataSourceAdapter interface; SourceKind / EventKind unions; AdapterContext; MinimalBoss
├── card-props.ts           ← Universal CardProps interface (toCardProps return shape)
├── errors.ts               ← AdapterError 5-category taxonomy + categoryToSnapshotStatus
├── event-to-source-kind.ts ← EventKind → SourceKind helper for /feed dispatch
├── future-kinds.ts         ← detectFutureKind for friendly deferral messages (e.g. Reddit before Phase 03.1)
├── index.ts                ← Cross-source barrel (re-exports adapter / errors / card-props / future-kinds / registry / registry-ui / event-to-source-kind)
├── registry.ts             ← getAdapter(kind); allAdapters[] (registration order = priority)
├── registry-ui.ts          ← getAdapterUI(kind) — server-safe; imports per-kind ui/server.ts
├── url.ts                  ← parseAnyUrl(input) — first-match-wins iteration over allAdapters
└── youtube/                ← Per-source plugin (the canonical reference)
    ├── server/             ← Server-only code
    │   ├── adapter.ts                ← Implements DataSourceAdapter. registerQueues / scheduleCronTicks / backfillSource are bypass-the-barrel throwing stubs here; real impls live in ./index.ts (see Pattern 4.6).
    │   ├── credentials.ts            ← pickCredentials(ctx) — operator-only today; Phase 6 extension point
    │   ├── http.ts                   ← chargedFetch + fetchWithTimeout + RateLimiterMemory cron/user reservoirs + AdapterError mapping
    │   ├── url.ts                    ← parseYoutubeUrl (channelId/handle/videoId triple) AND youtubeParseUrl (D-15 ParsedUrl contract)
    │   ├── observability.ts          ← youtubeObservability — auth + getDailyStats + getRecentAudit
    │   ├── quota.ts                  ← pickKeyForJob, hashApiKeyId, incrementUsage, markThrottleTransition, todayPacific, youtubeQuotaUser
    │   ├── snapshots.ts              ← writeSnapshot — idempotent UPSERT into youtube_video_snapshots
    │   ├── metadata.ts               ← Channel resolution helpers (resolveChannelContext)
    │   ├── route-metadata.ts         ← Hono sub-router for /api/youtube-metadata/*
    │   ├── index.ts                  ← Barrel: { youtubeAdapter } — spreads youtubeChannelAdapter and overrides registerQueues + scheduleCronTicks + backfillSource with real implementations
    │   ├── schema/                   ← Drizzle pgTable definitions (auto-discovered by drizzle.config.ts glob)
    │   │   ├── channels.ts
    │   │   ├── videos.ts
    │   │   ├── video-snapshots.ts
    │   │   ├── service-quota-usage.ts
    │   │   ├── metadata-fetch-log.ts
    │   │   └── index.ts              ← Barrel re-export consumed by src/lib/server/db/schema/index.ts
    │   └── handlers/                 ← pg-boss queue handlers
    │       ├── poll-cron.ts          ← QUEUES.YOUTUBE_POLL_CRON entry point — dispatches by job.data.tier
    │       ├── poll-active.ts        ← Active-tier batch logic (called by poll-cron when tier=active)
    │       ├── poll-cold.ts          ← Cold-tier batch logic (called by poll-cron when tier=cold)
    │       ├── poll-user.ts          ← QUEUES.YOUTUBE_POLL_USER (user-initiated refresh-poll, per-event)
    │       ├── backfill-user.ts      ← QUEUES.YOUTUBE_BACKFILL_USER ("Pull new content" button, per-source)
    │       ├── channel-context-backfill.ts
    │       ├── quota-reset.ts
    │       └── rehab-unavailable.ts
    └── ui/                  ← Client-importable code
        ├── card-props.ts    ← toCardProps(event) → CardProps mapper — pure function, server-safe
        ├── server.ts        ← Server-safe re-export (no Svelte component imports — Pitfall 7 mitigation)
        └── index.ts         ← Client-safe entry (re-exports ./server.js + future Svelte components)
```

Cross-source schema (`events`, `data_sources`, `audit_log`, `games`, `event_games`, `game_steam_listings`, `api_keys_steam`, Better Auth tables) STAYS in `src/lib/server/db/schema/`. Drizzle config (`drizzle.config.ts`) walks both globs:

```typescript
schema: [
  "./src/lib/server/db/schema/*.ts",
  "./src/lib/sources/*/server/schema/*.ts",
],
```

The universal card shell (`src/lib/components/EventCard.svelte`) lives in cross-source UI components — it consumes `CardProps` from any per-source `toCardProps` mapper and renders the visual layout. The D-04 escape hatch (per-source full Svelte component override) is available but not used in 03.0.1.

## 3. Step-by-Step: Adding a New Source (e.g. Reddit)

Walking through Reddit. Substitute `reddit_account` / `reddit_post` / `reddit` etc. for any new source.

### 3.1 Verify the SourceKind / EventKind unions cover your kind

Open `src/lib/sources/adapter.ts`. The `SourceKind` and `EventKind` unions already include `reddit_account` / `reddit_post` / `twitter_account` / `twitter_post` / `telegram_channel` / `telegram_post` / `discord_server` / `discord_drop`. New kinds beyond this set need adding here. The `event-to-source-kind.ts` helper also maps any new pair.

### 3.2 Create the per-source folder

```bash
mkdir -p src/lib/sources/reddit/server/{schema,handlers}
mkdir -p src/lib/sources/reddit/ui
```

### 3.3 Define the per-source schemas

Create one file per table under `src/lib/sources/reddit/server/schema/`. Reddit examples:
- `accounts.ts` — operator-OAuth-refreshed account credentials (envelope-encrypted; mirror `api_keys_steam` shape)
- `posts.ts` — post metadata cache (subreddit, post id, permalink) keyed by post id (public-data, no `user_id`)
- `post-snapshots.ts` — immutable time-series of `(post_id, polled_at, upvotes, comment_count, awards)`
- `index.ts` — barrel re-export

The cross-source schema barrel (`src/lib/server/db/schema/index.ts`) re-exports from per-source `schema/index.ts` files. drizzle-kit auto-discovers via the `src/lib/sources/*/server/schema/*.ts` glob in `drizzle.config.ts`. Run `pnpm db:generate` to produce the migration; review the SQL; commit. No `down` migrations — `drizzle-kit migrate` runs forward-only at boot under an advisory lock.

### 3.4 Implement the HTTP wrapper

Copy the YouTube `http.ts` pattern (`src/lib/sources/youtube/server/http.ts`). Key points:
- Reservoirs: `RateLimiterMemory` cron pool ~80%, user pool ~20%. Reddit's free tier is 60 req/min OAuth-bearer; default reservoir 48 cron / 12 user per minute.
- AdapterError mapping: 429 → `rate-limited`; 401/403 → `operator-issue` (OAuth refresh); 404 → `not-found`; 5xx → `transient`.
- OAuth refresh: detect 401 once, refresh the bearer via `client_credentials` grant, retry once. Phase 6 placeholder for per-user refresh-token override.

The reservoir is a fast-path approximation; the persistent counter table (`src/lib/sources/<kind>/server/quota.ts`) is the AUTHORITATIVE state. Reconcile reservoirs on worker boot from the durable counter (see `reconcileReservoirsOnBoot` in YouTube's `http.ts`).

### 3.5 Implement the adapter

In `src/lib/sources/reddit/server/adapter.ts`, export `redditChannelAdapter: DataSourceAdapter`. Implement the contract methods (`src/lib/sources/adapter.ts` is the contract source of truth):
- `kind: "reddit_account"`
- `pollContent(source, since)` — list latest `/user/<account>/submitted` with `?after=` for incremental
- `pollStats(events, source, picked)` — batch `/by_id/t3_xxx,t3_yyy`
- `pollStatsByVideoId(externalIds, quotaUser, picked)` — service-driven path (rename for non-video kinds is fine; the contract method name is legacy from Phase 03.0)
- `parseUrl(url)` — host check FIRST (`reddit.com` / `redd.it` / `old.reddit.com`); extract subreddit + post-id from `/r/<sub>/comments/<id>/...` (Pattern 4.4)
- `observability` — `auth.kind === "operator-oauth-app-only"`; `quota.getDailyStats` reads a Reddit-specific quota counter
- `canRefreshPoll?(eventKind)` — optional dispatch hint for `POST /api/sources/:id/refresh-content`

The methods that need pg-boss / scheduler infrastructure (`registerQueues`, `scheduleCronTicks`, `backfillSource`) MUST follow the bypass-the-barrel safety pattern: throwing stubs in `adapter.ts`, real implementations in `./index.ts` (Pattern 4.6).

### 3.6 Wire the registry

In `src/lib/sources/registry.ts`:
```typescript
import { redditAccountAdapter } from "./reddit/server/index.js";
const registry = new Map<SourceKind, DataSourceAdapter>([
  ["youtube_channel", youtubeAdapter],
  ["reddit_account",   redditAccountAdapter],
]);
```
Same edit shape for `registry-ui.ts` (importing the per-kind `ui/server.ts`). That is the ENTIRE bootstrap edit. Cross-source code (refresh-poll, ingest, `/feed` loader, `/admin/quota`, `POST /api/sources/:id/refresh-content`) automatically picks up the new adapter via `getAdapter` / `allAdapters` / `getAdapterUI` — the architecture payoff.

Registration order in the registry IS priority for `parseAnyUrl` (D-15 first-match-wins). YouTube is registered first today so it wins on `youtube.com` / `youtu.be` host matches; future overlap (e.g. Telegram previewing a YouTube link) is resolved by ordering the more-specific adapter ahead of the more-general one.

### 3.7 UI props mapper

Create `src/lib/sources/reddit/ui/card-props.ts` exporting `toCardProps(event) → CardProps` for `reddit_post` events. The shape (`CardProps`) lives in `src/lib/sources/card-props.ts`. Re-export via `ui/server.ts` (server-safe — no Svelte imports) and `ui/index.ts` (client-safe — adds Svelte components if any). The server-safe split is non-negotiable (RESEARCH.md Pitfall 7: SvelteKit pre-render crashes when a server module transitively imports `.svelte` files outside a Svelte context).

### 3.8 Tests

Mirror the YouTube test files under `tests/unit/sources/reddit/` (HTTP wrapper, parseUrl, card-props mapper) and `tests/integration/`. The cross-source tests AUTOMATICALLY cover the new kind once the registry has the entry — no edit needed for `tests/integration/api-sources-refresh-content.test.ts` to start exercising the new endpoint behavior, no edit needed for `tests/integration/anonymous-401.test.ts` MUST_BE_PROTECTED (the path is parameterised), no edit needed for `tests/integration/tenant-scope.test.ts` (the matrix sweep iterates registered kinds).

The CI gates (`lint-typecheck` / `unit-integration` / `smoke`) cover the new adapter the moment it's registered.

## 4. Common Patterns

### 4.1 chargedFetch with token bucket reservoir

Every adapter HTTP wrapper consumes from a per-origin reservoir BEFORE the request:

```typescript
const cronReservoir = new RateLimiterMemory({ points: BUDGET * 0.8, duration: WINDOW_SECONDS });
const userReservoir = new RateLimiterMemory({ points: BUDGET * 0.2, duration: WINDOW_SECONDS });

export async function chargedFetch(url, picked, units, ctx) {
  const reservoir = ctx.origin === "cron" ? cronReservoir : userReservoir;
  try {
    await reservoir.consume(picked.apiKeyId, units);
  } catch (rejRes) {
    throw new AdapterError("Reservoir exhausted", { category: "rate-limited", retryAfterMs: rejRes.msBeforeNext });
  }
  // ... fetch + status-to-AdapterError mapping ...
}
```

Reconcile reservoirs on worker boot from the persistent counter table (`src/lib/sources/<kind>/server/quota.ts`). The reservoir is ORIGIN-SCOPED (cron vs user) so a user-driven Refresh-now flood cannot eat into the cron reserve and vice versa. See `src/lib/sources/youtube/server/http.ts` for the full canonical implementation.

### 4.2 OAuth refresh (Phase 6 future-shape — Reddit / Twitter)

The OAuth-refresh path is internal to the credentials wrapper:

```typescript
// src/lib/sources/reddit/server/credentials.ts
export async function pickCredentials(ctx: AdapterContext): Promise<RedditCredentials> {
  // 1) Operator app-only bearer (refreshed by a sidecar cron job)
  // 2) Phase 6: if ctx.userId is set AND the user has a per-user OAuth row, use that
  //    Until Phase 6, ctx.userId is informational only.
  return loadOperatorBearer();
}
```

YouTube's `pickCredentials` (`src/lib/sources/youtube/server/credentials.ts`) is the v0.1 reference: operator-only, ctx.userId informational, single edit point for Phase 6 per-user override (D-05).

### 4.3 Snapshot UPSERT (idempotent)

```typescript
// src/lib/sources/reddit/server/snapshots.ts
export async function writeSnapshot(s: StatsSnapshot): Promise<void> {
  await db.insert(redditPostSnapshots).values({
    postId: s.eventId,
    polledAt: roundToMinute(s.polledAt),
    upvotes: s.metrics?.upvotes ?? 0,
    // ... other metrics ...
  }).onConflictDoNothing();
}
```

The unique constraint `(post_id, polled_at, metric_key)` (with `polled_at` truncated to the minute) makes worker retries within the same minute a no-op. See `src/lib/sources/youtube/server/snapshots.ts` for the canonical pattern.

### 4.4 URL parsing — host check FIRST

```typescript
const RD_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com", "redd.it"]);

export function redditParseUrl(input: string): ParsedUrl | null {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (!RD_HOSTS.has(host)) return null; // host check FIRST — avoids non-Reddit URLs leaking into reddit_post
  const m = url.pathname.match(/^\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);
  if (!m) return null;
  return { kind: "reddit_post", externalId: m[2], metadata: { subreddit: m[1] } };
}
```

The host check FIRST is load-bearing: without it, a URL like `https://example.com/r/IndieDev/comments/abc/title` would round-trip through the path matcher and leak into the `reddit_post` kind. See `src/lib/sources/youtube/server/url.ts` `youtubeParseUrl` for the canonical implementation.

Order in the registry = priority (first-match-wins). Adapters with overlapping host claims (rare) must NOT happen — host claims are exclusive by convention.

### 4.5 AdapterError taxonomy

Every non-2xx response THROWS an `AdapterError` with one of 5 categories:

| Category        | Examples                                           | System action                                   |
| --------------- | -------------------------------------------------- | ----------------------------------------------- |
| `transient`     | 5xx, network timeout                               | pg-boss retries with backoff                    |
| `rate-limited`  | 429, quotaExceeded 403, reservoir exhausted        | Adapter HTTP wrapper waits; cron defers if budget exhausted |
| `not-found`     | 404, video deleted, post removed                   | Mark `event.status = unavailable`; tier → Frozen |
| `permanent`     | ToS block, scraping HTML changed                   | Mark unavailable; stop polling; alert operator  |
| `operator-issue`| 401/403 non-quotaExceeded, no keys configured, OAuth secret rotated | Set `data_sources.needs_reconnect`; surface in `/admin/quota` |

The cross-source worker-handler wrapper routes:

```typescript
try { /* ... */ } catch (err) {
  if (err instanceof AdapterError) {
    if (err.category === "rate-limited" || err.category === "transient") throw err; // pg-boss retries
    if (err.category === "operator-issue" || err.category === "permanent") {
      await markSourceNeedsReconnect(...);
      return;
    }
    if (err.category === "not-found") { /* mark event unavailable */; return; }
  }
  throw err;
}
```

`AdapterError` is defined in `src/lib/sources/errors.ts`. Schema columns `data_sources.needs_reconnect`, `last_error_at`, `last_error_kind` (added in migration `0022_phase03_01_data_sources_error_state.sql`) carry the persistent error state. Phase 6 will add a 6th category `user-auth` when per-user credentials land — adding a category is intentionally a breaking change that surfaces as a TypeScript exhaustiveness error in `categoryToSnapshotStatus` (the switch has no `default` branch).

### 4.6 Three-layer barrel override (registerQueues / scheduleCronTicks / backfillSource)

The methods that consume side-effect infrastructure (pg-boss, scheduler) cannot live in `adapter.ts` cleanly without circular imports. The shipped pattern:

1. **Throwing stub in `adapter.ts`** — catches consumers that import `adapter.ts` directly (bypass-the-barrel bug). The stub's error message points at the barrel.
2. **Real implementation in `./index.ts`** — consumes `getBoss()`, `QUEUES.*`, etc.
3. **Spread-and-override export** in `./index.ts`:
   ```typescript
   export const youtubeAdapter: DataSourceAdapter = {
     ...youtubeChannelAdapter,    // spreads pollContent / pollStats / parseUrl / observability / ...
     registerQueues,              // overrides the throwing stub
     scheduleCronTicks,           // overrides the throwing stub
     backfillSource,              // overrides the throwing stub
   };
   ```

Production callers go through the barrel (`src/lib/sources/youtube/server/index.ts`); the registry imports `youtubeAdapter` from there. Direct `adapter.ts` imports — a bug at the import site — trip the throw with a clear error message. New adapters follow the same pattern for any DataSourceAdapter method that consumes infrastructure the bare `adapter.ts` cannot reach.

### 4.7 Adapter dispatch from cross-source endpoints

Cross-source code calls `getAdapter(source.kind).<method>` and never switches on `source.kind`. The canonical example is `POST /api/sources/:id/refresh-content` (`src/lib/server/http/routes/sources.ts`):

```typescript
const adapter = getAdapter(source.kind);  // throws on unknown kind; the route's try/catch maps to AppError 422
const result = await adapter.backfillSource(source, ctx);
await writeAudit({ action: "source.refresh_content_requested", metadata: { source_id, kind, queue: result.queue, job_id: result.jobId } });
return c.json({ enqueued: true, queue: result.queue, jobId: result.jobId }, 202);
```

The `getAdapter`-throws path is wrapped in a `try/catch` so a kind that exists in the schema but has no registered adapter (e.g. mid-deploy of Phase 03.1, or a self-host operator who registered a kind without wiring its adapter) returns 422 `kind_not_yet_functional` rather than crashing the route.

### 4.8 Universal CardProps mapper

The `/feed` page resolves a per-event `CardProps` shape via:

```typescript
const sourceKind = eventKindToSourceKind(event.kind);
const cardProps = sourceKind !== null
  ? getAdapterUI(sourceKind).toCardProps(event)
  : genericCardProps(event); // fallback for free-form kinds (post / conference / talk / press / other)
```

The `eventKindToSourceKind` helper (`src/lib/sources/event-to-source-kind.ts`) bridges the EventKind → SourceKind gap because `events.kind` is granular (`youtube_video`, `reddit_post`, ...) while the registry is keyed by source kind (`youtube_channel`, `reddit_account`, ...). Free-form kinds (`post`, `conference`, etc.) return `null` — callers fall back to a generic mapper.

## 5. Anti-Patterns

- **Switch on `source.kind` outside `src/lib/sources/`.** Cross-source code calls `getAdapter(kind)` for any per-kind logic. The temptation is real (refresh-poll's "is this kind pollable?" check is the canonical example) — resist via an adapter-contract method like `canRefreshPoll(eventKind)`.
- **Duplicating `fetchWithTimeout` across adapters.** Each adapter has ITS OWN HTTP wrapper because rate-limit policy is per-source — but the timeout + AbortController shape is identical. Resist the urge to extract; prefer copy + adapt. Premature abstraction (AGENTS.md Philosophy: "three concrete callers earn an abstraction; one or two does not") is a worse outcome than two near-identical timeout helpers.
- **Skipping observability.** Every adapter MUST implement `observability.auth` + `observability.quota.{getDailyStats, getRecentAudit}`. `/admin/quota`'s per-kind tab depends on it.
- **Ignoring the rate-limit reserve.** Don't let cron-heavy days starve user-initiated calls. The reservoir split (D-09) is the floor; UI clicks that hit `rate-limited` because cron used 100% of the daily budget breaks the UX promise.
- **Throwing bare `new Error("...")`** in adapter HTTP wrapper. Always wrap in `new AdapterError(message, { category, ... })`. Cross-source can't otherwise distinguish retry-able from operator-action-required.
- **Reading `process.env`** outside `src/lib/server/config/env.ts`. ESLint enforces via `no-restricted-properties`. Adapters import env via `$lib/server/config/env.js`. The single approved exception is `drizzle.config.ts` (dev-only tool, runs outside the app process).
- **Hand-rolling rate-limit logic.** Use `rate-limiter-flexible` (already in `package.json`). YouTube's reservoir is in-memory `RateLimiterMemory`; if multi-process, swap to `RateLimiterPostgres`.
- **Using `<svelte:component this={X}>`** — deprecated in Svelte 5 runes mode. Use `{@const C = X}; <C ... />`.
- **In-process plaintext-secret cache.** AGENTS.md AP-3. Adapters NEVER cache user secrets across calls; the operator's plaintext key is read from env at call time via `pickCredentials`.
- **Try/catch after `db.insert(...)` that "cleans up" a half-write.** Validate-first; INSERT only after pass. The audit log carries an INSERT-only trigger (migration 0019); attempting to clean up a half-write would either fail at the trigger or leave a dangling row.
- **`403 Forbidden` for cross-tenant access on tenant-owned resources.** Use 404 with `{error: "not_found"}`. The response body MUST NOT contain the literal strings "forbidden" or "permission" for tenant-owned resources (AGENTS.md invariant 2). `ForbiddenError` is reserved for Phase 6+ admin endpoints only.

## 6. Testing

### 6.1 Unit tests (`tests/unit/sources/<kind>/...`)

- HTTP wrapper: reservoir `consume`, `AdapterError` mapping by status code, OAuth-refresh single-retry path.
- `parseUrl`: host check FIRST (Pattern 4.4), `externalId` extraction across URL shapes, returns null on non-host or unparseable input.
- `card-props` mapper: variants (ok / no-stats / authorIsMe), thumbnail rule, `formatStat` formatting.

Mock at the module level via `vi.mock(...)`; the YouTube tests under `tests/unit/sources/youtube/` are the reference (e.g. `tests/unit/sources/youtube/card-props.test.ts`).

### 6.2 Integration tests (`tests/integration/...`)

- Adapter against real DB + mocked HTTP: enqueue a poll job, assert snapshot row written, assert `data_sources.needs_reconnect` set on `operator-issue` AdapterError.
- Cross-tenant 404: any new endpoint follows the `tests/integration/tenant-scope.test.ts` matrix (body MUST NOT contain "forbidden" / "permission").
- Anonymous-401 sweep: every new `/api/*` route added to `MUST_BE_PROTECTED` allowlist in `tests/integration/anonymous-401.test.ts` + a per-route 401 assertion (both layers required by AGENTS.md §3 — the sweep is the vacuous-pass guard, the per-route assertion is the explicit assertion).
- Audit log: assert `audit_log` row inserted with the expected `action` verb and metadata payload shape.

### 6.3 Smoke (`tests/smoke/self-host.sh`)

Self-host parity gate. Boots the production Docker image with mock APIs (e.g. `tests/smoke/lib/youtube-mock.sh`); asserts the polling pipeline writes a snapshot, cron registrations happen, cross-tenant + anonymous-401 invariants hold under the production code path. NEW sources extend the smoke gate IF they introduce new cron registrations or new mock APIs. Reddit's smoke addition: a Reddit-mock reverse-proxy + assertion that a `reddit_post` snapshot is written end-to-end.

The smoke job in `.github/workflows/ci.yml` is the load-bearing trust signal — when it's green, a self-host operator can deploy with confidence. CI runs all three jobs (`lint-typecheck`, `unit-integration`, `smoke`) on every PR.

## 7. Phase 6 Future: Per-User Credentials

v0.1 (today) ships **operator-only credentials everywhere** (D-05). Phase 6 trigger: "≥1 power user trips 95% of operator quota for one source." When that fires, the adapter's `pickCredentials(ctx)` extends:

```typescript
export async function pickCredentials(ctx: AdapterContext): Promise<Credentials> {
  if (ctx.userId !== null) {
    const userKey = await loadUserKey(ctx.userId);
    if (userKey !== null) return userKey;
  }
  return loadOperatorKey();
}
```

NO contract change required. The widened `DataSourceAdapter` interface already passes `ctx.userId` through every method that takes `AdapterContext`. Phase 6 adds a 6th `AdapterError` category `user-auth` (when the per-user key is invalid; revoked; missing) which the cross-source handler routes to "user must reconnect their key" UI.

Other Phase 6 items tracked in the deferred-ideas list (`.planning/phases/03.0.1-source-plugin-architecture/03.0.1-CONTEXT.md` § Deferred Ideas):
- Per-user QUOTA-01 dashboards (re-uses `observability.quota.getDailyStats` API contract — no adapter edit).
- Per-user 429 surfacing UI (toast + badge; reads `adapter.observability` per-user when `ctx.userId` is set).
- Reddit per-user OAuth (phase trigger; replaces operator app-only with per-user refresh-token flow).
- Reserved-budget split refinements: burst-allow during low traffic, time-of-day shifts, borrow-from-cron when user pool unused.

---

**Maintenance.** This document describes the SHIPPED architecture as of Phase 03.0.1 (2026-05-08). When Phase 03.1 (Reddit) lands, the Reddit-specific adapter sections may surface refinements that update sections 4-6. Updates land via PR; squash-merge per AGENTS.md Workflow.

**Canonical reference.** The YouTube tree (`src/lib/sources/youtube/`) IS the live reference. When this doc and the code disagree, the code wins; file a doc-update PR.

---

## 8. Backfill State Machine — Phase 03.0.1

Each `data_sources` row carries 4 columns that drive catch-up worker logic + UI display. Migration `drizzle/0024_phase03_01_data_sources_backfill_state.sql`.

| Column | Type | Semantics |
|--------|------|-----------|
| `last_polled_at` | `timestamptz NULL` | When we last ran any backfill action на этот source. UI displays "обновлено N часов назад". Updated по успеху ВСЕХ backfill flows (initial, incremental, historical, stats_refresh, auto_passive). |
| `backfill_oldest_at` | `timestamptz NULL` | Frontier — earliest event.occurred_at we've successfully pulled через auto-import flows. Resume marker для catch-up. NULL until first INSERT. |
| `backfill_complete` | `boolean NOT NULL DEFAULT false` | True когда `pollContent` returned empty HTTP-200 page (platform "no more older" confirmed). User refresh resets к false (trust-but-verify). Auto-cron skips sources with complete=true. |
| `backfill_target_since` | `timestamptz NULL` | Absolute date — earliest boundary user wants pulled. Worker passes напрямую в `pollContent(source, since)`. Sentinel `1970-01-01` = "all available history". |

**State derivation для UI:**

```typescript
function deriveCoverageBadge(s: SourceRow, quotaExhausted: boolean): Badge {
  if (s.lastPolledAt === null) return "never_polled";
  if (s.backfillComplete) return "caught_up";
  if (quotaExhausted) return "quota_exhausted";
  return "has_more";
}
```

`quotaExhausted` derived live из quota counter (`getUserQuotaUsedToday`) — never stored, никакой sync issue.

### `pollContent` contract — empty-vs-throws semantics

Adapter's `pollContent(source, since): Promise<RawEvent[]>` MUST distinguish:

- **HTTP 200 + `[]` (empty array)** = «API явно подтвердил: больше нет событий newer than `since`». Worker sets `backfill_complete = true`.
- **`throw AdapterError`** = «не смогли определить» (rate-limit / network / parse failure). Worker leaves `backfill_complete` as-is; pg-boss retries.

YouTube + Reddit + Twitter satisfy this naturally (their listing endpoints return distinct `{items: []}` vs HTTP 4xx/5xx). Scrape-based platforms (Telegram, Discord) MAY need a richer return type if rate-limit pages can't be distinguished from "no content"; future non-breaking extension shape:

```typescript
type PollContentResult = RawEvent[] | { events: RawEvent[]; hasMore: boolean };
```

Existing adapters keep returning array; new adapters opt into `{events, hasMore}` if needed.

---

## 9. Per-User Fair-Share Quota — Phase 03.0.1

Two-layer cap protects (1) operator's API budget, (2) per-user fairness when one user might monopolize shared budget.

### L1 Operator-side reservoir (Plan 08, existing)

`chargedFetch` consumes из `RateLimiterMemory` reservoir с per-day points. Throttle states:

- `< 80%` → all flows pass.
- `≥ 80% (eighty)` → cold tier polls skip (auto-backfill также skip at ≥50% — see § 9.3).
- `≥ 95% (ninetyfive)` → all flows skip; refresh-content endpoints return `429 platform_quota_exhausted` (system-wide signal).

### L2 Per-user fair-share cap (Phase 03.0.1, NEW)

Adapter declares optional cap в `observability.userQuotaCap`:

```typescript
interface AdapterUserQuotaCap {
  requestsPerDay?: number; // API calls cap
  eventsPerDay?: number; // items inserted cap (optional secondary)
}
```

Both fields optional. Cap query (`services/quota.ts:getUserQuotaUsedToday`) sums `audit_log.metadata.{requests_used, events_inserted}` for the current Pacific calendar day, scoped к user-initiated capped flows. Endpoint cap-check fires `429 requests_quota_exhausted` или `429 events_quota_exhausted` с `{cap, used, reset_in_seconds}` metadata.

YouTube default: `requestsPerDay: 100` (~5000 events worth at 50:1 ratio). No `eventsPerDay`. Reddit Phase 03.1+ may declare both axes (variable events-per-request).

### Counter vs Cap — separate concerns

Two independent concepts that look similar:

- **Daily counter (universal):** `getUserQuotaUsedToday(userId, kind)` returns `{requests, events}` summed from `audit_log.metadata.{requests_used, events_inserted}` for the current Pacific calendar day. Platform-agnostic — every adapter writes audit rows with the same shape; `QuotaStatusBanner.svelte` renders this for every registered platform regardless of cap declaration.
- **Cap (optional, platform-shape):** `userQuotaCap` is an OPTIONAL declaration on the adapter. Adapters with no daily cap declare `userQuotaCap: undefined` (or omit `requestsPerDay`); banner shows the counter without progress-bar overlay (`«no limit»` label). Adapters with daily caps declare them; banner adds progress-bar.

User sees daily activity for every platform — the counter is the universal observability layer. Cap is a thin progress-overlay on top.

### Window-shape extensibility (deferred)

`userQuotaCap` currently expresses only daily windows. Adapters with rolling-window quotas (Reddit's documented 600 requests / 10-minute rolling window) have three options when their adapter PR lands:

1. **Approximate daily-equivalent** — declare `requestsPerDay: 86400` (10-min × 144 windows). User-facing display reads cleanly; strictly speaking inaccurate (rolling ≠ daily), but UX-friendly.
2. **Declare `userQuotaCap: undefined`** — banner shows daily counter without cap overlay. Rolling cap enforcement happens at endpoint level via separate mechanism.
3. **Extend the contract** — add a window-shape field (`{count, windowMinutes}`) to `AdapterUserQuotaCap`. Banner becomes polymorphic: «200/600 in last 10 min, resets in 7 min». Most honest, costs additional banner code.

Choice deferred per AGENTS.md «3 callers earn an abstraction»: with one current declarer (YouTube daily), pre-emptive contract widening is premature. Reddit Phase 03.1 will trigger the concrete decision based on real platform requirements.

### 9.1 Audit metadata schema

Worker handlers write audit row at completion с full metadata:

```jsonc
{
  "source_id": "<uuid>",
  "kind": "youtube_channel", // platform (= source.kind)
  "flow": "incremental" | "historical" | "stats_refresh" | "initial" | "auto_passive",
  "queue": "youtube.backfill.user" | "youtube.channel_context_backfill" | "youtube.poll.user",
  "job_id": "<pg-boss job id>",
  "requests_used": 0,
  "events_inserted": 0
}
```

**Cap counts** `flow IN ('initial', 'incremental', 'historical', 'stats_refresh')`:

- `initial` — onboarding channel-context-backfill at createSource. User explicitly added the source; API budget burned under their identity; MUST count or the cap counter lies. Pre-fix this was excluded «for UX» but that created a discrepancy between Today (excluded) and Lifetime (included), confusing users about real consumption. If onboarding burn is large enough to matter for cap, the user adding 30+ channels in one day is exactly the abuse the cap is designed to gate.
- `incremental` — refresh-content button (default catch-up).
- `historical` — refresh-content with explicit older date (PATCH backfill_target_since + refresh).
- `stats_refresh` — per-event refresh-card button (1 unit per call).

**Excluded** (NOT counted в user cap):

- `auto_passive` — auto-backfill cron pick. Uses cron pool reservoir, not user pool. Cron-driven, no user-initiated trigger.

Cron pool reservoir (Plan 08 8000 units/day) is independent of user pool (2000 units/day). Auto-backfill workers consume cron pool; user-driven actions consume user pool. Per-user cap protects user pool fairness.

**Flow enum enforced two ways:**

- **TypeScript** — `AuditFlow` literal union in `src/lib/server/audit.ts` types the `metadata.flow` field on every `writeAudit` call. Typo at write site fails `tsc`.
- **PostgreSQL CHECK constraint** — `audit_log_metadata_flow_valid` (migration 0025) pins `metadata->>'flow'` to the same enum at INSERT time. Defends against raw-SQL writes and accidental drift through the open-shape `[extra: string]: unknown` index signature on `AuditMetadata`.

Adding a new flow value requires (a) extending the `AuditFlow` union AND (b) a new migration that DROPs and re-ADDs the constraint with the expanded list — both in lockstep so type and DB never diverge.

### 9.2 Cap window — Pacific calendar day

Cap counter window: from `pacificDayStart()` (00:00 PT today) to NOW. Reset boundary: `nextPacificMidnight()`.

Sync с operator's chargedFetch reservoir reset cycle (Plan 08 also Pacific calendar day). Single global cycle; UI displays "resets in {humanizeDuration(nextPacificMidnight - now)}" — works в любом user timezone.

**Operator-local TZ assumption.** Pacific midnight is hardcoded because YouTube Data API quota resets at 00:00 PT (Google's operator agreement). When other adapters land with different reset cycles (Reddit, Twitter — both UTC-day-based by docs as of Phase 03.0.1 research), they will either share this Pacific cycle (acceptable approximation — banner displays one global reset countdown) or trigger a per-platform reset boundary if user-confusion measurable. Self-host operators in non-PT timezones see the cap window drift relative to their local midnight, but the operator API budget itself resets on the platform's schedule, not the operator's wall clock — so the cap window must follow the platform, not the operator. Documented as known constraint, not a bug.

### 9.3 Auto-backfill cron priority

Daily 03:00 PT cron picks incomplete sources и enqueues passive backfill:

| Tier                          | Skip threshold | Why                                                                |
| ----------------------------- | -------------- | ------------------------------------------------------------------ |
| Active poll (every 6h)        | `≥95%`         | Stats freshness for recent videos — highest priority.              |
| Cold poll (daily)             | `≥80%`         | Stats refresh for older videos — medium.                           |
| Auto-backfill (daily 03:00 PT) | `≥50%`         | Historical pulling — lowest priority; cedes first under contention. |

Internal каждого adapter (NOT contract) — каждая платформа tunes свои thresholds в своем handler. YouTube hard-codes 50/80/95; Reddit Phase 03.1 may use 40/70/90 due tighter Reddit rate-limits.

Picker SQL (per-user round-robin fairness):

```sql
SELECT * FROM data_sources
WHERE backfill_complete = false
  AND deleted_at IS NULL
ORDER BY user_id, last_polled_at NULLS FIRST
LIMIT 50;
```

User A with 1 source vs user B with 100 sources — both get up to 1 visit per tick (LIMIT 50 = up to 50 distinct users если каждому по 1 source). User B's many sources get round-robin'd over multiple days.

### 9.4 Auto-import flag respect

Worker handler checks `source.auto_import` ONLY для `flow === 'auto_passive'`:

| Flow                                    | Insert events для user?                                            |
| --------------------------------------- | ------------------------------------------------------------------ |
| `initial`, `incremental`, `historical` | ✅ ALWAYS (user-initiated, explicit click)                         |
| `stats_refresh`                         | n/a (no new events; refreshes existing snapshots)                  |
| `auto_passive` (cron)                  | ✅ if `source.auto_import = true`; ❌ if false (cache hydration only) |

`auto_import = false` means «don't passively fill my feed»; user-driven refresh button still inserts events (explicit override).

### 9.5 PATCH backfill_target_since flow

User can change earliest-boundary через UI date picker:

```
PATCH /api/sources/:id  body: { backfillTargetSince: "2023-06-01T00:00:00Z" }
```

Server validates: future dates → `422 'date_must_be_past'`. Recomputes `backfill_complete`:

- Если new target older than current `backfill_oldest_at` → expanding window → reset complete=false (worker will re-pull historical).
- Если new target newer than/equal frontier → covered → keep complete state.

UI flow: user picks date → PATCH → optionally clicks Refresh → POST refresh-content (catch-up worker fires). Two clicks под одним user action.
