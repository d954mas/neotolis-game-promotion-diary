# Architecture Research

**Domain:** Multi-tenant indie SaaS with adaptive background pollers, encrypted per-user secrets, and identical open-source self-host deploy. One small VPS. Postgres-only. One operator.
**Researched:** 2026-04-27
**Confidence:** HIGH for the component map, queue model, storage shape, and deployment shape (all derived from locked PROJECT.md constraints + verified STACK.md picks). MEDIUM for one-tenant-vs-many configuration deltas (depends on patterns Better Auth and pg-boss expose; both verified present in current docs).

## Standard Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Edge / Trust Boundary                       │
│   ┌────────────────────────┐         ┌──────────────────────────┐       │
│   │   Cloudflare Free      │         │  Caddy / nginx / bare    │       │
│   │   (TLS, WAF, DDoS)     │   OR    │  cloudflared (self-host) │       │
│   │   + optional Tunnel    │         │                          │       │
│   └───────────┬────────────┘         └──────────────┬───────────┘       │
│               │  CF-Connecting-IP / X-Forwarded-*    │                   │
└───────────────┼──────────────────────────────────────┼───────────────────┘
                ▼                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Application Tier  (one Docker image)            │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  app   (APP_ROLE=app)                                              │ │
│  │  ┌────────────────┐    ┌──────────────────┐   ┌─────────────────┐  │ │
│  │  │ SvelteKit SSR  │◀──▶│  Hono HTTP API   │──▶│ Better Auth     │  │ │
│  │  │ (UI + forms)   │    │  /api/*          │   │ (Google OAuth)  │  │ │
│  │  └────────────────┘    └────┬─────────────┘   └────────┬────────┘  │ │
│  │                             │ services/*               │           │ │
│  │                             ▼                          ▼           │ │
│  │   ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐    │ │
│  │   │ tenant-scope │  │ envelope.ts      │  │ rate-limiter     │    │ │
│  │   │ middleware   │  │ (KEK/DEK)        │  │ (RLM mem / RLM pg)│   │ │
│  │   └──────────────┘  └──────────────────┘  └──────────────────┘    │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌────────────────────────────────────┐ ┌────────────────────────────┐  │
│  │ scheduler  (APP_ROLE=scheduler)    │ │ worker  (APP_ROLE=worker)  │  │
│  │  - pg-boss cron (every 5 min)      │ │  - pg-boss workers         │  │
│  │  - reads tracked_items             │ │  - 4 priority queues       │  │
│  │  - tier resolver: hot/warm/cold    │ │  - each calls integration  │  │
│  │  - enqueues poll jobs              │ │    adapter for one URL     │  │
│  └────────────────────────────────────┘ │  - writes metric_snapshots │  │
│                                         └──────────┬─────────────────┘  │
│                                                    │                     │
└────────────────────────────────────────────────────┼─────────────────────┘
                                                    │
                                                    ▼ encrypted creds in row
┌─────────────────────────────────────────────────────────────────────────┐
│                          Storage Tier (single Postgres 16)               │
│  ┌────────┐ ┌────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────┐ │
│  │ users  │ │ games      │ │ tracked_items│ │metric_       │ │ audit_ │ │
│  │ + auth │ │ (game_id)  │ │ (item_id)    │ │snapshots     │ │ log    │ │
│  └────────┘ └────────────┘ └──────────────┘ └──────────────┘ └────────┘ │
│  ┌────────┐ ┌────────────┐ ┌──────────────┐ ┌──────────────┐            │
│  │secrets │ │subreddit_  │ │ events       │ │ pgboss.*     │            │
│  │(env enc│ │rules       │ │ (timeline)   │ │ (queue)      │            │
│  └────────┘ └────────────┘ └──────────────┘ └──────────────┘            │
└─────────────────────────────────────────────────────────────────────────┘
                                                    ▲
                                                    │ outbound only
                                                    │ per-user creds
                          ┌─────────────────────────┴─────────────────────┐
                          │            External APIs (egress)              │
                          │  YouTube Data API v3   Reddit OAuth API        │
                          │  Steam Web API         Steam appdetails        │
                          └────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Owns | Talks To | Protocol | Notes |
|-----------|------|----------|----------|-------|
| **Edge (Cloudflare / Caddy / cloudflared)** | TLS termination, DDoS, WAF, IP-injection via `CF-Connecting-IP` / `X-Forwarded-For` | `app` | HTTPS → HTTP | SaaS = Cloudflare Free + Tunnel; self-host = whatever the user picked. Trust list configured in app. |
| **`app` container** | HTTP API + SSR UI + auth + tenant scoping + secret read/write UI | Postgres, Edge | TCP/SQL, HTTPS | The web tier. Stateless. Restartable without dropping queue. |
| **`scheduler` container** | Cron-like enqueue: every 5 min scan `tracked_items`, classify into hot/warm/cold, enqueue poll jobs at correct priority | Postgres (read items, write jobs) | SQL only | One instance. Idempotent. pg-boss `schedule()` API does the cron. |
| **`worker` container** | Dequeue poll jobs, load encrypted creds, hit external API, write `metric_snapshots`, update `tracked_items.last_polled_at`, audit-log failures | Postgres, External APIs | SQL + HTTPS | N instances; each handles all 4 priority queues. Worker is the only component that decrypts secrets in normal operation. |
| **Postgres** | All durable state: tenant data, snapshots, audit log, encrypted secrets, **and** the queue (pg-boss schema) | — | — | Single source of truth. Single backup target. |
| **Better Auth** | Google OAuth flow, session cookies, account-link, audit-log hooks | Postgres (own tables), Google OAuth | HTTPS | Embedded in `app`, not a separate process. Drizzle adapter shares the migration tool. |
| **Envelope encryption module** (`crypto/envelope.ts`) | AES-256-GCM wrap of DEKs by KEK; AES-256-GCM encrypt/decrypt of secret payloads by DEK | Postgres `secrets` table (read), env (`APP_KEK_BASE64`) | — | Used by `app` (write path) and `worker` (read path). Pure function — no state. |
| **Tenant-scope middleware** | On every authenticated request, attach `userId` to context; every Drizzle query is parameterised by `userId`; reject any service call lacking it | All services | — | The single chokepoint that enforces "data is scoped per `user_id`". Self-host runs in single-tenant mode but **uses the same code path** with one synthetic user. |
| **Integration adapters** (`integrations/youtube.ts`, `integrations/reddit.ts`, `integrations/steam.ts`) | One adapter per external API; converts a stored item + decrypted creds → a `MetricSnapshot` row | External APIs | HTTPS | Each adapter is plain TypeScript with a uniform `poll(item, creds): Snapshot` signature. New platform = new adapter, no other changes. |
| **Audit log writer** | Append-only insert into `audit_log` from `app` (login/key-write/export) and `worker` (key-load failures, deleted-by-user upstream) | Postgres | — | Never updates or deletes. The owner-visible UI is a paginated read on this table. |

## Recommended Project Structure

```
.
├── apps/
│   ├── server/                       # Hono backend (APP_ROLE=app|worker|scheduler)
│   │   ├── src/
│   │   │   ├── index.ts              # entrypoint; switches on APP_ROLE
│   │   │   ├── http/                 # Hono routes, only thin glue
│   │   │   │   ├── auth.ts           # Better Auth mount + cookie config
│   │   │   │   ├── games.ts          # /api/games CRUD
│   │   │   │   ├── items.ts          # /api/items CRUD (Reddit posts, YT videos)
│   │   │   │   ├── snapshots.ts      # /api/items/:id/snapshots (read-only)
│   │   │   │   ├── secrets.ts        # /api/secrets (write-once)
│   │   │   │   ├── audit.ts          # /api/audit (read-only)
│   │   │   │   └── middleware/
│   │   │   │       ├── tenant.ts     # attach userId; refuse anonymous
│   │   │   │       ├── proxy-trust.ts# parse CF-Connecting-IP / XFF
│   │   │   │       └── rate-limit.ts # rate-limiter-flexible adapter
│   │   │   ├── services/             # Tenant-scoped business logic (NO HTTP types)
│   │   │   │   ├── games.ts
│   │   │   │   ├── items.ts
│   │   │   │   ├── secrets.ts        # uses envelope.ts under the hood
│   │   │   │   └── audit.ts
│   │   │   ├── workers/              # pg-boss handlers (APP_ROLE=worker)
│   │   │   │   ├── register.ts       # boss.work(...) for each queue
│   │   │   │   ├── poll-youtube.ts   # consumes 'poll.youtube' jobs
│   │   │   │   ├── poll-reddit.ts    # consumes 'poll.reddit' jobs
│   │   │   │   └── poll-steam.ts     # consumes 'poll.steam' jobs
│   │   │   ├── scheduler/            # APP_ROLE=scheduler
│   │   │   │   ├── tier-resolver.ts  # age + last_polled_at → hot/warm/cold
│   │   │   │   └── enqueue.ts        # pg-boss schedule() + send()
│   │   │   ├── integrations/         # External API adapters (pure functions)
│   │   │   │   ├── youtube.ts
│   │   │   │   ├── reddit.ts
│   │   │   │   ├── steam.ts
│   │   │   │   └── types.ts          # PollResult, PollError shapes
│   │   │   ├── crypto/
│   │   │   │   ├── envelope.ts       # AES-256-GCM KEK/DEK
│   │   │   │   └── kek-rotation.ts   # offline rotation script
│   │   │   ├── db/
│   │   │   │   ├── schema/           # Drizzle schema files
│   │   │   │   │   ├── users.ts
│   │   │   │   │   ├── games.ts
│   │   │   │   │   ├── tracked-items.ts
│   │   │   │   │   ├── metric-snapshots.ts
│   │   │   │   │   ├── secrets.ts
│   │   │   │   │   ├── subreddit-rules.ts
│   │   │   │   │   ├── events.ts
│   │   │   │   │   └── audit-log.ts
│   │   │   │   ├── client.ts         # pg pool + drizzle()
│   │   │   │   └── migrate.ts        # called at boot for all roles
│   │   │   ├── auth/                 # Better Auth config
│   │   │   ├── config/               # zod-validated env config
│   │   │   └── lib/                  # logger (pino), errors, ids
│   │   └── drizzle/                  # generated SQL migrations
│   └── web/                          # SvelteKit (Svelte 5)
│       ├── src/
│       │   ├── routes/               # SvelteKit routes (SSR + form actions)
│       │   ├── lib/
│       │   │   ├── components/
│       │   │   ├── api.ts            # typed client to /api/*
│       │   │   └── charts/           # LayerChart wrappers
│       │   └── app.html
│       └── svelte.config.js
├── packages/
│   ├── shared-types/                 # zod schemas shared between server and web
│   └── seed/                         # D-04 curated subreddit rules seed JSON
├── infra/
│   ├── Dockerfile                    # multi-stage; one image
│   ├── docker-compose.saas.yml       # SaaS: app + worker + scheduler + cloudflared + LGTM
│   ├── docker-compose.selfhost.yml   # self-host: app + worker + scheduler + caddy + postgres
│   └── caddy/Caddyfile.example
├── docs/
│   ├── self-host.md
│   ├── kek-rotation.md
│   └── trusted-proxy.md
└── .planning/                        # GSD workflow files (already present)
```

### Structure Rationale

- **`apps/server/` is one codebase, three roles.** The `APP_ROLE` env var (set to `app`, `worker`, or `scheduler`) chooses the entrypoint at boot. Same Docker image for all three. Self-host can collapse to one container with `APP_ROLE=app WORKERS_INLINE=true` for a single-process deploy; SaaS runs three containers. **No code change between modes.**
- **`http/` is paper-thin; `services/` does the work.** HTTP handlers parse + validate, then call a service function that takes `userId` as its first argument. Workers and CLI scripts call those same services without going through HTTP. This is what makes "the worker can run a poll" symmetric with "the user did a CRUD".
- **`integrations/` are pure functions.** No DB writes, no logging side effects, no global state. `poll(item, creds)` returns a `Snapshot` or throws a typed `IntegrationError`. The worker handles persistence and audit logging — not the adapter. This keeps each adapter testable with a fixture, and keeps the "what changed when we added Steam" diff small.
- **`crypto/envelope.ts` is the only place secrets are ever decrypted.** Every other layer holds either ciphertext (DB rows) or `Buffer` plaintext that lives in the worker for the duration of a single poll job. No "secrets cache" — re-decrypt per job. Cheap (microseconds) and bounds blast radius if a process is dumped.
- **Schema files split per table** so each Drizzle file is short, reviewable, and `userId` scoping is visible at a glance. PR reviews catch missing `userId` columns immediately.
- **`packages/seed/` is JSON content** so D-04 (curated subreddit rules) is a separately-PR-able artifact. Community contributors update rules without touching code.
- **`infra/` keeps SaaS and self-host compose files side by side** so the deltas are obvious in code review and the docs.

## Architectural Patterns

### Pattern 1: Tenant-Scoping by Convention + Type System

**What:** Every service function takes `userId: string` as its first argument. Every Drizzle query that hits a user-owned table includes `eq(table.userId, userId)`. The HTTP middleware refuses to call any service function without a session-derived `userId`. Self-host mode injects a synthetic `userId = 'self-host'` at the same chokepoint.

**When to use:** Multi-tenant SaaS with shared DB, especially when the same code must run in single-tenant self-host mode. Postgres RLS is an alternative (see anti-patterns below).

**Trade-offs:**
- Pros: One code path serves SaaS and self-host; no DB-side auth surface; easy to test (just pass a userId).
- Cons: Discipline-based — a missing `userId` filter is a silent leak in SaaS. Mitigation: TypeScript signature that requires `userId`; PR review checklist; integration test that creates two users and asserts user A can't read user B's items.

**Example:**
```typescript
// services/items.ts
export async function listItemsForGame(
  userId: string,            // first arg; non-optional
  gameId: string,
): Promise<TrackedItem[]> {
  return db
    .select()
    .from(trackedItems)
    .where(and(
      eq(trackedItems.userId, userId),     // tenant scope
      eq(trackedItems.gameId, gameId),
    ));
}

// http/items.ts
items.get('/games/:gameId/items', tenantScope, async (c) => {
  const userId = c.get('userId');          // set by tenant middleware
  const gameId = c.req.param('gameId');
  return c.json(await listItemsForGame(userId, gameId));
});
```

### Pattern 2: Snapshot-and-Forward (Append-Only Metric Storage)

**What:** Never mutate the metric for a tracked item. Each poll inserts a *new row* into `metric_snapshots` with `(item_id, polled_at, payload_jsonb)`. The "current state" is an SQL view (`v_item_current_state`) selecting the most recent snapshot per item. The chart is `SELECT polled_at, payload->>'views' FROM metric_snapshots WHERE item_id = ? ORDER BY polled_at`.

**When to use:** Always when the time series *is* the value (charts, correlation analysis). This is the single most important pattern for the differentiator — D-03 annotated wishlist correlation chart only works because the history is intact.

**Trade-offs:**
- Pros: Charts are trivial. Re-deriving "current state" is a free side effect. Adaptive polling can drop in different tiers without losing history. Audit-friendly (no "who changed this" — nothing changes).
- Cons: Storage grows linearly with poll count × tracked items. Mitigation: see Scaling Considerations.

**Example:**
```typescript
// workers/poll-youtube.ts
export async function pollYouTubeJob(job: { data: { itemId: string } }) {
  const item = await getTrackedItem(job.data.itemId);
  const creds = await loadDecryptedCreds(item.userId, 'youtube'); // envelope.decrypt
  const snapshot = await integrations.youtube.poll(item, creds); // pure adapter

  await db.transaction(async (tx) => {
    await tx.insert(metricSnapshots).values({
      itemId: item.id,
      userId: item.userId,                           // duplicated for tenant scope on read
      polledAt: new Date(),
      payload: snapshot,                             // jsonb: {views, likes, comments, ...}
    });
    await tx.update(trackedItems)
      .set({ lastPolledAt: new Date(), lastPollStatus: 'ok' })
      .where(eq(trackedItems.id, item.id));
  });
}
```

### Pattern 3: Tier-as-Priority-Queue (Adaptive Polling)

**What:** pg-boss exposes per-queue priorities (0 = highest). We define **four named queues** — not one queue with priority hints — so each tier has its own concurrency budget and can't starve the others.

| Queue name | Tier | Cron / enqueue rule | Worker concurrency | Job priority within queue |
|------------|------|---------------------|--------------------|---------------------------|
| `poll.hot`  | Items polled <24h since first add (or `hot_until` override) | every 30 min, enqueue all hot items | 4 workers | priority by `last_polled_at` (oldest first) |
| `poll.warm` | Items 1–30 days old | every 6h, enqueue all warm items | 2 workers | by oldest `last_polled_at` |
| `poll.cold` | Items >30 days old | once daily (02:00 UTC, jittered per-item) | 1 worker | by oldest `last_polled_at` |
| `poll.user` | User-triggered "refresh now" | on demand | 2 workers | priority 0 (above hot) |

The `worker` container subscribes all four queues. **Concurrency separation prevents starvation** — even a backlog of 5,000 cold items can't block hot polls because cold has its own worker count.

**When to use:** Whenever poll cadence varies by item attribute and quota matters. The "one queue with priorities" alternative looks simpler but a long backlog of low-priority jobs locked into a worker slot stalls the high-priority ones (head-of-line blocking).

**Trade-offs:**
- Pros: Quota-respecting; observable per tier; safe from starvation; trivially mappable to dashboards (queue depth per tier).
- Cons: Four queues to declare; requires the scheduler to know the tier rules. (Tier rules live in one file: `scheduler/tier-resolver.ts`.)

**Tier resolution rule (the only place this lives):**
```typescript
// scheduler/tier-resolver.ts
export function resolveTier(item: TrackedItem, now = new Date()): 'hot' | 'warm' | 'cold' {
  if (item.hotUntil && item.hotUntil > now) return 'hot'; // user override (D-06)
  const ageDays = (now.getTime() - item.addedAt.getTime()) / 86_400_000;
  if (ageDays < 1)  return 'hot';
  if (ageDays < 30) return 'warm';
  return 'cold';
}
```

Scheduler cron tick (every 5 min):
```typescript
// scheduler/enqueue.ts
const dueItems = await db.select().from(trackedItems)
  .where(or(
    isNull(trackedItems.lastPolledAt),
    lt(trackedItems.lastPolledAt, sql`now() - interval '30 minutes'`), // hot threshold
  ));

for (const item of dueItems) {
  const tier = resolveTier(item);
  if (!isDue(item, tier)) continue;          // each tier has its own minimum interval
  await boss.send(`poll.${tier}`, { itemId: item.id, platform: item.platform });
}
```

### Pattern 4: Envelope Encryption with KEK in Env, DEK per Row

**What:** Each `secrets` row stores its secret encrypted with a per-row DEK. The DEK itself is stored *wrapped* by the operator's KEK (loaded from `APP_KEK_BASE64`). On read, the worker first AES-decrypts the wrapped-DEK using KEK, then AES-decrypts the secret using DEK. On rotation, decrypt+re-encrypt only the wrapped-DEK column — no need to re-encrypt the (potentially many) secret payloads.

**When to use:** Always for at-rest secrets when full KMS is overkill (single VPS reality).

**Trade-offs:**
- Pros: KEK leak alone doesn't decrypt secrets without DB access; DB leak alone doesn't decrypt without KEK; rotation is cheap (re-wrap N short DEKs, not N long secrets); KMS upgrade later is interface-compatible.
- Cons: Operator must guard the KEK env. App must refuse to start if KEK is missing while secrets exist (poison-pill check).

(Full lifecycle and rotation procedure documented in the *Encryption Flow* section below.)

### Pattern 5: Trusted-Proxy Header Allowlist

**What:** Hono's proxy helper is configured with an explicit list of "we trust X-Forwarded-For from these source IPs." On a request:
1. If source IP is in trusted list, parse `CF-Connecting-IP` (preferred) or last-hop `X-Forwarded-For`.
2. Else, use the raw socket peer address.
3. Audit log writes the resolved client IP, not the proxy IP.

**When to use:** Anywhere the app sits behind a proxy (always in our case).

**Trade-offs:** Misconfigured trust list = either spoofed IPs in audit log (too lax) or the user's IP missing entirely (too strict). Mitigation: ship sane defaults per deploy mode.

```typescript
// http/middleware/proxy-trust.ts
const TRUSTED_PROXY_RANGES =
  process.env.APP_MODE === 'saas'
    ? [...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES, '127.0.0.1', '::1']
    : ['127.0.0.1', '::1']; // self-host default; doc tells user how to add their reverse proxy IP

// resolve order: CF-Connecting-IP > X-Forwarded-For (rightmost trusted hop) > socket
```

## Data Flow

### Flow A — "Add a YouTube video → see growth chart"

```
USER (browser)
  │  paste https://youtube.com/watch?v=abc123
  ▼
SvelteKit form action  ──POST /api/items──▶  Hono /api/items
                                                │
                                            tenantScope (userId attached)
                                                │
                                            services/items.createItem(userId, {url, gameId})
                                                │
                                            URL parser: detect youtube → platform='youtube', externalId='abc123'
                                                │
                                            INSERT tracked_items (id, user_id, game_id, platform, external_id, added_at, last_polled_at=NULL)
                                                │
                                            audit_log: 'item.created'
                                                │
                                            response 201 + item row
                                                │
                                            scheduler tick (≤5 min later)
                                                │
                                            resolveTier(newItem) = 'hot'  (added_at < 1 day, last_polled_at NULL)
                                                │
                                            boss.send('poll.hot', {itemId})
                                                ▼
WORKER picks up poll.hot job
  │
  ├── load tracked_items row by id (and assert user_id matches)
  ├── load secrets row for (user_id, platform='youtube'), envelope.decrypt → API key
  ├── integrations.youtube.poll(item, creds)
  │       └── googleapis.youtube.videos.list({id: 'abc123', part: ['snippet','statistics']})
  │           returns {viewCount, likeCount, commentCount, publishedAt, title}
  ├── BEGIN tx
  │   ├── INSERT metric_snapshots (item_id, user_id, polled_at, payload)
  │   ├── UPDATE tracked_items SET last_polled_at=now(), last_poll_status='ok'
  │   └── (first successful poll only) UPDATE tracked_items SET title='...', published_at='...'
  │   COMMIT
  └── (next tick keeps re-polling at hot cadence; after 24h, scheduler reclassifies to warm)

USER returns 24h later
  │
  ▼
SvelteKit /games/:gameId/items/:itemId page
  │  loads via /api/items/:id and /api/items/:id/snapshots
  ▼
SELECT polled_at, payload->>'viewCount' AS views
FROM metric_snapshots
WHERE item_id=? AND user_id=?      ◀── tenant-scoped
ORDER BY polled_at
  │
  ▼
LayerChart line chart of views over time
```

### Flow B — "Add a subreddit → see rules + cooldown warning"

```
USER pastes a subreddit name 'r/IndieDev' on the game's Reddit channels page
  │
  ▼
SvelteKit form action ──POST /api/subreddits──▶ Hono
                                                  │
                                              tenantScope
                                                  │
                                              services/subreddits.attachToGame(userId, gameId, subreddit='IndieDev')
                                                  │
                                          ┌────  check subreddit_rules (NOT user-scoped — shared seed)
                                          │       │
                                          │   IF row exists AND fetched_at < 30d  →  use it (D-04 seed)
                                          │   ELSE enqueue 'fetch.subreddit-rules' job (workers/fetch-rules.ts)
                                          ▼
                                      INSERT game_subreddits (user_id, game_id, subreddit, attached_at)
                                                  │
                                              return current rules (raw + structured) to UI

USER pastes a Reddit post URL https://reddit.com/r/IndieDev/comments/xyz/
  │
  ▼
POST /api/items
  │
  services/items.createItem(userId, {url, gameId})
  │
  detect reddit → platform='reddit', externalId='xyz', subreddit='IndieDev'
  │
  ┌── PRE-INSERT CHECK (D-02 pre-post warning):
  │     SELECT * FROM subreddit_rules WHERE name='IndieDev'
  │     SELECT MAX(added_at) FROM tracked_items
  │       WHERE user_id=? AND game_id=? AND subreddit='IndieDev' AND platform='reddit'
  │     compute: cooldown_remaining = rules.cooldown_days*86400 - (now - last_post_added_at)
  │     compute: flair_violation, self_promo_cap_violation
  │     return verdict {green|yellow|red, violated_rules: [...]}
  │
  ├── verdict is NOT a hard block — request still proceeds.
  │   UI surfaced the warning before submit, user chose to override.
  │
  ├── INSERT tracked_items (... subreddit='IndieDev')
  ├── audit_log: 'item.created' with verdict in metadata
  └── enqueue first poll on poll.hot
```

### Flow C — "Rotate the Steam API key"

```
USER goes to Settings → API Keys → Steam → "Replace key"
  │  pastes new key, submits
  ▼
POST /api/secrets/steam   (write-once UI)
  │
  tenantScope (userId)
  │
  services/secrets.replaceSecret(userId, kind='steam', plaintext=newKey)
  │
  ┌──  envelope.encrypt(plaintext, kek):
  │      1. dek = crypto.randomBytes(32)
  │      2. secretCt = AES-256-GCM(dek).encrypt(plaintext) → {ct, iv, authTag}
  │      3. wrappedDek = AES-256-GCM(kek).encrypt(dek)     → {ct, iv, authTag}
  │      return {secretCt, secretIv, secretTag, wrappedDek, dekIv, dekTag}
  │
  BEGIN tx
  ├── UPDATE secrets SET (... new ciphertext columns ...) WHERE user_id=? AND kind='steam'
  ├── audit_log: 'secret.rotated' (record last4 of OLD key for forensics, never the full key)
  COMMIT
  │
  return {ok: true, last4: '...XYZ9'}    ◀── only the last 4 chars are ever shown back

NEXT poll job for any of this user's Steam items:
  │
  worker loads secrets row → envelope.decrypt(...) → uses NEW key transparently.
  No worker restart needed; no in-process secret cache to invalidate.

IF the new key is wrong:
  │
  worker integration call returns 401/403
  ├── UPDATE tracked_items SET last_poll_status='auth_error', last_poll_error_at=now()
  ├── audit_log: 'integration.auth_error' (tier='steam')
  └── D-12 "what's stale" inbox surfaces it in the UI

THE KEK ITSELF (operator-side rotation, separate procedure):
  │
  ./scripts/rotate-kek.ts  (run via `docker compose run --rm app node scripts/rotate-kek.js`)
  │  inputs: APP_KEK_BASE64 (current), APP_KEK_NEW_BASE64
  │
  ┌── for each row in `secrets`:
  │     1. unwrappedDek = AES-GCM(oldKek).decrypt(wrappedDek)
  │     2. newWrappedDek = AES-GCM(newKek).encrypt(unwrappedDek)
  │     3. UPDATE secrets SET wrapped_dek=newWrappedDek, dek_iv=newIv, dek_tag=newTag,
  │           kek_version = kek_version + 1
  │           WHERE id = ?
  │  (DEK and secret ciphertext untouched.)
  │
  ├── audit_log: 'kek.rotated' (count of rows)
  ├── operator updates env: APP_KEK_BASE64=<new>, APP_KEK_PREVIOUS_BASE64=<old>
  ├── operator restarts containers
  └── after 1 successful boot + verification, operator removes APP_KEK_PREVIOUS_BASE64
```

### Key Data Flows (summary)

1. **Ingest:** user paste → URL parser → `tracked_items` insert → scheduler picks it up → poll job → snapshot.
2. **Poll cycle:** scheduler tick → tier resolver → priority-queue enqueue → worker → integration adapter → snapshot insert + `last_polled_at` update.
3. **Read:** UI loads game → SvelteKit `+page.server.ts` → `/api/games/:id` → tenant-scoped query → render list.
4. **Chart:** UI loads item detail → `/api/items/:id/snapshots` → tenant-scoped time-series query → LayerChart line.
5. **Wishlist correlation (D-03):** UI loads game timeline → `/api/games/:id/timeline` returns events + wishlist daily snapshots + per-item snapshots → LayerChart with annotation markers.
6. **Secret write:** UI form → `secrets` service → envelope.encrypt → INSERT → audit log; UI receives only last4.
7. **Secret read (worker only):** worker job → secrets row by `(userId, kind)` → envelope.decrypt → adapter call → buffer dropped at end of job.
8. **Audit log read:** owner's own `/audit` page → tenant-scoped paginated SELECT.

## Storage Shape (ER Outline)

Every user-owned table has `user_id uuid not null` indexed and (where Postgres semantics allow) a foreign key to `users(id)`. Self-host inserts a single synthetic `users` row at boot.

```
users (Better Auth manages)
  id uuid pk
  email text
  google_sub text unique
  created_at timestamptz
  last_login_at timestamptz
  ─ Better Auth also owns: sessions, accounts (OAuth tokens), verification tokens

games
  id uuid pk
  user_id uuid not null  ──▶ users.id  (tenant scope)
  title text not null
  steam_app_id integer null
  steam_url text null
  cover_url text null
  release_date date null
  genres text[] null
  notes text null
  created_at timestamptz
  ─ index: (user_id, created_at desc)

tracked_items                              ── one per Reddit post / YouTube video / etc.
  id uuid pk
  user_id uuid not null  ──▶ users.id  (tenant scope; redundant with games.user_id but
                                        kept here so worker queries don't need a join)
  game_id uuid not null  ──▶ games.id
  platform text not null  ('reddit' | 'youtube' | 'steam_app' | ...)
  external_id text not null
  url text not null
  subreddit text null         (when platform='reddit')
  channel_id text null        (when platform='youtube')
  is_blogger_coverage boolean default false   ── TS-06
  added_at timestamptz default now()
  last_polled_at timestamptz null
  last_poll_status text null  ('ok' | 'auth_error' | 'not_found' | 'rate_limited' | ...)
  last_poll_error_at timestamptz null
  hot_until timestamptz null  ── D-06: user-pinned 'track this hot for 7 more days'
  title text null             ── populated on first successful poll
  ─ unique(user_id, platform, external_id)
  ─ index: (user_id, game_id)
  ─ index: (last_polled_at) WHERE last_polled_at IS NOT NULL  ── for scheduler scan

metric_snapshots                            ── append-only time series; THE store for charts
  id bigserial pk
  user_id uuid not null  ──▶ users.id  (tenant scope; required for read-side filtering)
  item_id uuid not null  ──▶ tracked_items.id
  polled_at timestamptz not null default now()
  payload jsonb not null   ── platform-specific shape:
                           ──   youtube:  {viewCount, likeCount, commentCount}
                           ──   reddit:   {score, upvoteRatio, numComments, removed}
                           ──   steam:    {wishlistCount}  ── per-game daily, item_id refers to
                           ──             the game-level wishlist tracker item
  ─ index: (item_id, polled_at desc)        ── chart query
  ─ index: (user_id, polled_at)             ── audit / export
  ─ partition candidate by polled_at month at >10M rows

wishlist_snapshots                          ── daily granularity (AF-10: never realtime)
  id bigserial pk
  user_id uuid not null
  game_id uuid not null
  snapshot_date date not null
  source text not null      ('steam_api' | 'csv_import' | 'manual')
  wishlist_count integer not null
  raw_payload jsonb null    ── full Steamworks response when source='steam_api'
  ─ unique(user_id, game_id, snapshot_date)
  ─ index: (game_id, snapshot_date)

secrets                                     ── envelope-encrypted per row
  id uuid pk
  user_id uuid not null
  kind text not null        ('youtube_api_key' | 'reddit_oauth' | 'steam_api_key')
  ── ciphertext
  secret_ct bytea not null
  secret_iv bytea not null
  secret_tag bytea not null
  ── wrapped DEK (KEK encrypts this)
  wrapped_dek bytea not null
  dek_iv bytea not null
  dek_tag bytea not null
  ── metadata
  last4 text not null       ── shown in UI; never decrypted from ciphertext
  kek_version smallint not null default 1   ── increments per rotation
  created_at timestamptz default now()
  rotated_at timestamptz null
  ─ unique(user_id, kind)   ── one current secret per kind per user

events                                       ── TS-08 free-form timeline + D-11 campaign tags
  id uuid pk
  user_id uuid not null
  game_id uuid not null
  occurred_at timestamptz not null
  kind text not null        ('conference' | 'twitter_post' | 'tg_post' | 'discord' | 'other')
  title text not null
  url text null
  notes text null
  campaign_tag text null    ── D-11

subreddit_rules                              ── NOT user-scoped (shared seed + cache)
  id uuid pk
  name text unique not null  ('IndieDev', 'IndieGaming', ...)
  raw_text text null         ── from Reddit /about/rules
  cooldown_days integer null
  allowed_flairs text[] null
  min_account_age_days integer null
  min_karma integer null
  self_promo_cap text null   ── e.g. '1 in 10' (free text; warning only)
  notes text null
  fetched_at timestamptz null
  ─ when self-host wants to override, see game_subreddit_overrides

game_subreddits                              ── user-scoped link + per-game state
  id uuid pk
  user_id uuid not null
  game_id uuid not null
  subreddit text not null
  attached_at timestamptz default now()
  last_posted_at timestamptz null  ── computed; cached from MAX(tracked_items.added_at)
  override_cooldown_days integer null  ── D-01 user-curated override
  override_notes text null
  ─ unique(user_id, game_id, subreddit)

audit_log                                    ── append-only, owner-readable
  id bigserial pk
  user_id uuid not null
  occurred_at timestamptz default now()
  actor text not null       ('user' | 'worker' | 'scheduler' | 'system')
  action text not null      ('login.success' | 'item.created' | 'secret.rotated'
                            | 'integration.auth_error' | 'export.requested' | 'kek.rotated')
  ip_address inet null      ── resolved via proxy-trust middleware
  user_agent text null
  metadata jsonb null
  ─ index: (user_id, occurred_at desc)
  ─ NEVER UPDATE OR DELETE — enforce via app code; document in CONTRIBUTING

pgboss.*                                     ── pg-boss owns its schema; do not touch
```

### Storage Patterns Worth Highlighting

- **Snapshot vs current state separation is explicit:** `tracked_items` has `last_polled_at` and `last_poll_status` (current state, mutable, used by scheduler). `metric_snapshots` is the immutable time series that powers charts. Charts NEVER read `tracked_items` for metrics — they read `metric_snapshots`. This is what enables D-03 (correlation chart) and D-12 (stale inbox) to coexist without contention.
- **`user_id` is denormalized into `metric_snapshots`** so the worker can do `WHERE user_id = ? AND item_id = ?` without joining. This is small and pays off heavily when the audit/export endpoints query by user across all items.
- **Tenant scoping is on every user-owned table.** The only non-scoped table is `subreddit_rules` (seed + cache, shared across users — it's public Reddit data). Per-user overrides live on `game_subreddits`, which IS scoped.
- **Append-only audit log** is enforced by code (app uses INSERT, never UPDATE/DELETE). Hardening option for SaaS later: revoke UPDATE/DELETE on `audit_log` for the app role.

## Queue Model (pg-boss)

| Aspect | Decision |
|--------|----------|
| Backend | pg-boss v10 in the same Postgres. No Redis. |
| Schema | pg-boss owns its `pgboss.*` schema; we own everything else. |
| Queue declaration | Explicit `boss.createQueue('poll.hot')` (etc.) at scheduler boot. v10 requires this. |
| Producers | `scheduler` container only (cron-driven); `app` only enqueues `poll.user` for "refresh now". |
| Consumers | `worker` container subscribes all four queues with separate concurrency caps. |
| Retries | 5 attempts, exponential backoff, dead-letter queue per source queue. |
| Failure handling | After max retries → DLQ → audit_log entry → surfaced in D-12 inbox. |
| Cron jobs | `boss.schedule('scheduler.tick', '*/5 * * * *')` → calls `scheduler/enqueue.ts`. |
| Job payload | Always `{itemId: uuid, platform: string}`. Worker re-loads the row to avoid stale-payload races. |
| Rate limiting | per-tier worker concurrency is the primary limiter; pg-boss `singletonKey` prevents duplicate inflight per item. |

