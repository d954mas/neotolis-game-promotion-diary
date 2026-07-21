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

This document is the canonical reference for the shipped architecture.

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

### §3.X Reddit (Phase 12) — paid ScrapeCreators adapter, provider-gated + default-OFF

Reddit's original Phase 03.1 plugin was a free, anonymous public-`.json` scrape. That transport was **razed in Phase 12**: Reddit's `.json` endpoints 403 every datacenter IP (whole proxy pools fenced) and Reddit closed self-service OAuth in Nov 2025. The adapter was rebuilt on **ScrapeCreators** — the same paid, prepaid-credit provider that serves Instagram + TikTok — so Reddit now MIRRORS those adapters instead of diverging from them.

1. **Provider gate**: `REDDIT_PROVIDER` selects the implementation (empty => "not configured"; `scrapecreators` is the only buildable value). Mirrors `INSTAGRAM_PROVIDER` / `TIKTOK_PROVIDER` exactly.
2. **Default-OFF kill-switch**: `REDDIT_IMPORT_ENABLED` — a string-literal-safe boolean where ONLY the literal `"true"` enables import. Even with the provider + key present, Reddit stays OFF until the operator explicitly opts in; the legally-hot platform never auto-enables (D-08).
3. **Shared budget**: reuses the shared `SCRAPECREATORS_API_KEY` + the `SOCIAL_*` credit envelope (daily cap + monotonic prepaid balance). NO Reddit-specific key, NO Reddit-specific budget vars — Instagram + TikTok + Reddit draw the ONE shared prepaid balance.
4. **Two source kinds**: `reddit_account` (a user's submitted-post history by handle — the PRIMARY path) and `reddit_subreddit` (a subreddit's recent posts — SECONDARY). Both walk the provider's author / subreddit endpoints.
5. **Warm metric-refresh lane**: `REDDIT_WARM_WINDOW_DAYS` (default **2** — Reddit posts stabilize in 1-2 days, shorter than IG/TikTok's 7), `REDDIT_WARM_STALENESS_HOURS` (default **26**, just over the 24h free daily walk so a page-1 post never double-pays), `REDDIT_WARM_MAX_FAILURES` (default **5** consecutive non-ok polls before a post retires). A deletion-propagation pass purges author identity after a grace window.

See `src/lib/sources/instagram/` for the reference ScrapeCreators adapter this mirrors, and `src/lib/sources/reddit/` for the rebuilt tree. The old `reddit_refresh_queue` / `reddit_pacer` / 8-tick batch-worker model and the old User-Agent / proxy-URL / base-URL-override env vars were all removed with the razed transport.

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

Other deferred items in the per-user-credentials track:
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

Server validates: future dates → `422 'date_must_be_past'`. The PATCH does NOT eagerly mutate channel state — widening the target is handled lazily by the next refresh-content click's three-branch since-derivation (see §10 "Incremental-vs-deep-walk pattern"). Pre-Phase-03.0.3 this path called `resetChannelBackfillComplete` eagerly; that reset was a multi-tenant fairness violation because it re-opened the walk for ALL subscribers when a single user widened (D-#29-7).

UI flow: user picks date → PATCH → optionally clicks Refresh → POST refresh-content (catch-up worker fires). Two clicks под одним user action. The refresh click's since-derivation decides whether to deep-walk or stay incremental based on the channel's current state — no PATCH-time state mutation required.

## 10. Incremental-vs-deep-walk pattern

*Established in Phase 03.0.3 P1 for YouTube; copy-the-pattern for Reddit / Twitter / Telegram / Discord adapters in Phase 03.1+.*

The channel walker (`handlers/backfill-channel.ts` for YouTube; the analogous walker file for other adapters) computes the `since` argument it passes to `adapter.pollContent` using a three-branch derivation:

| Channel state                                                                            | Branch        | `since`                              | `lastBackfillPageToken` |
|------------------------------------------------------------------------------------------|---------------|--------------------------------------|--------------------------|
| `backfill_complete = true`                                                               | `exhausted`   | `max(newestKnown, target)`           | cleared                  |
| `!complete && deepestWalked !== null && target >= deepestWalked`                         | `incremental` | `max(newestKnown, target)`           | cleared                  |
| else                                                                                     | `deep`        | `target`                             | preserved (resume cursor)|

Definitions:
  - **`target`** — the user's `backfill_target_since` for this source. Comes in as `job.data.depthBoundIso`.
  - **`newestKnown`** — `MAX(<adapter's events table>.published_at) WHERE channel_id = $channelKey`. For YouTube: `getNewestKnownPublishedAt(channelKey)` in `src/lib/sources/youtube/server/newest-known.ts`. Returns `null` on a cold channel (caller falls back to `target`).
  - **`deepestWalked`** — the channel's prior frontier (`backfill_oldest_at` column on `data_source_channel_state`).
  - **`target >= deepestWalked`** — comparison by `.getTime()` ms-since-epoch. A "shallower" target (fewer days ago, more-recent instant) has a LARGER ms number than a deeper one. So `target=30d-ago, deepest=60d-ago` lands in incremental (30d-ago.ms > 60d-ago.ms); `target=epoch, deepest=30d-ago` lands in deep.

Why `newestKnown` and not `last_polled_at`: backdated uploads (rare on YouTube, common on Telegram / Discord) have `publishedAt` earlier than the newest collected video. Using `MAX(published_at)` as the cursor means `walkedPastSince` fires only on items older than the newest collected — which is the correct semantic. `last_polled_at` would skip backdated uploads silently.

Token-clear rule (incremental + exhausted branches): the persistent `lastBackfillPageToken` cursor from a prior deep-walk MUST be cleared before invoking `pollContent` in either incremental branch. Without this, a stale page-N cursor would cause `walkedPastSince` to fire immediately with zero events. Deep branch preserves the token so >MAX_PAGES walks resume from where the last walk stopped.

Lazy widening: when the user widens `backfill_target_since` (e.g. 30d → epoch) via `PATCH /api/sources/:id`, the cross-source `updateSource` service does NOT eagerly reset channel state. The next refresh-content click sees `target < deepestWalked` and falls into the `deep` branch naturally. This avoids the multi-tenant fairness violation where one user's widening would re-open the walk for ALL subscribers on the channel (D-#29-7).

Reference implementation: YouTube — `src/lib/sources/youtube/server/handlers/backfill-channel.ts` step 3 (the "Compute since" block). The `since_branch` discriminator is also written to the success/empty/error audit metadata for forensic queries — operator can run `SELECT metadata->>'since_branch', COUNT(*) FROM audit_log WHERE action='source.refresh_content_requested' GROUP BY 1` to see how often each branch fires on prod.

## 11. Feed enrichment pattern

*Established in Phase 03.0.3 P2 for YouTube; copy-the-pattern for Reddit / Twitter / Telegram / Discord adapters in Phase 03.1+.*

Adapters that have per-event metadata worth showing on `FeedCard` (stats, channel/author chips, embedded media, etc.) implement the optional `enrichFeedDtos` method on `DataSourceAdapter`:

```typescript
interface DataSourceAdapter {
  // ... other methods ...
  enrichFeedDtos?(userId: string, dtos: EventDto[]): Promise<void>;
}
```

Contract:
  - The method MUST internally filter `dtos` to its own `kind` — callers do NOT pre-filter. Avoids the "did I forget to filter for adapter X?" footgun.
  - The method MUTATES `dtos` in place; returns void.
  - The method MUST swallow errors (log at WARN). A failed enrichment query MUST NOT break the feed render — the cards just render without the enrichment.
  - The method MAY make multiple DB queries (YouTube makes 2: one for `youtube_video_snapshots` latest-per-videoId, one for `youtube_videos.channelTitle`). Batch by `IN (...)` over the externalIds extracted from filtered dtos.

Three cross-source callsites iterate `allAdapters` and call this method:
  - `src/routes/feed/+page.server.ts` — SSR for the primary `/feed` view
  - `src/lib/server/http/routes/events.ts` — `GET /api/events` cursor pagination
  - `src/routes/games/[gameId]/+page.server.ts` — per-game curated view

Deliberate skip:
  - `GET /api/events/deleted` (events.ts:374) does NOT call `enrichFeedDtos`. `DeletedEventsPanel.svelte` renders soft-deleted events with a compact KindIcon + strikethrough-title view — no stats line, no channel chip. The skip is documented inline with a load-bearing WHY comment at the call site.

Reference implementation: YouTube — `src/lib/sources/youtube/server/feed-enrichment.ts`. The Phase 03.0.3 P2 commit replaced the inline JOIN in `/feed/+page.server.ts:162-237` with a single adapter loop that all three callsites share. Issue #29 Part 2 was the load-bearing motivation: pre-fix, the SSR first batch on `/feed` was enriched inline but `GET /api/events` cursor-paginated batches dropped both `stats` and `channelTitle` on every card past the first SSR batch.

## 12. UI integration is config-driven and compile-enforced

*Established in Phase 08; supersedes the old per-surface switch approach.*

Adding a new `EventKind` / `SourceKind` used to mean editing ~7 UI surfaces that each carried their OWN per-kind `switch` with a SILENT `default → "Other"` / skip. A missed surface mis-rendered at runtime (the new kind fell into the default arm) instead of failing the build. The classic symptom: Instagram shipped its adapter, but the `/sources` list silently dropped `instagram_account` rows because the page's local `PLATFORM_ORDER` didn't list the kind — a `continue` skip with no error.

**The central config is now the single touch-point.** Per-kind UI facts live in `src/lib/sources/kind-display.ts`:

```typescript
export const EVENT_KIND_DISPLAY = {
  youtube_video: { label: () => m.event_kind_label_youtube_video(), pollable: true,  chartable: true  },
  // … one entry per EventKind …
} satisfies Record<EventKind, EventKindDisplay>;

export const SOURCE_KIND_DISPLAY = {
  instagram_account: { label: () => m.source_kind_label_instagram_account(),
                       platformGroup: { key: "instagram", label: "Instagram", order: 2 } },
  // … one entry per SourceKind …
} satisfies Record<SourceKind, SourceKindDisplay>;
```

**The `satisfies Record<EventKind, …>` / `Record<SourceKind, …>` makes an omission a COMPILE ERROR.** The `Record` requires every key in the union, so a new kind that is missing from the config fails `pnpm typecheck` (`Property 'X' is missing in type … but required in type 'Record<EventKind, EventKindDisplay>'`). This is the same "you can't forget a case" philosophy the codebase already enforces in `errors.ts categoryToSnapshotStatus` (§4.5 — a switch with no `default`) and `AuditFlow` (§9.1 — TS union + Postgres CHECK). `tests/unit/kind-display.test.ts` adds a belt-and-suspenders runtime check (every key resolves a non-empty label + required fields).

**What the config carries (KISS — only what surfaces actually read today):**

| Field | Type | Drives |
| ----- | ---- | ------ |
| `EVENT_KIND_DISPLAY[k].label` | `() => string` | Every event-kind label across the UI (paraglide resolver) |
| `EVENT_KIND_DISPLAY[k].pollable` | `boolean` | PollingBadge visibility (freshness / operator-paused / refresh-now) — youtube_video / reddit_post / instagram_post |
| `EVENT_KIND_DISPLAY[k].chartable` | `boolean` | Per-event metric-history chart + game-chart markers |
| `EVENT_KIND_DISPLAY[k].manualCreatable` | `boolean` | Whether the kind appears as a chip in the **Add Event** manual kind picker (`MANUAL_EVENT_KINDS` → `AddEventForm`) — paste-flow kinds (youtube_video / reddit_post / instagram_post) + free-form (press / post / conference / talk / other); `false` for the not-yet-functional kinds (twitter_post / telegram_post / discord_drop) |
| `SOURCE_KIND_DISPLAY[k].label` | `() => string` | Every source-kind label |
| `SOURCE_KIND_DISPLAY[k].platformGroup` | `{ key, label, order }` | `/sources` list grouping (reddit_account + reddit_subreddit share one "Reddit" group) |

Derived helper sets — `POLLABLE_EVENT_KINDS`, `CHARTABLE_EVENT_KINDS`, `MANUAL_EVENT_KINDS`, `SOURCE_PLATFORM_GROUPS` — are computed FROM (or, for `MANUAL_EVENT_KINDS`, cross-checked AGAINST) the config so they can never drift from the per-kind flags. Color is deliberately NOT in the config: chart-theme `resolveKindColor` already resolves `--k-<kind>` dynamically for any kind, so duplicating it would create a second source of truth. Icons live in `kind-icon-svg.ts` (event icons) and `SourceKindIcon.svelte` (source-row icons, which carries its own type-level exhaustiveness guard).

**Surfaces that read from the config** (the full roster — a future contributor adds a kind in ONE place and these update automatically):

- `src/lib/components/event-detail/EventDetailHeader.svelte` — kind label + PollingBadge gate (`POLLABLE_EVENT_KINDS`)
- `src/lib/components/PollingBadge.svelte` — `POLLABLE_EVENT_KINDS` membership
- `src/lib/components/event-detail/EventDetailContent.svelte` — `CHARTABLE_EVENT_KINDS` membership
- `src/lib/components/FilterChips.svelte` + `FiltersSheet.svelte` — kind labels (`eventKindLabel`)
- `src/lib/components/feed/parts/BaseFeedCard.svelte` — kind label (`eventKindLabel`)
- `src/routes/sources/+page.svelte` — platform grouping (`SOURCE_PLATFORM_GROUPS` / `sourcePlatformGroupKey`)
- `src/lib/util/source-kind-label.ts` — `sourceKindLabel` is now a thin re-export over `sourceKindDisplayLabel` (so SourceRow / FiltersSheet resolve through the same config)
- `src/lib/components/add-event/AddEventForm.svelte` — the **Add Event** manual kind picker renders `MANUAL_EVENT_KINDS` (the `manualCreatable: true` set, in chip order) instead of a hardcoded local list

**The Add Event manual picker is now a config-driven, enforced surface.** It used to carry a hardcoded `KIND_FLOW` list, which is exactly how Instagram was first missed — the chip simply wasn't there, with no compile or test signal. Adding a kind now means making ONE decision in `EVENT_KIND_DISPLAY`: set its `manualCreatable` flag. Because the config is `satisfies Record<EventKind, EventKindDisplay>`, a new kind that omits the flag is a COMPILE ERROR. The picker reads `MANUAL_EVENT_KINDS` — an explicit ordered list (chip order is a UX choice the boolean can't express) whose membership `tests/unit/kind-display.test.ts` asserts equals exactly the `manualCreatable: true` set, so the order list can never drift from the flags. The not-yet-functional kinds (twitter_post / telegram_post / discord_drop) carry `manualCreatable: false` — they have no adapter, no paste flow, and are filtered out of the `/feed` KIND axis, so letting a user create them would be a footgun (un-filterable events).