### Starvation Prevention

The hard rule: **never one queue, never priority-only.** Each tier has its own concurrency budget. If `poll.cold` has a 10k-job backlog, the `poll.hot` workers are unaffected — they're separate Postgres consumers polling separate queue rows. pg-boss's `SKIP LOCKED` semantics within a queue prevent worker contention; cross-queue separation prevents cross-tier contention.

The `poll.user` queue exists separately so a user clicking "Refresh now" never queues behind a long backlog.

### Why one queue with priorities was rejected

`SELECT ... ORDER BY priority FOR UPDATE SKIP LOCKED` is fine for small backlogs but exhibits head-of-line blocking when a high-priority job is starved by tx contention with low-priority jobs in the same queue. Splitting queues is two extra `boss.work()` calls and gives observable per-tier metrics for free.

## Encryption Flow (KEK / DEK Lifecycle)

### Initial setup (operator)

```
1. Generate KEK:
   openssl rand -base64 32   →   APP_KEK_BASE64 (32 bytes)

2. Set in env (Docker compose / systemd / .env):
   APP_KEK_BASE64=...

3. Boot. App refuses to start if APP_KEK_BASE64 is missing AND any row exists in `secrets`.
   (Prevents the data-corruption-on-empty-KEK footgun.)
```

### Write path (user adds an API key)

```
plaintext = "AIza..."
dek = crypto.randomBytes(32)
{secretCt, secretIv, secretTag} = AES-256-GCM(dek).encrypt(plaintext)
{wrappedDek, dekIv, dekTag}     = AES-256-GCM(kek).encrypt(dek)
last4 = plaintext.slice(-4)

INSERT secrets (user_id, kind,
                secret_ct, secret_iv, secret_tag,
                wrapped_dek, dek_iv, dek_tag,
                last4, kek_version=current_kek_version, created_at=now())

audit_log('secret.created', metadata={kind, last4})

response: {ok: true, last4}     ── plaintext is dropped from memory; never returned, never logged
```

### Read path (worker loading creds)

```
row = SELECT * FROM secrets WHERE user_id=? AND kind=?
dek = AES-256-GCM(kek).decrypt(row.wrapped_dek, row.dek_iv, row.dek_tag)
plaintext = AES-256-GCM(dek).decrypt(row.secret_ct, row.secret_iv, row.secret_tag)
… use plaintext for one HTTPS call …
plaintext is local to the function scope; GC'd at job end. Pino redact rules
prevent it from being logged even if accidentally interpolated.
```

### Rotation path (operator rotates KEK)

Reasons to rotate: KEK leak suspicion; scheduled key rotation policy; HSM upgrade.