**`manualCreatable: true` ≠ live paste-preview.** The flag only governs whether the kind's chip is *selectable* and whether a manually-typed/pasted event of that kind can be created. RECOGNIZING a pasted link (auto-detect kind + canonical URL from the Fetch button) goes through `parseAnyUrl` → `parseIngestUrl` → `enrichFromUrl`; for a kind to actually *preview* (auto-fill title / thumbnail / date from the live post) the matching adapter must additionally implement `fetchEventPreviewMetadata` (YouTube oEmbed, Reddit `/api/info.json`). Instagram is the in-between case shipped in Phase 08: the link is RECOGNIZED (kind=`instagram_post` + shortcode externalId + canonical permalink) with NO network call — there is no single-post IG metadata API — so the user types the Title manually. When an IG single-post endpoint lands, implementing the IG adapter's `fetchEventPreviewMetadata` is the only change needed to upgrade recognition → full preview.

**Deliberate exclusion** (still NOT config-driven, by design): the kind dropdown on the edit form (`events/[id]/edit`) carries its own allowlist — editing an existing event is a different surface from creating one, so it stays separate for now.

**Threading a resolved display name at create time.** `CanonicalizeResult` (adapter.ts) carries an optional `displayName?: string | null`. When an adapter already fetched the account's display name while resolving the handle (Instagram `resolveAccount` returns full_name/username), it returns it here; `createSource` persists it on `data_sources.display_name` ONLY when the caller didn't supply an explicit `displayName` (a user-typed name always wins). This is why a newly-added Instagram source shows its real account name instead of the bare account id. YouTube omits it (the channel title is resolved later on the worker).