```
1. Generate new KEK:
   APP_KEK_NEW_BASE64=$(openssl rand -base64 32)

2. Run rotation script (offline; one-shot container):
   docker compose run --rm \
     -e APP_KEK_BASE64=$OLD \
     -e APP_KEK_NEW_BASE64=$NEW \
     app node scripts/rotate-kek.js

   Script:
     SELECT id, wrapped_dek, dek_iv, dek_tag, kek_version FROM secrets
     for each row:
       dek = AES-GCM(oldKek).decrypt(wrapped_dek, dek_iv, dek_tag)
       {newWrap, newIv, newTag} = AES-GCM(newKek).encrypt(dek)
       UPDATE secrets SET wrapped_dek=newWrap, dek_iv=newIv, dek_tag=newTag,
                          kek_version = kek_version + 1, rotated_at=now()
              WHERE id = ?
     COMMIT in batches of 100; idempotent on resume.

3. Update env:
   APP_KEK_BASE64=$NEW
   APP_KEK_PREVIOUS_BASE64=$OLD   ── kept for ONE deploy in case rollback is needed

4. Restart all three containers (app, worker, scheduler).
   App boot performs a smoke decrypt of one secret row to verify; refuses to start
   listening if it fails.

5. After 24h of clean operation, remove APP_KEK_PREVIOUS_BASE64 from env.

6. audit_log: 'kek.rotated' (count=N) — recorded by the script as a system actor.
```

**Why DEKs aren't rotated:** DEK rotation requires re-encrypting the (potentially long) secret payload. KEK rotation only re-encrypts the (short, fixed-size) DEK. Best practice and matches NIST SP 800-57 envelope-encryption guidance.

**Optional KMS upgrade path:** swap `crypto/envelope.ts` for an implementation that calls Cloud KMS or AWS KMS `Encrypt`/`Decrypt` for the DEK-wrap step only. Application interface unchanged; secrets table unchanged. Documented in `docs/kek-rotation.md` so a self-host operator with HSM ambitions can DIY.

## Self-Host vs SaaS Deltas

| Concern | SaaS (multi-tenant, canonical instance) | Self-host (single-tenant, one team) | Same code? |
|---------|------------------------------------------|---------------------------------------|------------|
| Docker image | `ghcr.io/.../app:vX` | Same image | YES |
| Container topology | 3 containers: `app`, `worker`, `scheduler` (+ cloudflared, +LGTM stack) | 3 containers, OR 1 with `WORKERS_INLINE=true` | YES (env-driven) |
| Database | Postgres 16 (own VM or VPS-local) | Postgres 16 (compose-local) | YES |
| Tenant scope | `userId` from authenticated session, every query parameterised | Synthetic `users` row inserted at boot; same middleware injects that ID | YES |
| Auth | Better Auth Google OAuth, app's own client ID | Better Auth Google OAuth, **operator's own client ID** | YES (env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) |
| Cookie config | `Domain=app.example.com; Secure; SameSite=Lax` | No `Domain` set; `Secure` only if HTTPS reverse proxy present; `SameSite=Lax` | YES (env: `COOKIE_DOMAIN` optional) |
| Edge / TLS | Cloudflare Free + Tunnel (cloudflared sidecar) | Caddy (recommended) / nginx / bare cloudflared | NO infra-side; YES app-side (proxy-trust handles all of these) |
| Trusted proxy IPs | Cloudflare IPv4/IPv6 ranges + 127.0.0.1 | 127.0.0.1 + ::1 (default); operator extends via `TRUSTED_PROXIES` env | YES (env-driven) |
| Rate limiting | `RateLimiterPostgres` (cross-instance state if scaled) | `RateLimiterMemory` (one process is enough) | YES (env: `RATE_LIMIT_BACKEND=postgres\|memory`) |
| API quotas | Each user supplies own keys → quotas are per user | Same — operator supplies their own keys | YES |
| KEK source | env var on the SaaS host (rotated by operator) | env var on the self-host VPS (rotated by user-operator) | YES |
| Backups | Nightly `pg_dump` to Cloudflare R2 (10 GB free tier) | Documented `pg_dump` cron; user chooses storage | NO infra-side; YES app-side (no app code involved in backup) |
| Observability | Pino → Loki + Grafana (LGTM stack on same VPS) | Default: stdout + `docker logs`; optional LGTM compose profile | YES (env: `LOG_TRANSPORT=stdout\|loki`) |
| Audit log | Same | Same — but operator is also the only user, so it's a self-audit | YES |
| Secrets UI | Write-once, last4-only display | Same | YES |
| Email outbound (e.g., for some future notification) | Optional via SMTP env | Optional via SMTP env | YES |
| Subreddit rules seed | Shipped in image (`packages/seed/`) | Same; same JSON | YES |
| Migrations | `drizzle-kit migrate` at boot | Same | YES |