## 13. Subject entity + full historical storage (foundation for channel-level analytics)

*Pattern established by YouTube + Reddit; required for any analytics-capable adapter. Telegram added `telegram_channels` in Phase 9 as the FOUNDATION for future per-channel pages + percentile analytics (the percentiles / baselines themselves are NOT built yet — designed for, not implemented).*

An auto-import adapter that wants channel-level / account-level analytics later MUST capture three things on the write path now. Designing the subject entity up front is what makes percentile baselines cheap to add later — retrofitting an entity onto an adapter that only ever stored per-post rows means backfilling the subject id across the entire post history.

**(a) Subject entity table — source of truth, NOT a denorm.** A public-data table (no `user_id`) keyed on the platform's INTRINSIC, rename-proof id, holding the subject's OWN upstream metadata:

| Adapter | Entity table | PK (rename-proof id) | Holds |
| ------- | ------------ | -------------------- | ----- |
| YouTube | `youtube_channels` | `channel_id` (UC…) | channel title, uploads playlist id, handle aliases |
| Reddit | `reddit_subreddits_cache` | `name` (lowercase slug) | subscribers, description, submission metadata |
| Instagram | `instagram_accounts` | `account_id` (stable IG user id, = `instagram_posts.account_id`) | full name, @handle username, avatar, follower count, handle aliases |
| Telegram | `telegram_channels` | `channel_key` (numeric id from each post's base64 `data-view` payload `{"c":…}`) | title, @username slug, avatar, subscriber count, description, handle aliases |

The entity row's `title` / `name` is the upstream-scraped value — OUR truth for the subject's own metadata (see the "this IS our truth" comment in `youtube_channels.ts`). It is **not** a copy of `data_sources.display_name`, which is the user-facing label a tenant may rename freely. The two coexist by design and never alias each other (AGENTS.md no-denorm rule forbids caching `data_sources.display_name` onto the entity, and equally forbids caching the entity title onto a `data_sources` / per-post row). The renameable @username / handle still lives on `data_sources` for feed enrichment; the entity carries a `handle_aliases` history so a future channel page can resolve any historical handle to the rename-proof id. Populate via UPSERT on each poll, COALESCE-preserving prior good values on a partial / failed parse so a transient miss never blanks working metadata (same rule as a per-post thumbnail, IG #69 P1-A).

**(b) Full per-post + per-post-snapshot historical storage.** Public-data, retained FOREVER (no GC, even when the last referencing event / source is deleted — the row IS the historical record). Each per-post row carries the rename-proof subject id as a column (`youtube_videos.channel_id`, `reddit_posts.subreddit`, `telegram_posts.channel_key`) so per-subject analytics can `GROUP BY` it. The snapshot table (`*_video_snapshots` / `*_post_snapshots`) is the immutable time-series the baselines aggregate over.

**(c) Per-subject baselines (future / optional).** A separate public-data aggregate table keyed by the subject key, computed by a nightly cron, surfaced in `/feed` enrichment as percentile context ("your post in r/X underperforms median — 16% of typical score"). Build only when the read-path needs it. The canonical pattern is `reddit_subreddit_baselines`: median / p75 over a rolling window via `PERCENTILE_CONT`, a `sample_size >= N` gate so a thin sample never publishes misleading numbers, JOIN `*_posts` against `*_post_snapshots` at the ~24h-after-publish mark. **No Telegram baselines table / cron / channel page exists yet** — `telegram_channels` is the entity foundation those will read. Note: the Telegram backfill depth cap (`TELEGRAM_BACKFILL_MAX_POSTS`, currently 100) will be revisited when percentiles land, since a meaningful per-channel baseline may want a deeper historical sample than the steady-state feed needs.

**Current adapter coverage:**

| Adapter | (a) entity | (b) post + snapshot history | (c) baselines |
| ------- | ---------- | --------------------------- | ------------- |
| YouTube | ✅ `youtube_channels` | ✅ | — (not built; analytics live on the per-game chart) |
| Reddit | ✅ `reddit_subreddits_cache` | ✅ | ✅ `reddit_subreddit_baselines` (the canonical reference) |
| Instagram | ✅ `instagram_accounts` | ✅ `instagram_posts` + snapshots | — (designed-for; not built) |
| Telegram | ✅ `telegram_channels` (Phase 9) | ✅ `telegram_posts` + snapshots | — (designed-for; not built) |

`instagram_accounts` is populated from data the adapter ALREADY pays for — the create-time profile resolve (`resolveHandleToAccountId`, the richer full_name / avatar / follower_count) and the FREE feed owner object the walker page carries (account_id + @handle + avatar), COALESCE-preserving the richer profile fields. ZERO additional provider credits: the entity refreshes from data in hand, so it adds the subject-entity anchor without touching the IG cost guardrails or the backfill cap.