**Key invariant:** all delta is `env vars + compose file shape`. Zero code branches except for two flags (`APP_MODE=saas\|selfhost` for trusted-proxy default; `WORKERS_INLINE=bool` for the single-container option). Both are read once at boot in one config module.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| **0–100 users (SaaS launch)** | One VPS (2–4 GB RAM). 1× app, 1× worker, 1× scheduler container. Postgres 16 on same VPS. LGTM stack on same VPS (~600 MB RAM total). Backups: nightly `pg_dump` → R2. **No changes needed from MVP shape.** |
| **100–1k users** | Same VPS, more worker concurrency (bump `poll.hot` workers from 4 to 8). Add `metric_snapshots` partitioning by month once table exceeds ~10M rows. Promote rate limiter to `RateLimiterPostgres` if not already. |
| **1k–10k users** | Move Postgres to a managed instance OR a dedicated VPS (vertical scale before horizontal — Postgres on a 16 GB box handles a lot). Add a second `worker` container behind the same queue. App tier still single replica unless CPU-bound. |
| **10k+ users** | Split `worker` into `worker-hot`, `worker-warm`, `worker-cold` containers if observability shows tier concurrency needs independent tuning. Add Postgres read replica for chart endpoints. Audit log gets its own table with partitioning. |
| **Self-host (always 1–10 users)** | None needed. Default config oversizes for the load. |

### Scaling Priorities (what breaks first)

1. **Postgres write throughput on `metric_snapshots`** — first bottleneck at scale because every poll is an INSERT. Mitigation: monthly partitioning, batched inserts in worker (already accumulating per-job naturally), read replicas for charts. **Earliest signal:** worker job duration p95 climbing.
2. **YouTube API quota per user** — 10k units/day per Google Cloud project. `videos.list` is 1 unit. So 10k polls/day per user = ample even at hot cadence (every 30 min × 24 = 48 polls per item; budget supports ~200 hot items per user). Mitigation: D-09 quota dashboard surfaces this *to the user*, not the SaaS.
3. **Reddit OAuth rate limit** — 100 req/min per OAuth app. Per-user keys distribute this. Mitigation: same as above.
4. **Single-VPS RAM at LGTM scale** — Loki indexing cost is the swelling line item. Mitigation: drop log retention, or move LGTM to a separate cheap VPS.
5. **pg-boss queue table growth** — pg-boss v10 partitions automatically; vacuum runs on schedule. **Not a near-term concern.**

The bottlenecks **never include "we need Redis" or "we need Kafka"** — that's the design payoff.

## Anti-Patterns

### Anti-Pattern 1: Postgres Row-Level Security as the Tenant-Scope Primary

**What people do:** Enable RLS on every user-owned table, set `SET LOCAL app.user_id = ?` in a transaction, let Postgres enforce tenant isolation.

**Why it's wrong here:**
1. The worker needs to load *another user's* secrets to do its job (well — the *job's* user's secrets). Setting the right `app.user_id` per job is doable but slow (round-trip per session) and noisy in logs.
2. pg-boss's own queries don't expect an RLS-aware connection; you'd need a separate non-RLS pool for pg-boss vs the app pool. Two pools is one pool too many for a single-VPS app.
3. RLS errors surface as runtime failures inside Drizzle, not at compile time. The TS-first scope-by-`userId`-arg model surfaces missing scopes as type errors.

**Do this instead:** Tenant scoping by convention + types (Pattern 1 above) is enforceable in code review and in tests. Add RLS later as defense in depth on the SaaS instance — *don't* design around it as the primary mechanism.

### Anti-Pattern 2: One-Queue-with-Priorities Polling

**What people do:** Single `poll` queue. Set `priority: 0` on hot, `priority: 5` on warm, `priority: 10` on cold. Workers do `SELECT ... ORDER BY priority FOR UPDATE SKIP LOCKED`.

**Why it's wrong:** Postgres skip-locked over a single queue with mixed priority causes the workers to block on transactional contention with the cold backlog. A 5,000-item cold backlog + 4 worker connections is enough to delay hot polls measurably. Also: per-tier metrics become a `GROUP BY priority` everywhere, and tuning concurrency for one tier means tuning all tiers.

**Do this instead:** Four named queues, separate worker concurrency per queue (Pattern 3).

### Anti-Pattern 3: In-Process Decrypted-Secret Cache

**What people do:** "It's slow to decrypt every job — let's cache the plaintext credentials in a Map keyed by `userId`."

**Why it's wrong:** That cache is an in-process plaintext-secret store. A heap dump, a careless logger, or a shared-process compromise leaks them all. AES-GCM decrypt on a 32-byte payload takes microseconds; the cache saves nothing real and creates a secret-management problem.

**Do this instead:** Decrypt per job. Plaintext is local to the function scope. Pino redaction rules prevent accidental logging. If decryption itself becomes a bottleneck (it won't), measure first.

### Anti-Pattern 4: Mutating the Tracked Item with the Latest Metric

**What people do:** "Just put `last_view_count`, `last_upvotes`, etc. on `tracked_items` and update on each poll."

**Why it's wrong:** Kills the chart. Kills D-03 (correlation). The whole product depends on the time series being intact. Once you mutate, the history is gone.

**Do this instead:** `metric_snapshots` is append-only. `tracked_items` carries only **current state-of-polling** fields (`last_polled_at`, `last_poll_status`). The latest *metric value* is derivable via a view; never stored mutably.

### Anti-Pattern 5: Trusting `X-Forwarded-For` Without an Allowlist

**What people do:** Read `req.headers['x-forwarded-for'].split(',')[0]` and put that in audit log.

**Why it's wrong:** Anyone can send `X-Forwarded-For: 1.1.1.1` to your origin if your origin is reachable. Audit log gets spoofed. Rate limiter targets the wrong IP. In self-host with a misconfigured proxy, the operator might be banning their own home IP.

**Do this instead:** Trust headers only when the source IP is in the configured `TRUSTED_PROXIES` list. Default it sanely per `APP_MODE` (Pattern 5). Document the list in `docs/trusted-proxy.md`.

### Anti-Pattern 6: Long-Lived Decrypted KEK in Memory in `app`

**What people do:** Cache `kek = Buffer.from(process.env.APP_KEK_BASE64, 'base64')` as a module-level constant.

**Why it's wrong (subtly):** The `app` container doesn't actually need the KEK most of the time — only on secret create/rotate. The `worker` does, on every job. A leaked `app` heap dump shouldn't disclose the KEK if the KEK never lives there.

**Do this instead:** `app` reads KEK only inside the `secrets.create` / `secrets.rotate` code path, then discards. `worker` reads KEK on each job (cheap). Yes, this is a small optimization; it's also a defense-in-depth move that costs nothing.

## Integration Points

### External Services

| Service | Integration Pattern | Auth | Notes / Gotchas |
|---------|---------------------|------|-----------------|
| Google OAuth (login) | Redirect flow via Better Auth | Google client ID/secret in env | SaaS: shared client ID. Self-host: operator creates their own at console.cloud.google.com (documented). |
| YouTube Data API v3 | `googleapis.youtube.videos.list({id, part:[snippet,statistics]})` | Per-user **API key** (read-only on public data, no OAuth needed for `videos.list` on public videos) | 10k quota units/day per Google project; `videos.list` = 1 unit; `search.list` = 100 (avoid in MVP — anti-feature AF-04 confirms). |
| Reddit API | Native `fetch` to `https://oauth.reddit.com/comments/{id}.json` | Per-user **OAuth app** (script type), refresh token stored encrypted | snoowrap is **archived 2024-03-17** — do not use. Native fetch in ~150 LoC. Honor 100 req/min limit. |
| Reddit `/about/rules` | `GET /r/{sub}/about/rules.json` | Same OAuth | Returns raw rules (short_name + description). Structured cooldown/flair fields are NOT in the API — comes from D-04 curated seed + per-game overrides. |
| Steam Web API (wishlist) | `fetch` to `https://api.steampowered.com/IWishlistService/GetWishlistItemCount/v1/?key=...&steamid=...` | Per-user **publisher key** | Optional — manual CSV import is the alternative path. Key rotation is the user's responsibility (PROJECT.md). |
| Steam appdetails (cover image) | `fetch` to `store.steampowered.com/api/appdetails?appids=...` | None (public) | Used to lazy-fetch cover art for `games` rows. Cache aggressively; not user-keyed. |
| Cloudflare Tunnel | cloudflared sidecar, reads tunnel token from env | Cloudflare account token | SaaS only. Self-host is opt-in via compose profile. |

### Internal Boundaries

| Boundary | Direction | Communication | Notes |
|----------|-----------|---------------|-------|
| SvelteKit `web` ↔ Hono `app` | bidirectional | HTTP + cookies; same origin in production | Same Docker image bundles both; SvelteKit served as static under SSR adapter from the same Hono server. |
| `app` ↔ Postgres | bidirectional | pg pool | One pool, one config module. Drizzle for app queries; pg-boss owns its own pool (configured to share max connections). |
| `scheduler` ↔ Postgres | one-way (scheduler reads `tracked_items`, writes `pgboss.jobs`) | pg-boss `send` / `schedule` | Scheduler does NOT write business tables. |
| `worker` ↔ Postgres | bidirectional | reads `secrets`, `tracked_items`; writes `metric_snapshots`, `audit_log` | Single transaction per poll-result write. |
| `worker` ↔ External APIs | outbound HTTPS only | per-platform adapter | 30s default timeout; backoff on 429/5xx. |
| `app` ↔ External APIs | outbound HTTPS only, **only on secret-write paths** to validate the key works | per-platform adapter (the same one) | A secret-write does ONE test call before persisting (catch typos). Failure = 422 to user. |
| `app` ↔ Better Auth | in-process | function calls | Better Auth runs in the `app` process; its routes are mounted on Hono. |

## Build Order (Roadmap Implications)

Strict dependencies. Anything in tier N requires every component in tier ≤N to exist.

### Tier 0 — Foundation (must land before any feature can ship)

1. **Repo scaffold + Docker image + compose files (SaaS + self-host)** — one image, three roles. Dockerfile, compose templates, Caddyfile example.
2. **Postgres + Drizzle schema scaffold** — `users`, `games`, `tracked_items`, `metric_snapshots`, `secrets`, `audit_log` minimally. Migrations on boot.
3. **Hono `app` skeleton + tenant-scope middleware + proxy-trust middleware** — the chokepoint. Tested with two synthetic users.
4. **Better Auth wired (Google OAuth)** — login round-trip working in dev. Self-host injects synthetic user at first boot.
5. **Envelope encryption module** — `crypto/envelope.ts` with unit tests. KEK presence check on boot.

### Tier 1 — Ingest + Read CRUD (the spreadsheet replacement)

6. **Games CRUD** — `services/games.ts`, `/api/games`, SvelteKit pages. (TS-01)
7. **Tracked items CRUD + URL parser** — Reddit + YouTube URL detection. (TS-02 partial)
8. **Secrets write-once UI + service** — uses envelope module. (TS-10)
9. **Audit log read endpoint + UI** — paginated owner-only view. (TS-12)

### Tier 2 — Polling pipeline (the differentiator engine)

10. **pg-boss installed + queue declarations** — `poll.hot|warm|cold|user`, dead-letter queues.
11. **Scheduler container + tier resolver + cron tick** — enqueues jobs. (D-06 backbone)
12. **Worker container + integration adapters (YouTube + Reddit)** — pure adapters. Snapshot-and-forward writes.
13. **Steam Web API adapter (optional path)** — wishlist daily fetch. (TS-04 partial)
14. **CSV wishlist import path** — for users without a Steam key. (TS-04 complement)

### Tier 3 — Visualization (the actual product)

15. **Per-item detail page with line chart** — LayerChart over `metric_snapshots`. (TS-03 + TS-07)
16. **Combined per-game timeline chart** — events + items + wishlist line. (TS-05)
17. **Annotated correlation chart** — markers + side panel. (D-03 — the headline)
18. **Hot/warm/cold polling badges** — status surface in UI. (D-06)

### Tier 4 — Reddit-first differentiator

19. **`subreddit_rules` table + curated seed import (top ~10 indie subs)** — D-04.
20. **Reddit `/about/rules` fetcher (worker job)** — auto-pull raw text on attach. (D-01 raw-text leg)
21. **Subreddit rules cockpit UI** — view + edit structured fields per game. (D-01 structured leg)
22. **Pre-post warning on URL submit** — traffic-light verdict. (D-02)

### Tier 5 — Trust + parity polish

23. **CSV/JSON export per game** — audit-logged. (TS-11)
24. **Per-key quota dashboard** — surfaces YouTube/Reddit headroom. (D-09)
25. **"What's stale" inbox** — surfaces failed/silent polls. (D-12)
26. **Self-host docs + KEK rotation runbook + AGPL flag in license docs** — D-08 finalisation.
27. **Open-source release** — `THIRD_PARTY_LICENSES.md` from `npm ls --prod`, MIT LICENSE.md, README, contributor guide.

### Tier 6 — Post-launch (after validation)

D-07 (creator entity), D-10 (heatmap), D-11 (campaign tags), and the items in FEATURES.md "Add After Validation".

### Build-Order Notes

- **Tier 0 is non-negotiable in this order.** Skipping the tenant-scope middleware until later means retrofitting `userId` arguments across services, which is exactly the kind of silent-bug-source SaaS multi-tenancy fails on.
- **Tier 1 ships a usable SaaS** (CRUD + secrets + audit) **without polling.** It's not the product yet, but everything is end-to-end testable.
- **Tier 2 introduces pg-boss + workers in one go** because they're co-dependent. The first integration adapter (YouTube — simplest auth — just an API key) validates the entire shape; Reddit (OAuth refresh) and Steam (publisher key) fall in afterwards on the same scaffolding.
- **Tier 3 makes it a product.** Without charts, the time-series ingest is invisible. D-03 is gated on TS-05; ship TS-05 (raw lines) first, then add markers.
- **Tier 4 is the moat.** D-01/D-02 require the whole stack to be working — Reddit polling, secrets, scheduler. They land late but are the launch differentiator.
- **Tier 5 is the trust layer** that converts "interesting" into "I'll switch off the spreadsheet." Export + quota dashboard + stale inbox are individually small but together signal honesty.
- **Self-host parity is preserved at every tier.** Each tier's milestone exit criteria includes "compose-up self-host smoke test passes."

## Sources

- PROJECT.md (locked constraints) — HIGH
- STACK.md (Hono, pg-boss, Drizzle, Better Auth, Postgres, envelope encryption) — HIGH
- FEATURES.md (feature dependencies, MVP scope, anti-features) — HIGH
- [pg-boss queue model + cron + DLQ](https://github.com/timgit/pg-boss) — HIGH
- [Hono proxy helper / behind reverse proxy](https://hono.dev/examples/behind-reverse-proxy) — HIGH
- [Better Auth cookie + session cookie domain config](https://better-auth.com/docs) — HIGH
- [Drizzle schema-as-code patterns](https://orm.drizzle.team/) — HIGH
- [Node `crypto` AES-256-GCM API](https://nodejs.org/api/crypto.html) — HIGH
- [NIST SP 800-57 envelope encryption guidance](https://csrc.nist.gov/publications/detail/sp/800-57-part-1/rev-5/final) — HIGH (rotate KEKs, not DEKs as the cheap path)
- [Cloudflare IP ranges (for trusted-proxy default)](https://www.cloudflare.com/ips/) — HIGH
- [YouTube Data API v3 quota costs](https://developers.google.com/youtube/v3/determine_quota_cost) — HIGH
- [Reddit OAuth API rate limits](https://github.com/reddit-archive/reddit/wiki/API) — MEDIUM
- [snoowrap archived notice](https://github.com/not-an-aardvark/snoowrap) — HIGH (do-not-use)
- [Postgres `SELECT ... FOR UPDATE SKIP LOCKED` semantics](https://www.postgresql.org/docs/16/sql-select.html) — HIGH

---
*Architecture research for: multi-tenant indie SaaS with adaptive pollers, encrypted secrets, parallel open-source self-host*
*Researched: 2026-04-27*
