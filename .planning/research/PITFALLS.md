# Pitfalls Research

**Domain:** Multi-tenant indie SaaS with adaptive background pollers, encrypted per-user secrets, parallel open-source self-host, and a single solo operator
**Researched:** 2026-04-27
**Confidence:** HIGH for the architectural / multi-tenant / queue / encryption pitfalls (verified against PROJECT.md, STACK.md, ARCHITECTURE.md and current external docs). MEDIUM for some of the Reddit-shadowban specifics (Reddit publishes general policy but not its anti-spam thresholds; thresholds reflect community-curated wisdom and 2024-2025 dev/marketing posts, not Reddit's own internal numbers). HIGH for cost/quota/license traps (verified against current Cloudflare, YouTube, AGPL docs).

This document is structured around the **10 landmine areas** called out in the milestone context. Every pitfall is tagged:

- **Severity:** CRITICAL (causes data loss / security incident / service down) / HIGH (causes user-visible breakage or trust loss) / MEDIUM (causes dev-time pain or rework)
- **Phase:** which Tier from `ARCHITECTURE.md > Build Order` should own the prevention.
- **Detection:** the concrete log line, metric, or user behavior that surfaces it before it bites.

## Critical Pitfalls

### Pitfall 1: Forgetting `WHERE user_id = ?` in even one query (multi-tenant data leak)

**Severity:** CRITICAL — single instance of this in production = breach disclosure event.

**What goes wrong:**
A `SELECT * FROM tracked_items WHERE id = $1` (no `user_id` filter) returns user A's data when user B requests it by guessing/scraping IDs. This is the textbook multi-tenant SaaS failure. It also happens silently in worker code paths (`load tracked_item by id, then load secrets for that user_id` — but if the second load doesn't reassert that the loaded user_id matches the *requesting* user's, a job-payload-tampering attack can read another tenant's secrets).

**Why it happens:**
- A new endpoint added in a hurry copy-pastes a query but forgets the tenant clause.
- A "by ID" lookup *feels* safe because UUIDs aren't enumerable — until they leak via referer headers, screenshots, share links, or audit log exports.
- Worker code passes `{itemId}` in a job payload and then trusts it; an attacker who can enqueue a job (via a regression in the rate-limited "refresh now" endpoint) gets cross-tenant read.
- Better Auth's session middleware sets `userId` on Hono context — but the developer writing a service function reads from the DB directly without using the tenant-scoped helper.

**How to avoid (concrete moves):**
1. **Tenant-scoped service signature pattern (already in ARCHITECTURE.md Pattern 1):** every service function MUST take `userId: string` as the first non-optional argument. Type-check this.
2. **A custom ESLint/Biome rule:** ban `db.select().from(USER_TABLE)` without a `.where(...eq(table.userId, ...))` clause. The rule is allow-listed for the ~3 non-tenant tables (`subreddit_rules`, `pgboss.*`, Better Auth's session table which has its own scope).
3. **Worker re-asserts ownership:** `loadTrackedItem(jobUserId, itemId)` — the worker's first DB call uses `WHERE id = ? AND user_id = ?` so a tampered job payload cannot reach another tenant's row.
4. **Cross-tenant integration test mandatory in CI:** create user A and user B; insert one item per user; assert that every API endpoint returns 404 (not 403 — don't reveal existence) when A tries to read B's resource. Run on every PR.
5. **PR review checklist item:** "Does any new query touch a tenant-owned table without `user_id` filter?"
6. **Defense in depth (post-MVP):** add Postgres RLS as a *secondary* enforcement on the SaaS instance. Don't make it primary (anti-pattern in ARCHITECTURE.md), but a belt-and-braces RLS policy catches the one query that slipped through.

**Warning signs:**
- Audit log shows `actor=user_id=A, action=item.read, metadata.item.user_id=B` (resolved item's tenant ≠ requester's tenant) — set up an alert for this query immediately.
- Pino log line `WARN tenant.mismatch` from a guard added at the service layer (every service function should log + throw if it ever loads a row whose `user_id` doesn't match its argument).
- Sentry/Loki spike in `404 not found` from API after a refactor (means the scope is now correctly restrictive, but if it spikes from existing users the old behavior was leaking).

**Phase to address:** Tier 0 (Foundation) — `tenant-scope middleware` is item 3 in build order. Cross-tenant integration test lands here. Skipping this until later means retrofitting `userId` arguments across every service.

---

### Pitfall 2: KEK leaking via env-dump endpoint, log line, or error message

**Severity:** CRITICAL — KEK leak + DB leak = total compromise of every user's API keys.

**What goes wrong:**
The `APP_KEK_BASE64` value ends up somewhere it shouldn't:
- `/api/health` or `/api/debug` endpoint that returns `process.env` (a 5-line monitoring helper "for ops" added during incident response).
- An unhandled exception serialized via `JSON.stringify(err)` where the error includes a stack frame referencing the env value.
- A Pino log line that interpolated `process.env.APP_KEK_BASE64` because someone wrote `logger.info({env: process.env}, 'starting up')`.
- A Docker `docker inspect` showing it in `Config.Env`, accessible to anyone with Docker socket access (if `cloudflared` or another sidecar is misconfigured to share the socket).
- A crash dump / heap snapshot uploaded to Sentry / shipped to Loki for "debugging" — `Buffer.from(KEK_BASE64, 'base64')` lives on the heap as a `Buffer` object.

**Why it happens:**
Single-operator instinct is "I'll add a /env endpoint to debug, behind admin-only auth." Auth bug → endpoint exposed. Or: a logger with default redaction misses env-name patterns ("KEK", "KEY", "SECRET" — "APP_KEK_BASE64" might not match "*key*" patterns depending on regex).

**How to avoid (concrete moves):**
1. **Never have a route that returns env.** Not `/api/debug`, not `/api/health` (a real health check returns `{ok: true}`, period — not env). Lint rule: ban `process.env` in HTTP handler files (`http/**`); only `config/` may read env, and config exports specific named symbols never the raw object.
2. **Pino redaction config (already in STACK.md):**
   ```ts
   const logger = pino({
     redact: {
       paths: [
         '*.apiKey', '*.refreshToken', '*.accessToken',
         'env', '*.env',
         'APP_KEK_BASE64', '*.APP_KEK_BASE64',
         'kek', '*.kek', '*.KEK',
         'plaintext', '*.plaintext',
         'req.headers.authorization', 'req.headers.cookie',
       ],
       censor: '[REDACTED]',
     },
   });
   ```
3. **Disallow `JSON.stringify(err)` on caught errors.** Use `pino`'s built-in error serializer or a custom one that strips known sensitive keys.
4. **KEK is a `Buffer`, never a string in code.** Convert once at boot in `config/index.ts`: `const KEK = Buffer.from(process.env.APP_KEK_BASE64!, 'base64'); delete process.env.APP_KEK_BASE64;` — once consumed, remove from env so any later `process.env` dump can't leak it.
5. **No heap dumps in production.** Sentry / Loki don't get heap snapshots; if you need one for an incident, take it locally and discard.
6. **Don't share the Docker socket.** `cloudflared` and Caddy do not need `/var/run/docker.sock`. Self-host docs must call this out.
7. **`app` doesn't load KEK at all** (anti-pattern #6 in ARCHITECTURE.md — only the secret-write code path loads KEK; the worker loads it per job). This shrinks the surface that could leak it.

**Warning signs:**
- Any Pino log line containing a 32+-byte base64 string (regex monitor on Loki).
- A PR that adds `process.env` outside `config/`.
- Sentry/error-tracking events with stack traces longer than ~50 frames (long stacks often capture closure scope including config).

**Phase to address:** Tier 0 (Foundation) — when envelope encryption module lands (item 5). Pino redaction config and the "no env in HTTP layer" lint rule are part of the initial commit, not retrofitted.

---

### Pitfall 3: Returning ciphertext or plaintext via API by accident

**Severity:** CRITICAL.

**What goes wrong:**
A "List my saved keys" endpoint returns the entire `secrets` row. Either:
- It returns the ciphertext fields (`secret_ct`, `wrapped_dek`) — these alone don't decrypt without KEK, but combined with a KEK leak they do, AND they reveal how many secrets each user has, which is metadata an attacker can use.
- It returns plaintext because someone "helpfully" decrypted to populate a "View key" button (which is explicitly out of scope per PROJECT.md: write-once UI, last-4 only).
- The API serializer naively spreads the row: `c.json({...secret})`.

**Why it happens:**
Drizzle returns full rows by default. Developer writes `c.json(secret)`. The "show last 4" UI got built on top, but the API still leaks the rest because the *server-side* never explicitly removed them.

**How to avoid:**
1. **DTO discipline:** every API response shape is a zod schema in `packages/shared-types/`. The `SecretDto` schema has only `{id, kind, last4, kek_version, created_at, rotated_at}` — no ciphertext fields. Hono's `@hono/zod-validator` validates the response too (defense against accidentally returning extra fields).
2. **Drizzle `select({...})` projection** instead of `select()`: explicitly list non-sensitive columns. Never `SELECT *` on `secrets`.
3. **Test:** "GET /api/secrets/:id never returns a key with more than 8 hex chars in any value" — a property-based test that fuzzes the response and asserts no field length suggests a base64 secret blob.
4. **Audit endpoint test:** export endpoint (TS-11) is the most likely accidental leak vector. The export schema explicitly excludes the `secrets` table. Test: snapshot the JSON shape of the export and assert no key starting with `secret_` or `wrapped_` exists.

**Warning signs:**
- Any new endpoint returning a `secrets` row passes through Hono's zod-validator without an explicit response schema.
- TS type errors disappear after someone adds `as any` or `// @ts-ignore` near a secret-table query.

**Phase to address:** Tier 1 (Ingest CRUD) — when secrets write-once UI lands (item 8 in build order). Export endpoint test lands in Tier 5 (item 23) but the underlying DTO discipline is set in Tier 1.

---

### Pitfall 4: pg-boss queue starvation — cold backlog blocks hot polls

**Severity:** HIGH — looks like "service is broken / no longer polling new posts" to users.

**What goes wrong:**
Naive implementation: one `poll` queue, jobs given a `priority`. A 5,000-item cold backlog (built up over the first month of users) lands in the queue. Workers do `SELECT ... ORDER BY priority FOR UPDATE SKIP LOCKED`. The hot polls *do* run, but on heavily contended queue rows, the scheduler tx and worker tx contend; under load the head-of-line blocking shows up as p95 hot-poll latency creeping from 30s to 15min. Users see "I just added a Reddit post and the chart is empty for 20 minutes" → trust dies.

**Why it happens:**
"Priority is what queues are for" is the obvious instinct. It works at small scale and breaks at exactly the moment the product proves out (more users, more cold items).

**How to avoid:**
1. **Four named queues, not one (Pattern 3 in ARCHITECTURE.md):** `poll.hot`, `poll.warm`, `poll.cold`, `poll.user`. Each gets its own concurrency cap (4 / 2 / 1 / 2 workers respectively). Cold's worker pool has no relationship to hot's.
2. **`poll.user` is its own queue, separate from hot.** A user clicking "Refresh now" must never queue behind another user's hot polls. This is the reason for the fourth queue.
3. **Singleton key per item:** `boss.send('poll.hot', payload, {singletonKey: itemId})` — prevents the same item being enqueued twice into the same tier (which can happen if scheduler ticks overlap). pg-boss v10 supports this natively.
4. **Per-tier observability:** Prometheus metric `gpd_queue_depth{tier="hot|warm|cold|user"}`. Grafana alert: `poll.hot` queue depth > 50 for 10 min OR `poll.user` queue depth > 5 for 2 min.
5. **Worker config caps connections:** if total worker concurrency = 9 (4+2+1+2), the worker container's pg pool max = 12 (concurrency + headroom). Don't let pg-boss exhaust the connection pool.

**Warning signs:**
- `pg-boss.job.fetched_at - pg-boss.job.created_at` p95 > 60s on any priority queue (= jobs waiting to be picked up).
- User reports: "added a video an hour ago and it still says 'never polled'" — alert on `tracked_items WHERE last_polled_at IS NULL AND added_at < now() - interval '1 hour'`.
- Postgres `pg_stat_activity` showing many `idle in transaction` connections from the worker = jobs holding row locks while doing slow API calls. (This is the related Pitfall 5 below.)

**Phase to address:** Tier 2 (Polling pipeline) — items 10-12 in build order. The four-queue split is the original design, not a retrofit; if it's ever a "single queue with priorities" first commit, it's a bug.

---

### Pitfall 5: Long-running poll job holds a row lock during external HTTPS call

**Severity:** HIGH — manifests as "everything slows down for everyone" because Postgres connection pool drains.

**What goes wrong:**
A poll job opens a transaction, locks a `tracked_items` row, calls YouTube/Reddit/Steam, *then* writes the snapshot and updates `last_polled_at`. If the external API is slow (Reddit 30s timeout while it's degraded), the row lock is held for 30s. Multiply by N concurrent workers → connection pool full → app HTTP requests time out waiting for a pg connection → cascading failure.

**Why it happens:**
Common transactional pattern: `BEGIN; SELECT ... FOR UPDATE; ...do work...; INSERT; COMMIT;`. The "do work" includes the HTTP call. It looks atomic and clean.

**How to avoid:**
1. **Never hold a DB transaction across an external HTTP call.** Pattern:
   - Acquire job from pg-boss (which handles its own short-lived lock). Read `tracked_items` row in a small read-only query (no FOR UPDATE).
   - Decrypt secret in memory. Make the HTTPS call (with 30s timeout).
   - *Then* open a write transaction: `INSERT metric_snapshots; UPDATE tracked_items SET last_polled_at, last_poll_status; COMMIT`. Total tx duration: <50ms.
2. **Hard timeout on every external fetch:** AbortController with 30s default; YouTube/Reddit/Steam adapters all honor it. Time out before the worker job times out.
3. **Worker job timeout in pg-boss:** `expireInSeconds: 90` per job. If the job blows past that (network hung), pg-boss reclaims and retries — bounding the worst-case lost-resource window.
4. **Per-API circuit breaker** (modest ask): track recent failures per platform; if 5 consecutive failures in 60s, pause that tier's queue for 5 min, alert. Avoids flooding a degraded API with retries.

**Warning signs:**
- `pg_stat_activity` showing connections in `idle in transaction` state for >5 seconds.
- Pino metric `worker.poll.duration_ms` p95 > 5,000.
- User-facing API error rate spike correlating with worker activity.

**Phase to address:** Tier 2 (Polling pipeline) — when worker container + integration adapters land (item 12). Codify the "no external call inside a transaction" rule in `workers/poll-*.ts` review checklist.

---

### Pitfall 6: Lost jobs at SIGTERM — deploy drops in-flight polls

**Severity:** HIGH — silent data gaps (a poll that should have happened but didn't).

**What goes wrong:**
Operator runs `docker compose pull && docker compose up -d` to deploy. Worker container gets SIGTERM, exits in 10s (Docker default). Any job that was in the middle of a poll: the HTTP call may have succeeded, but the snapshot wasn't written before SIGTERM. pg-boss eventually retries the job (so it'll be re-attempted), but if the deploy is buggy and the worker restart fails, jobs sit in the queue indefinitely and `last_polled_at` lags.

**Why it happens:**
Default Docker SIGTERM grace = 10s. pg-boss workers don't have built-in graceful-shutdown integration unless wired up. Docker compose by default uses SIGKILL after grace.

**How to avoid:**
1. **Graceful shutdown handler in worker entrypoint:**
   ```ts
   process.on('SIGTERM', async () => {
     logger.info('SIGTERM received, draining queue...');
     await boss.stop({timeout: 60_000, graceful: true}); // pg-boss API
     await db.end();
     process.exit(0);
   });
   ```
2. **Docker compose `stop_grace_period: 90s`** for `worker` and `scheduler` services (longer than `boss.stop` timeout to be safe).
3. **Idempotent jobs:** snapshot inserts use `INSERT ... ON CONFLICT (item_id, polled_at) DO NOTHING` — if a job was retried after SIGTERM and wrote a snapshot before crashing, the retry sees it. (`polled_at` is unique per item per minute; collisions are vanishingly rare but the constraint protects from the rare double-deliver.)
4. **Health endpoint exposes queue drain state:** `/health/worker` returns `{draining: bool, in_flight: N}`. Operator deployment script can wait on this before pulling the new image.
5. **Run scheduler + workers as separate containers (already in ARCHITECTURE.md):** scheduler restart never drops a poll because scheduler doesn't do polling, only enqueues. Workers can be rolled while scheduler keeps producing jobs — pg-boss buffers them.

**Warning signs:**
- Audit log `system.shutdown.sigterm` followed by gap in `metric_snapshots` for items expected to poll in that window.
- `pgboss.archive` table showing jobs stuck in `active` past their `expireIn` — pg-boss eventually fails them, but a pile of these means SIGTERM kills before drain.
- Prometheus alert: `poll.hot` queue depth not draining for 5 min after deploy.

**Phase to address:** Tier 2 (Polling pipeline) — graceful-shutdown handler and `stop_grace_period` are part of the worker container's first commit (item 12). Self-host docs (Tier 5) document the same.

---

### Pitfall 7: Adaptive polling tier rules drift between scheduler and worker

**Severity:** HIGH — over-polling burns user quota; under-polling makes data stale.

**What goes wrong:**
The scheduler decides "this item is hot, enqueue every 30 min." The worker, after polling, "reschedules" by setting some hint on the row. Two pieces of code now have an opinion about cadence; they diverge. After a refactor, hot items are polled every 15 min from one path and every 60 min from another. YouTube quota burns 4x as fast as the dashboard predicts. Or: the user pinned `hot_until = +7d` (D-06) but only one of the two paths reads that field, so the override silently doesn't work.

**Why it happens:**
Tier rules are deceptively simple ("just `if age < 1d`"), so they get inlined where convenient. Once duplicated in two places, changes to one don't propagate.

**How to avoid:**
1. **Single source of truth: `scheduler/tier-resolver.ts`** — exports `resolveTier(item, now): 'hot' | 'warm' | 'cold'` and `nextDueAt(item, tier, now): Date`. Anywhere code asks "what tier?" or "when next?", it calls these.
2. **Worker does NOT decide cadence.** Worker just polls when told and updates `last_polled_at`. The scheduler tick (every 5 min) re-reads the world and decides what to enqueue.
3. **Property test on the resolver:** for any item across the age boundary (just under 24h vs just over), the resolver returns the expected tier. Run on every commit.
4. **`hot_until` override read in the resolver only.** If a future feature wants to also force hot (e.g., "all items for this game", D-06 extension), it goes through the same resolver, not a new code path.
5. **Per-tier metric on actual cadence:** `gpd_poll_actual_interval_seconds{tier="hot"}` histogram. If hot's median is 15 min when the design is 30 min, alert.

**Warning signs:**
- YouTube quota dashboard shows users hitting 80%+ of daily cap with fewer items than expected — over-polling somewhere.
- Audit log: `item.poll.skipped reason=already_polled_recently` rate too high.
- Two places in code with `if (ageDays < 1)` literal — grep red flag.

**Phase to address:** Tier 2 (Polling pipeline) — when scheduler container + tier resolver lands (item 11). Lint rule: tier-classification ageDays comparison must be in `tier-resolver.ts` only.

---

### Pitfall 8: YouTube quota — a single user with 200 videos burns 10k/day

**Severity:** HIGH — user's polling silently stops mid-day.

**What goes wrong:**
YouTube Data API v3: 10,000 units/day per Google Cloud project. `videos.list` = 1 unit per call (1-50 IDs batched in one call); `search.list` = 100 units. Per-user keys → each user's quota is *their* 10k. Sounds fine. But:
- A user adds 200 videos. Hot tier polls every 30 min for 24h = 48 polls × 200 items = 9,600 calls/day if not batched. Over quota by lunchtime if any other call happens.
- A user has multiple Google Cloud projects' worth of YouTube clients on the same Google account — same user-level quota envelope.
- If you ever use `search.list` (which D-04 / AF-04 explicitly avoids — but feature creep risk), 100 units per call eats budget instantly.
- Quota errors come back as HTTP 403 with a specific `quotaExceeded` reason that needs to be parsed correctly; otherwise it looks like an auth error.

**How to avoid:**
1. **Batch `videos.list` aggressively:** the endpoint accepts up to 50 video IDs per call. Worker groups by `(user_id, platform=youtube)` per scheduler tick: instead of 200 jobs of 1 ID, dispatch 4 jobs of 50 IDs. **This single change cuts quota from 9,600 to 192 calls/day for the same data.**
2. **Hard reject of `search.list` in the YouTube adapter** until v2 (AF-04 stays out of MVP). Lint check: ban `search.list` import.
3. **D-09 quota dashboard** shows daily units used per key, with a warning at 80%. Critical for user trust per ARCHITECTURE.md FEATURES.md.
4. **Quota-aware tier downgrade:** if today's usage projects to >80% by EOD, scheduler temporarily demotes hot → warm for that user (don't drop polls entirely; slow down and recover).
5. **Distinguish `quotaExceeded` vs `forbidden` in the adapter:** parse `error.errors[0].reason`. `quotaExceeded` → set `last_poll_status='quota_exhausted'` and skip remaining jobs for that user until UTC midnight. `forbidden` → set `last_poll_status='auth_error'` and surface in D-12 inbox.
6. **Per-user daily quota counter in Postgres** (small table, `user_id` + `date` + `units_used`). Worker pre-checks before every call. Cheap insurance.

**Warning signs:**
- Pino log line `youtube.quotaExceeded user=X` appearing daily for any user.
- D-09 dashboard showing >80% by 18:00 UTC on a recurring basis.
- Worker error rate on `poll.youtube` jumps after 14:00 UTC and recovers at 00:00 UTC (UTC midnight is YouTube's quota reset).

**Phase to address:** Tier 2 (Polling pipeline) — batched `videos.list` is part of the YouTube adapter's first commit (item 12). Per-user quota counter and tier-downgrade-on-near-exhaustion ship in Tier 5 with D-09 (item 24).

---

### Pitfall 9: Reddit 429 storm during a peak posting window

**Severity:** HIGH — polling stalls just when fresh data matters most.

**What goes wrong:**
Reddit API limit: 100 requests / minute per OAuth app, *and* an unwritten "we'll throttle you harder if you're aggressive" reality. During a peak (your subreddit's primetime, e.g., 18:00 UTC for r/IndieDev), many users' hot polls converge. Even with per-user keys, if the *user's* hot items > 100 / 30 min cadence, the user's app gets 429s. Worker hammers retries → rate limiter pushes back further → cascade.

The other 429 mode: a viral post with 5,000+ comments. `/comments/{id}.json` returns paginated; aggregating "comment count" doesn't need them all (top-level summary is enough), but a naive adapter that walks all comment threads burns calls.

**How to avoid:**
1. **Use Reddit's `Listing` summary endpoints, not full comment trees.** For a tracked post, `/comments/{id}.json?limit=1` returns the post's `score`, `upvote_ratio`, and `num_comments` *as a property* without iterating comments. One call per snapshot.
2. **Honor `X-Ratelimit-*` response headers** that Reddit sends: `X-Ratelimit-Remaining`, `X-Ratelimit-Reset`, `X-Ratelimit-Used`. Worker reads these and pauses *that user's* poll tier until reset if remaining < 10.
3. **Exponential backoff with jitter on 429:** initial 5s, max 5 min, jitter ±20%. pg-boss retry policy supports this.
4. **Per-user Reddit token bucket:** local in-process limiter (`rate-limiter-flexible`) keyed by `userId` + `'reddit'`, capped at 60 req/min (well below Reddit's 100/min ceiling — leaves headroom for the user's own manual browsing if they reuse the OAuth app, which they shouldn't but might).
5. **Stagger schedule jitter:** when scheduler enqueues hot polls, spread enqueue times by 1-30s of jitter so 200 users' hot items don't fire at the same wall-clock second.
6. **No comment-tree expansion.** Adapter is hard-coded to use the listing endpoint with `limit=1`. Lint rule banning the iteration pattern.

**Warning signs:**
- Pino: `reddit.ratelimit.429 user=X remaining=0 reset_in=Ns`. Recurring → user's app is mis-tuned or another tool is sharing the user's OAuth credentials.
- Pino: `reddit.adapter.poll duration_ms > 10_000` — likely walking comment trees.
- pg-boss DLQ for `poll.reddit` filling up after a Reddit-side incident.

**Phase to address:** Tier 2 (Polling pipeline) — Reddit adapter, item 12. The "use listing endpoint with limit=1" is part of the original adapter design per STACK.md (snoowrap is rejected; native fetch in ~150 LoC).

---

### Pitfall 10: Encouraging user behavior that gets *them* shadowbanned on Reddit

**Severity:** CRITICAL for the user (their account is permanently destroyed for promotion). HIGH for our reputation if our UI nudges them into it.

**What goes wrong:**
The Subreddit Rules Cockpit (D-01) and pre-post warning (D-02) are designed to PREVENT shadowbans, but if the curated rule database is stale or wrong, or if the warning UI defaults to "green" too easily, we make it worse — a confident green light → user posts → shadowbanned. The user blames the tool. We've also logged an audit trail of "this UI told them green" which is a liability.

The deeper trap: Reddit's anti-spam algorithm is opaque and triggers on patterns that NO public rule covers. Things like: account < 30 days old, total karma < 10, ratio of self-promotional posts > 10%, rapid cross-posting (same content to 5+ subs in <1h), and "posting from a brand new account that just appeared." NONE of these are in any subreddit's `/about/rules`.

**How to avoid (concrete UI rules):**

The pre-post warning UI must check **both** subreddit-specific rules (from D-04 seed + per-game overrides) **and** account-level Reddit health signals. Concrete rule set the warning module enforces:

| Warning trigger | Source | Severity | Message to user |
|------|------|----------|------------|
| Post within subreddit's `cooldown_days` of last post by same user | D-04 seed `cooldown_days` | RED | "r/X allows one self-promo post per N days; your last was N-M days ago" |
| Subreddit `min_account_age_days` not met | D-04 seed | RED | "r/X requires accounts older than N days" |
| Subreddit `min_karma` not met (we don't *know* their karma — ASK them or skip; never guess) | D-04 seed + user-confirmed input | YELLOW | "r/X requires N+ karma. Confirm you're above this." |
| Allowed flairs declared and post URL doesn't have one | D-04 seed `allowed_flairs[]` | YELLOW | "r/X requires flair: [list]" |
| Self-promo cap: this would be your >10% of recent posts to ANY subreddit | aggregate over `tracked_items WHERE user_id=? AND added_at > now() - interval '30d'` | YELLOW | "Reddit penalizes accounts with >10% self-promo. Recent ratio: X%" |
| 5+ Reddit posts logged for this game in the last 24h | aggregate | RED | "Posting to multiple subreddits within 24h triggers Reddit's anti-spam. Stagger by ≥4h." |
| Same post URL already logged (cross-post tracking) | uniqueness check on `external_id` per user | RED | "This URL is already tracked. Cross-posting same content to multiple subs is a known shadowban trigger." |

**Code/policy moves:**
1. **Default-to-yellow when in doubt.** Green requires explicit pass on every check. Missing data (e.g., user's karma not provided) → yellow with explanation, not green.
2. **D-04 curated seed PR template** requires a `last_verified` timestamp per subreddit. Rules older than 90 days show in UI with "rules may be stale" badge. Forces community PRs to keep current.
3. **The warning is non-blocking** (already in PROJECT.md / FEATURES.md D-02): the user can override. CRITICALLY: every override is audit-logged with the verdict that was overridden, so the user sees their own pattern over time ("you've overridden 5 RED warnings in 30 days" → self-correcting feedback).
4. **In-app docs page on shadowban mechanics** — a one-pager linked from D-01 explaining: account age, karma, self-promo ratio, cross-posting timing. Source: Reddit's own moderator docs + the established 2024-2025 indie marketing community wisdom.
5. **No "auto-detect karma" via Reddit API.** That requires elevated OAuth scopes and starts looking like surveillance. User self-reports karma in their game settings; we use it for the check.
6. **Never auto-cross-post.** Already locked (AF-01). Reinforces here: even a "schedule reminder" feature that *suggests* posting to N subs in N hours is the wrong shape — it normalizes the antipattern.

**Warning signs (for us, the operator):**
- User survey or support ticket: "I got shadowbanned right after using your green-light recommendation." → review the curated rule for that subreddit. Apologize, fix, log.
- Audit log shows users overriding RED warnings and then their items going to `last_poll_status='not_found'` quickly (post removed by moderator).

**Phase to address:** Tier 4 (Reddit-first differentiator) — items 19-22. The "default to yellow" logic and per-warning audit logging are part of D-02's first commit. The in-app shadowban-mechanics docs page ships in Tier 4 alongside D-01.

---

### Pitfall 11: Reddit detecting OUR polling as bot-like behavior, banning the OAuth app

**Severity:** HIGH for SaaS (would degrade everyone) and HIGH for self-host parity.

**What goes wrong:**
Reddit's API is fine with bots — they REQUIRE you to register as a bot in `User-Agent` — but they're hostile to apps that misbehave. Failures: missing or generic `User-Agent`, ignoring rate-limit response headers, rapidly creating new OAuth apps after bans, polling deleted/private posts repeatedly, requesting elevated scopes you don't need.

**How to avoid:**
1. **Mandatory User-Agent format Reddit enforces:**
   `User-Agent: <platform>:<app ID>:<version> (by /u/<reddit-username>)` — e.g., `node:com.neotolis.gpd:0.1.0 (by /u/<operator>)`. Self-host doc instructs the user to replace with their own Reddit handle.
2. **Honor 429s aggressively** (Pitfall 9 above).
3. **Don't repoll posts that returned `404` or `[removed]`/`[deleted]`** — once we observe a removed post, downgrade its tier to "frozen" (a 5th implicit tier: stop polling entirely; surface in D-12 stale inbox). Repeatedly hitting deleted-post URLs looks like bot behavior.
4. **Self-host operator gets their OWN OAuth app** (PROJECT.md per-user-key model is already this). Crucially: if our SaaS canonical OAuth app gets banned, self-hosters are unaffected — bounded blast radius.
5. **Read-only scopes only:** the OAuth app requests `read` and `wikiread` only. Never `submit`, `edit`, `vote`. Reduces both privilege and Reddit's suspicion.
6. **Lint check / runtime assert:** the Reddit adapter never sends a request without User-Agent matching the regex above. Boot fails if env `REDDIT_APP_USER_AGENT` is missing on SaaS.

**Warning signs:**
- Multiple users' Reddit polls returning 401 Unauthorized simultaneously after a known-good period — the OAuth app is suspended.
- Reddit returns `403 SUSPENDED` reason code in error JSON.

**Phase to address:** Tier 2 (Polling pipeline) — Reddit adapter (item 12) ships with strict User-Agent enforcement and 404/removed-post tier-freezing logic.

---

### Pitfall 12: Steam Web API key paste in the wrong field

**Severity:** HIGH (it's a publisher-level credential).

**What goes wrong:**
What's actually exposed if a Steam Web API key leaks (we MUST tell the user this on the secret-add page, or they paste it lazily):
- Read access to wishlist counts and full wishlist details for the publisher's games.
- Read access to sales reports and revenue data for the publisher.
- The key CANNOT publish builds, change store pages, or transact — those require Steamworks login + 2FA.
- **Rotation latency:** instant in Steamworks UI — old key is invalidated immediately on regenerate. This is the primary mitigation per PROJECT.md.
- **Steamworks-side detection of abuse:** Valve does monitor for unusual key-rate patterns. Excessive request volume → key auto-revoked. Our adaptive polling should keep us well under any detection threshold (daily wishlist polls = 1 call/day per game).

UX traps that lead to wrong-field paste:
- User pastes `STEAMWORKS_LOGIN_PASSWORD` thinking it's the Web API key.
- User pastes `STEAM_OAUTH_CLIENT_SECRET` (Steam Web OAuth, a different thing).
- User pastes the URL of the Steamworks dashboard instead of the key value.
- User pastes the key into the YouTube key field by accident; we encrypt it under "youtube_api_key" and try to authenticate to YouTube with it.

**How to avoid:**
1. **Per-key validation on submit:** after envelope encrypt + persist, the secret-write code path makes ONE test API call (`IWishlistService/GetWishlistItemCount` for Steam, `videos.list` with a known public ID for YouTube, `/api/v1/me` for Reddit). If the test fails, the row is deleted, error returned to user. (Already in ARCHITECTURE.md: "A secret-write does ONE test call before persisting.")
2. **Format validation BEFORE encryption:** Steam Web API keys are 32 hex chars; YouTube API keys start with `AIza` and are 39 chars; Reddit OAuth secrets are ~27 chars base64. zod regex per kind. Catches paste-into-wrong-field instantly with a friendly error, doesn't even hit the server.
3. **The "what this key can do" copy on the form:** plain English, before the input field:
   > "Your Steam Web API key gives this app **read access** to your wishlists and sales data. It cannot publish builds or change store pages — those require your Steamworks login, which we never ask for. Rotate this key in Steamworks at any time to revoke our access."
4. **Each key kind has its own form route** (`/settings/keys/steam`, `/settings/keys/youtube`, `/settings/keys/reddit`) with kind-specific copy and field labels. No single "API key" page where a wrong choice is possible.
5. **Audit log entry on key-paste includes the kind + last4** so the user can see in their audit log "I added a Steam key ending in ABCD on March 12." If they recognize the last4 doesn't match what they think they pasted, they can rotate immediately.

**Warning signs:**
- Audit log: `secret.created` immediately followed by `integration.auth_error` — the key was wrong, our test call already caught it (so this is the *good* signal — system worked). If we see this without the validate-on-submit step, it indicates we skipped step 1.
- Support tickets: "Why doesn't my Steam wishlist update?" (= they put their key in the wrong slot or the key is malformed but we accepted it).

**Phase to address:** Tier 1 (Ingest CRUD) — secrets write-once UI (item 8). Format validation, validate-on-submit test call, kind-specific routes are part of the first commit, not a polish pass.

---

### Pitfall 13: Self-host parity rot — SaaS-only assumptions creep into code

**Severity:** HIGH (our entire OSS positioning fails if self-host breaks silently between releases).

**What goes wrong:**
Subtle SaaS-only assumptions accumulate over months:
- A new feature reads `process.env.CF_ZONE_ID` (Cloudflare-specific) without a fallback for non-Cloudflare deploys.
- Telemetry beacon to `analytics.neotolis.com` fires from the SaaS frontend bundle — self-hosters now ping our SaaS instance unintentionally, leaking that they're using the product.
- Hardcoded admin bootstrap (`if email === 'admin@neotolis.com'`) for SaaS support purposes — works fine until a self-hoster picks the same email by coincidence.
- Default cookie `Domain=.neotolis.app` — breaks self-host login because the cookie isn't bound to localhost or the operator's domain.
- A migration assumes Postgres extension `pg_trgm` is preinstalled (was true on the SaaS managed Postgres; not true on a fresh self-host Postgres).
- Reading `CF-Connecting-IP` without fallback to `X-Forwarded-For` — self-host behind nginx misses client IPs.
- File upload path defaults to Cloudflare R2 — self-hoster has no R2 account, feature fails silently.

**How to avoid:**
1. **`APP_MODE=saas|selfhost` env var read once in `config/`.** Code paths that differ branch ONCE at boot, not scattered everywhere. Only known difference points (per ARCHITECTURE.md):
   - Trusted-proxy default IP list
   - Cookie `Domain` set vs not
   - `RATE_LIMIT_BACKEND=postgres|memory` default
   - Optional LGTM stack inclusion
   That's it. Anything else creeping in is a regression.
2. **CI runs self-host smoke test on every PR:** `docker compose -f infra/docker-compose.selfhost.yml up -d`, wait for health, run a smoke test that creates a synthetic user, adds a game, adds an item, checks the audit log. This test FAILS CI if any of the above creep in.
3. **NO telemetry by default.** Period. If we ever want product analytics, add it as `TELEMETRY_ENABLED=false` env var with operator opt-in, document in self-host README, and the code path *must not even initialize the telemetry library* if disabled (no DNS leak).
4. **No hardcoded admin emails or domains.** Admin role is a DB column; SaaS bootstrap script sets it for the operator's account; self-host bootstrap sets it for the first user.
5. **`THIRD_PARTY_LICENSES.md` regenerated on every release** (`npm ls --prod`) so self-hosters can audit at a glance. (Already in STACK.md action item.)
6. **Quarterly self-host parity audit:** grep for `process.env.CF_*`, `cloudflare`, `r2.cloudflarestorage`, `neotolis.com`, `neotolis.app` — any hit outside docs and `infra/` is a parity bug.

**Warning signs:**
- Self-host smoke test starts to flake. Symptom of "it works locally, ships, breaks for self-hosters."
- A self-host user opens an issue: "feature X doesn't work for me." If the SaaS works, that's a parity gap.
- A `process.env.CF_*` variable referenced outside `infra/` or `config/`.

**Phase to address:** Tier 0 (Foundation) — the self-host smoke test in CI is part of the initial Docker compose work. Tier 5 (Self-host docs + KEK rotation runbook + AGPL flag, item 26) is when the docs catch up, but the structural guarantees ship from day one.

---

### Pitfall 14: AGPL contamination from observability stack

**Severity:** HIGH for license claim integrity (we promise MIT).

**What goes wrong:**
Grafana, Loki, and Mimir are AGPL-3.0. AGPL says: if you "distribute" a derivative work or run a "modified version that interacts with users over a network," you must release source. The trap:
- Someone embeds Grafana iframes inside our app → user-facing surface includes AGPL code. Argument that we're "linking" is now possible.
- Someone modifies Loki's source for a self-host fork → distributing that fork triggers AGPL.
- Someone vendors Loki client lib that's actually under AGPL (not just MIT/Apache) into our codebase.
- The self-host docker-compose ships an image of Grafana with our config baked in → arguably "distribution" of a configured/derivative AGPL artifact. (Defensible if config is just YAML, not modified Grafana source, but the line is fuzzy.)

**How to avoid:**
1. **Grafana / Loki / Mimir run as separate services, never embedded.** Reaffirmed in STACK.md. Our app code never imports their libraries; we only POST log lines to Loki via HTTP and let Grafana render its own UI. This is the standard interpretation that AGPL doesn't infect.
2. **No iframe-embedding of Grafana into our app's UI.** If we want to show a metric to the user (D-09 quota dashboard), we query Loki/Prom from our backend and render charts in OUR Svelte UI. AGPL components stay administrator-side.
3. **The LGTM stack is OPTIONAL in self-host.** Self-host docker-compose has a `--profile observability` flag. Default compose-up doesn't include them. Doc clearly states: "These components are AGPL; you can omit them entirely; the app logs to stdout regardless."
4. **No vendoring of AGPL code into the repo.** `package.json` only references AGPL components as separate Docker images (in compose), never as npm deps.
5. **`THIRD_PARTY_LICENSES.md` flags AGPL deps** if any sneak in via transitive npm. CI fails on AGPL-3.0 license in `npm ls --prod` output.
6. **Docs section: "Self-hosting under restrictive license environments"** — for users in regulated/enterprise contexts who can't tolerate AGPL even as a separate service, document running with `--profile observability` disabled.

**Warning signs:**
- A PR that adds `pino-loki` *as a default* (rather than optional) — pino-loki is MIT, but its presence implies LGTM is the default → AGPL lurking.
- A PR that imports any package whose license field is AGPL-3.0 in `npm ls --prod`.
- Anyone proposing iframe embedding of Grafana.

**Phase to address:** Tier 5 (Open-source release, item 27). License audit in CI is part of the release-tooling commit. Self-host docs (item 26) explain the AGPL flag clearly.

---

### Pitfall 15: Cloudflare "Free" tier silently bills

**Severity:** HIGH for solo operator on indie budget — surprise bill.

**What goes wrong:**
Cloudflare's free tier is excellent until it isn't. Things that quietly start charging:
- **Workers Paid plan** ($5/mo) auto-engaged if you exceed 100k Workers requests/day. If we deploy a Worker for any edge logic and forget the limit, billing kicks in.
- **Image transformations** (Cloudflare Images / Polish) — paid features. Easy to enable in dashboard "for performance" and forget they're billed per request after a free tier of 5k/mo.
- **R2 egress over 1M Class A operations/mo** — the free tier covers most indie use, but a misconfigured CDN cache that re-fetches from R2 instead of cache can push it over.
- **Cloudflare Tunnel** — generous free tier (1000 tunnels per Zero Trust account), but Zero Trust seats are paid above 50 (irrelevant at indie scale, but worth knowing).
- **WAF custom rules** — free tier is 5 custom rules; the 6th forces a Pro upgrade ($25/mo).
- **Logpush** to external storage — paid ($0.05/million logs).

**How to avoid:**
1. **Document the bare-Free-tier config explicitly:** infra/docker-compose.saas.yml and the operator runbook list every Cloudflare feature used and confirms each is on the free tier. If a future feature needs paid Cloudflare, it's a flagged decision.
2. **Disable Workers paid auto-engage** in Cloudflare account settings. Set hard limit. Better to have Workers return 429 than to surprise-bill.
3. **No image transformations.** Indie-game cover art is fetched once from Steam `appdetails`, cached in our Postgres or R2 directly. We don't need Cloudflare Images.
4. **R2 backup retention policy:** keep 7 dailies + 4 weeklies + 6 monthlies = ~17 files at most. With nightly `pg_dump` of an indie-scale DB at <500MB, well inside R2's 10GB free tier.
5. **5 WAF rule budget:** plan WAF rules to fit 5. If we need more, evaluate moving WAF logic into our app's middleware (free) or accept the Pro upgrade as a deliberate cost decision.
6. **Operator dashboard in Cloudflare with billing alert at $1.** Cloudflare supports email alerts on any non-zero billing.

**Warning signs:**
- Email from Cloudflare titled "Your bill is ready" when expecting $0.
- Cloudflare analytics shows a feature using >0 of the paid metric.

**Phase to address:** Tier 0 (Foundation) — when Docker compose + Cloudflare config lands. Tier 5 (Self-host docs item 26) reiterates for self-hosters.

---

### Pitfall 16: VPS RAM blowup when polling worker spikes

**Severity:** HIGH — service unresponsive, OOM kill.

**What goes wrong:**
aeza VPS at indie tier is typically 2-4 GB RAM. The components fighting for it:
- Postgres: ~200 MB baseline + buffers (default `shared_buffers=128MB`, scales with workload).
- Node app: ~150-250 MB resident.
- Node worker: similar baseline but spikes when N concurrent jobs each hold a buffer of an external API response (a YouTube `videos.list` for 50 IDs returns ~50 KB; Reddit comment listings can be MB if naive; Steam wishlist details is small).
- Node scheduler: ~120 MB.
- Loki + Grafana + Prometheus: ~600 MB for the LGTM stack at low scale.
- cloudflared: ~50 MB.
- OS / Docker overhead: ~200 MB.

Total at idle: ~1.5 GB. Headroom for spikes: under 1 GB on a 2 GB VPS. A worker spike from a misbehaving Reddit response (large comment tree) plus a Postgres autovacuum kicking in = OOM kill. Postgres or the worker dies. Polling stops. Users see stale data.

**How to avoid:**
1. **Set Node `--max-old-space-size=512` per container** so the runtime hard-limits heap (instead of growing until OS kills). Worker = 384, app = 512, scheduler = 256.
2. **Postgres `shared_buffers=256MB`, `work_mem=8MB`, `maintenance_work_mem=64MB`** — tuned for 2GB VPS. Document in the Postgres init script.
3. **Limit worker concurrency to fit RAM:** total in-flight HTTP requests = sum of all queue worker counts (4+2+1+2 = 9 concurrent polls). At ~5MB per in-flight request including parsed JSON, peak is ~45MB. Adequate.
4. **Stream large responses, don't buffer:** if Reddit returns a giant comment tree (we shouldn't be requesting it per Pitfall 9, but defense in depth), stream and discard early. Use `fetch().body` reader, not `.json()` directly when sizes are unknown.
5. **Memory-pressure alert:** Prometheus `node_memory_MemAvailable_bytes < 200_000_000` for 2 min → alert. Self-host docs include same alert.
6. **Recommend 4GB VPS, accept 2GB as floor:** PROJECT.md says "small aeza VPS"; STACK.md says "2 GB VPS." Change recommendation: 4GB minimum if running LGTM, 2GB if logs go to stdout only. Make this explicit in self-host docs.

**Warning signs:**
- `dmesg` shows `Out of memory: Killed process` on the VPS.
- Postgres logs `LOG: server process (PID X) was terminated by signal 9: Killed` — Linux OOM-killer hit the postgres process.
- Prometheus `node_memory_MemAvailable_bytes` trending down day-over-day = memory leak somewhere.

**Phase to address:** Tier 0 (Foundation) — Docker compose memory limits and Node max-old-space flags ship on day one. Self-host docs reinforce in Tier 5 (item 26).

---

### Pitfall 17: Postgres bloat from unbounded `metric_snapshots`

**Severity:** HIGH at scale (10s of millions of rows); MEDIUM at indie scale but still real.

**What goes wrong:**
Append-only `metric_snapshots` is the right pattern (ARCHITECTURE.md Pattern 2 — never mutate). But unbounded:
- 100 users × 100 items each × 48 hot polls/day for 24h + 4 warm polls/day for 30d = ~17,300 rows per item over its first 31 days. Then ~365 cold polls/year/item.
- 10,000 items active = ~170M rows per month at hot tier alone.
- Disk fills. Postgres autovacuum can't keep up. Index size dwarfs table. Query latency creeps up.
- Backups (`pg_dump`) take longer and longer; eventually exceed the nightly window.

**How to avoid:**
1. **Partitioning by `polled_at` month** once `metric_snapshots` exceeds ~10M rows (already in ARCHITECTURE.md Scaling Considerations). Postgres native partitioning; pg-boss v10 also partitions, so we already have the operational pattern.
2. **Retention policy** (configurable, defaults below):
   - Keep all snapshots for the last 90 days at full granularity.
   - Beyond 90 days: downsample to one snapshot per day (hot/warm), one per week (cold). This preserves the chart shape (which is what the product is about) at <5% of the storage.
   - Beyond 1 year: optionally archive to JSON blob in R2 / local disk; the in-DB row keeps a daily summary.
3. **Pre-launch:** ship with retention DISABLED but plumbing in place. Decide retention policy after seeing real data shape from beta users.
4. **`REINDEX CONCURRENTLY`** scheduled monthly via a maintenance pg-boss cron job — not a manual operator task.
5. **Per-user storage quota soft-cap** (post-MVP): if a single user has >5M snapshot rows, alert (suggests they added a thousand items or an item is mis-tiered hot forever).
6. **Backup strategy that scales:** `pg_dump` per-table, parallelized. For very large `metric_snapshots`, switch to `pg_basebackup` + WAL-archiving once dump time exceeds 30 min. Document the threshold in self-host docs.

**Warning signs:**
- `pg_relation_size('metric_snapshots') > 10 GB` — alert.
- Postgres `autovacuum`-related warnings in log.
- Nightly `pg_dump` cron starts taking >15 min.
- Chart query (top 90 days for an item) p95 > 500ms.

**Phase to address:** Tier 2 (Polling pipeline) — the partitioning READINESS (table partitioned-by-month from the start, not retrofitted) lands with `metric_snapshots` schema. Retention policy as a feature lands post-MVP (after we see real data shape). Self-host backup docs land in Tier 5 (item 26).

---

### Pitfall 18: Privacy-only-in-MVP creep — accidental public mode

**Severity:** CRITICAL — wishlist data is commercially sensitive (NDAs with publishers, investor optics). One leak page = category-extinction event.

**What goes wrong:**
Pressure builds during early use: "Let me share my wishlist chart on Twitter / show my publisher." Pressure is real. Half-implementation creep:
- Someone adds a `is_public` boolean to `games` and a "share this chart" button. UI feels rough; access control is "if `is_public=true`, anyone with the link sees it." Audit logging of *who* accessed it is missing because privacy-only audit assumed only the owner.
- Image OG meta tags get added for the public share URL, which causes the SSR endpoint to render the chart server-side without auth → if the auth check is ONLY on the JSON API and not the SSR page, the OG bot scraping the page fetches data unauth.
- The "share" link includes `user_id` in the URL → enumeration attack.
- A reverse: someone exports a chart as PNG for sharing externally, but the export endpoint embeds raw `metric_snapshots` JSON in the PNG metadata.

**How to avoid:**
1. **Never ship a partial public mode.** Per FEATURES.md AF-02: "Public dashboards / shareable game pages" is explicitly v2, with the structure "share-link model with explicit per-link scope, expiry, and audit trail." The v1 codebase has NO `is_public` field, no share endpoint, no public route. If a user asks, the answer is "v2."
2. **Tenant-scope middleware refuses anonymous access to every `/api/*`.** No exceptions. Returns 401, not 200 with empty data. (Future v2 share-link auth has to consciously add a separate route prefix `/share/:token/*` that goes through a different middleware.)
3. **No OG image rendering for game pages.** Page metadata for `/games/:id` returns only the app's own OG card, not user-specific data.
4. **PNG export (if added) strips metadata.** Use a library that serializes only pixels; never embed JSON.
5. **Architectural design discipline:** when v2 share-link work begins, it's a new top-level route prefix (`/share/`) with its own middleware, its own DB join (`share_tokens` table), its own audit log. Not a flag on existing endpoints.
6. **Test:** for every API endpoint, integration test asserts an unauthenticated request returns 401. Run on every PR. A new endpoint that doesn't 401 anonymously fails CI.

**Warning signs:**
- Audit log shows `request without session` to `/api/games/:id` returning 200. Should never happen.
- Search for string `is_public` or `is_shared` in the codebase — if it appears in MVP, it's a regression.
- Cloudflare logs show requests to `/games/*` from non-authenticated User-Agents (search bots, social-card scrapers) returning data.

**Phase to address:** Tier 0 (Foundation) — tenant-scope middleware (item 3) enforces from day one. Tier 1 (CRUD) — anonymous-401 integration test lands when first endpoint ships.

---

### Pitfall 19: Audit log read endpoint leaking other users' data

**Severity:** CRITICAL.

**What goes wrong:**
The audit log is per-user (TS-12), but the read endpoint:
- Forgets the `WHERE user_id = ?` filter — every user sees every audit event (Pitfall 1 generalized).
- Pagination cursor is naively the row `id` (bigserial) — user sees their last event's id and queries `?after=N` — gets the next event in time, which belongs to someone else.
- Audit metadata JSON contains the offending user's IP/email if a cross-tenant action accidentally referenced them — even when filtered, the metadata leaks.

**How to avoid:**
1. **Audit log queries always go through `services/audit.ts` which is tenant-scoped.** Same as every other service.
2. **Pagination cursor is tenant-relative:** `WHERE user_id = ? AND id < ?` — `id` alone is not sufficient.
3. **Audit metadata sanitization:** any `metadata.target_user_id` or `metadata.ip_address` of a third party is forbidden in the audit log. The audit writer enforces "metadata only references entities in the same tenant" — if a system action references multiple users (e.g., a admin action), it logs to a separate `system_audit_log` not visible to users.
4. **`audit_log` is APPEND-ONLY:** app role has INSERT but not UPDATE/DELETE on this table. Defense against tampering AND against accidental redaction-via-update being botched. (Already in ARCHITECTURE.md storage notes.)

**Warning signs:**
- A user's audit log page shows an event with `actor=other user_id` they don't recognize.
- A pagination URL with a cursor value larger than the user's own row count.

**Phase to address:** Tier 1 (CRUD) — audit log read endpoint (item 9). The cross-tenant integration test from Pitfall 1 covers this when it includes audit log endpoints in its sweep.

---

### Pitfall 20: Solo operator getting compromised — no recovery path

**Severity:** CRITICAL — operator compromise = SaaS instance compromise.

**What goes wrong:**
The solo operator:
- Loses their laptop with KEK env saved in a `.env` file synced to GitHub Codespaces.
- Has SSH keys to the VPS on a machine that's compromised by an unrelated infostealer.
- Is on vacation when a Cloudflare API token leaks; can't rotate in time.
- Loses 2FA device + Google account access; can't log into their own SaaS as a user.

When YOU are compromised:
- Every user's encrypted secrets are *still safe* (KEK leak alone doesn't decrypt without DB; DB leak alone doesn't decrypt without KEK — that's the envelope-encryption value). BUT if attacker has BOTH (your VPS), they have both.
- Polling stops if attacker takes over and degrades the worker.
- Audit log can be spoofed if attacker has DB write.

**How to avoid (operational moves the roadmap should bake in):**
1. **KEK rotation runbook is a tested artifact**, not an aspirational doc. The roadmap includes a rehearsal: literally run the KEK rotation script in staging with a synthetic dataset, time it, document the steps. Without rehearsal, when a real incident happens, the operator panics and improvises.
2. **VPS access uses ed25519 SSH key + hardware token** (YubiKey or equivalent). Document. The operator's primary defense is their own credential hygiene.
3. **Cloudflare API token scoped to minimum:** `Zone:DNS:Edit` for the app's domain only. Rotate quarterly.
4. **GitHub repo: branch protection on `main`, required PR review** even for solo dev. Forces the "wait, am I sure" pause. Self-merge after delay is fine; instant push to main is not.
5. **Backups encrypted at rest with a SEPARATE key from KEK,** stored offline. (Backup-encryption-key on a hardware key, KEK in env. Compromise of one doesn't compromise both.)
6. **Disaster recovery doc** with concrete steps:
   - Lost VPS access → restore from R2 backup to a new VPS, restore KEK from offline backup, rotate KEK, audit-log "system.recovered."
   - Suspected KEK leak → rotate KEK using the runbook, force all users' OAuth re-link (their refresh tokens may also be compromised), audit-log "system.kek_rotated reason=incident."
   - Suspected DB leak → assume secrets *are* compromised once attacker has both KEK and DB; force-rotate every user's API keys (UI prompt: "Your encrypted keys may have been exposed; please rotate them in YouTube/Reddit/Steam consoles, then re-add here").
7. **Bus-factor doc** committed to the private repo: how to recover the SaaS instance if the operator is unreachable for 30+ days. Even if no one ever runs it, writing it surfaces gaps.
8. **Status page** on a separate provider (statuspage.io free tier or a static page on a different domain) — when the SaaS is down, users have somewhere to look. Avoids "is it dead?" panic.
9. **GDPR-style data deletion runbook:** user requests deletion → a script that hard-deletes their `users` row + cascades, including secrets, audit log, snapshots. Tested. Documented timeframe (30 days max per most regs, 7 days target).
10. **Abuse handling runbook:** if a user uses our SaaS to harass / spam Reddit (we can't fully prevent it but can detect via audit log patterns), operator can suspend the user account: a `users.suspended_at` timestamp, all API endpoints check it, polling stops, audit-logged.

**Warning signs:**
- No rehearsal of KEK rotation has happened in 6 months.
- No backup restore test in 6 months.
- No certificate renewal alerts (Cloudflare handles this automatically; self-hosters with Caddy also automatic; bare nginx/manual certbot needs alert + auto-renew test).

**Phase to address:** Tier 5 (Trust + parity polish) — self-host docs / KEK rotation runbook (item 26). The rehearsal is part of milestone exit criteria, not "we'll do it later." Disaster recovery doc lives in `docs/operations.md` and ships with item 26.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Single `poll` queue with priorities (Pitfall 4) | -1 hour of setup; one less concept | Head-of-line blocking at scale; per-tier metrics impossible | Never — separation of queues is the design |
| Cache decrypted secrets in-process (Pitfall AP-3 in ARCHITECTURE.md) | Saves microseconds per poll job | In-process plaintext stash; heap-dump leak risk; secret-rotation invalidation logic to maintain | Never |
| `SELECT *` from `secrets` and let frontend filter (Pitfall 3) | Drizzle query is shorter | Ciphertext on wire; relies on frontend trust | Never — server must project |
| Mutate `tracked_items` with latest metric instead of snapshot table | -1 table; -1 query for the chart | Loses the time series — kills D-03 — kills the product | Never |
| Synchronous external API call inside a DB transaction (Pitfall 5) | Looks atomic; "easier" | Connection pool drain; cascading failure | Never |
| Skip the cross-tenant integration test in CI ("it's covered by code review") | -2 min per CI run | Single missed `WHERE user_id` = breach | Never — this test is non-negotiable |
| Hardcode admin emails for support backdoor (Pitfall 13) | -10 min auth-flow work for ops | Unbounded surface; self-host parity broken | Never |
| Skip envelope encryption for "low-value" keys ("YouTube key is just read-only") | Saves 30 min of crypto work | Inconsistent treatment; one leaked DB exposes all keys | Never — all secrets through the envelope module |
| Keep KEK as base64 string in `process.env` for the lifetime of the process | Convenient | Process dump leaks; Pitfall 2 risk | Acceptable for v1 IF Pitfall 2 mitigations are all in place; tighten in v1.1 (delete from env after `Buffer.from` consumes it) |
| "We'll add the audit log later" | Skip 4-6 hours | Retrofitting `audit_log()` calls into every service requires touching every service | Never — audit log lands in Tier 1 with the first endpoints |
| Lazy-load Cloudflare Tunnel in self-host (just expose port 80) | -10 min compose work | Self-hosters expose origin to internet; trusted-proxy assumptions break | OK if self-host doc is explicit about user choosing nginx/Caddy/Cloudflare; default compose ships Caddy |
| Skip self-host smoke test ("I'll just run it manually before each release") | -15 min CI setup | Self-host parity rot creeps in over months | Never — smoke test in CI from day one |
| Use `snoowrap` to "save 150 LOC" | -150 LOC of fetch wrapping | Archived dep + unmaintained transitive `request` dep + audit liability | Never — stack research has already eliminated it |
| Delay D-09 quota dashboard ("users will figure it out") | -2 days of work | When YouTube quota burns at 14:00 UTC, user has no visibility, files support ticket, distrusts the product | Acceptable to ship MVP without D-09 if the tier-aware throttle from Pitfall 8 is in place; D-09 lands in Tier 5 |
| Run `app`, `worker`, `scheduler` as one process (`WORKERS_INLINE=true`) on SaaS | -1 container | Worker job kills the web tier on OOM; deploy drops in-flight polls | NEVER on SaaS; OK on self-host as documented opt-in |
| Vendor a copy of someone else's curated subreddit rules JSON (Pitfall D-04) | -content effort | Stale data → wrong-light verdict → Pitfall 10 user shadowban → reputation hit | Use as a starting point, but commit to a `last_verified` column with quarterly community PR review cycle |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| YouTube Data API | Calling `videos.list` once per video ID (1 unit each) | Batch up to 50 IDs per call (still 1 unit total) — 50× quota efficiency. Pitfall 8 |
| YouTube Data API | Using `search.list` "to find recent videos" | Forbidden — 100 units. AF-04 anti-feature. Lint check. |
| YouTube Data API | Treating `403 forbidden` and `403 quotaExceeded` the same | Parse `error.errors[0].reason`. Different `last_poll_status` values. Different UX. |
| YouTube Data API | Per-user keys but assuming quota is per-key when it's actually per-Google-Cloud-project | A user with two Google accounts using the same Cloud project shares the quota. Document. |
| Reddit API | Using `snoowrap` | Archived. Native fetch ~150 LoC. STACK.md is firm. |
| Reddit API | Generic `User-Agent: axios/1.0` or missing | Reddit specifically bans this. Format must include `<platform>:<id>:<version> (by /u/<username>)`. Pitfall 11 |
| Reddit API | Walking comment trees to count comments | Use listing endpoint with `limit=1`, read `num_comments` from the post object. Pitfall 9 |
| Reddit API | Continuing to poll deleted/removed posts (404 / `[removed]`) | Freeze the item (5th tier). Repeated 404s look bot-like. Pitfall 11 |
| Reddit API | Ignoring `X-Ratelimit-Remaining` | Pause user's Reddit polls when remaining < 10. Pitfall 9 |
| Reddit API | Requesting elevated OAuth scopes "just in case" | Read-only scopes only (`read`, `wikiread`). Pitfall 11 |
| Reddit `/about/rules` | Assuming structured fields (cooldown_days, allowed_flairs) come back from the API | They do NOT. API returns short_name + description. Structured fields are D-04 curated seed. |
| Steam Web API | Using a Steamworks login password where the Web API key goes | Per-key format validation (32 hex chars). Per-kind form route. Pitfall 12 |
| Steam Web API | Polling more often than once a day for wishlists | Steam wishlist data updates daily at best (AF-10 anti-feature). Daily granularity is honest. |
| Steam Web API | Storing the publisher key in the wrong tenant by accident | Per-kind route + zod regex on submit. Pitfall 12 |
| Steam appdetails (cover image) | Caching the response forever | Cache 30 days. Cover art changes when devs update store pages. |
| Google OAuth | Storing access tokens long-term | Better Auth handles refresh; we never store raw access tokens beyond the session. |
| Cloudflare | Using `cf-connecting-ip` without trusted-proxy allowlist | Pitfall AP-5 in ARCHITECTURE. Allowlist Cloudflare IP ranges; document for self-host. |
| Cloudflare Tunnel | Routing through tunnel + also exposing port 80 directly | Document: pick ONE. Direct exposure makes WAF/DDoS protection moot. |
| Postgres (pg-boss) | Mixing pg-boss connections and app connections in one pool | Two pools: app uses Drizzle's pool; pg-boss owns its own (configurable max). Document max-connection budget. |
| Postgres | `LISTEN/NOTIFY` for queue notifications + idle connections | pg-boss handles this; don't add your own LISTEN. |
| Postgres | Migrations run from app's HTTP entrypoint (race condition under N replicas) | Migrations run as a separate boot step, with advisory lock; only one container actually runs them. Drizzle-kit pattern. |
| Better Auth | Setting `Cookie Domain` in self-host (Pitfall 13) | Omit `Domain` in self-host so cookie binds to host. SaaS sets it explicitly via env. |
| Better Auth | Storing JWT in localStorage | Better Auth defaults to HTTP-only session cookies. Don't override. |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Single queue with priorities (Pitfall 4) | hot poll p95 climbs as cold backlog grows | Four-queue split | At ~1k cold backlog items |
| External call inside DB transaction (Pitfall 5) | `idle in transaction` connections, p95 API latency spikes | Two-phase: read row → call API → write tx | At ~5 concurrent slow API calls |
| `metric_snapshots` unbounded (Pitfall 17) | Chart query p95 > 500ms; pg_dump > 30 min | Monthly partition + retention policy | At ~10M rows |
| YouTube `videos.list` one-at-a-time (Pitfall 8) | User's quota burns by midday | Batch 50 IDs per call | At ~100 hot YouTube items per user |
| Reddit comment-tree walking (Pitfall 9) | Reddit poll job duration p95 > 10s; 429 storms | Listing endpoint with `limit=1` | At ~5 hot Reddit items per user |
| All polls fire at minute=00 (clock alignment) | Bursts of 100s of HTTP calls every 30 min, then idle | Jittered enqueue (1-30s spread) | At ~50 users with hot items |
| Loki indexing every log line at full granularity | LGTM RAM growth; OOM on 2GB VPS | Log retention policy (7 days warm, archive older); drop debug logs at info threshold | At ~10 days of operation |
| In-process secret cache (Pitfall AP-3) | Memory growth in worker; secret-rotation lag | Decrypt per job; no cache | Never optimize this; the "improvement" is the wrong shape |
| pg-boss `archive_completed` table growth | Postgres bloat; vacuum lag | pg-boss v10 partitions automatically; verify in self-host docs | At ~1M completed jobs |
| Audit log full-table scan on user's audit page | Audit page p95 > 1s | `(user_id, occurred_at desc)` composite index | At ~10k events per user |
| Connection-pool exhaustion | All HTTP requests time out | App pool max + worker pool max + pg-boss max ≤ Postgres max_connections - 5 (reserve) | At deploy with extra workers |
| Egress costs for backup-to-R2 | Cloudflare R2 egress charges | Use R2's free egress to Cloudflare-IPs path; or local-disk + rsync to a second VPS | At ~50GB+ backup retention |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Forgetting `WHERE user_id = ?` (Pitfall 1) | Cross-tenant data read | Tenant-scope middleware + lint rule + cross-tenant CI test |
| Returning ciphertext or plaintext via API (Pitfall 3) | Encrypted-data exposure | DTO discipline + zod response schema + no `SELECT *` on secrets |
| KEK in env-dump endpoint (Pitfall 2) | Total decrypt of all stored secrets | Pino redact + ban `process.env` in HTTP layer + `app` doesn't load KEK |
| Long-lived KEK Buffer in `app` heap (ARCH AP-6) | Heap dump → KEK leak | `app` loads KEK only on secret-write path; worker loads per job |
| Wrong-field key paste (Pitfall 12) | Wrong key encrypted under wrong kind; user confusion | Per-kind form + format regex + validate-on-submit |
| Audit log spoofable IP (ARCH AP-5) | Forensics meaningless | Trusted-proxy allowlist + `CF-Connecting-IP` first |
| Audit log mutable | Tampering | App role has INSERT only; SaaS revokes UPDATE/DELETE on `audit_log` |
| Missing 401 on unauthenticated `/api/*` (Pitfall 18) | Public data leak | Tenant-scope middleware refuses anonymous; integration test asserts 401 |
| OAuth scopes too broad (Reddit) | Reddit account compromise on token leak | Read-only scopes only |
| Storing Google access tokens at rest | Account takeover on leak | Session cookies only; refresh via Better Auth on demand |
| `is_public` flag added in MVP (Pitfall 18) | Privacy promise broken | Architectural rule: no `is_public` until v2 share-link route prefix |
| Telemetry beacon without consent (Pitfall 13) | Self-hoster ping leaks usage | No telemetry by default; opt-in env var; library doesn't init if disabled |
| Cross-tenant audit log leak (Pitfall 19) | One user sees another's events | Tenant-scoped pagination cursor; metadata sanitization |
| Reddit shadowban via UI nudge (Pitfall 10) | User account destroyed | Default-yellow + audit log every override + in-app shadowban-mechanics docs |
| Reddit OAuth app banned (Pitfall 11) | Polling broken for everyone (SaaS) | Strict User-Agent + 429 honor + freeze on 404 |
| AGPL contamination (Pitfall 14) | License integrity broken | Run AGPL components as separate services only; no embedding; no vendoring |
| Operator compromise + no recovery (Pitfall 20) | Total loss of SaaS instance | Tested KEK rotation runbook + offline backup encryption key + DR doc |
| Backup not encrypted | DB dump in R2 contains raw user data | Encrypt backups with separate key (not KEK); document in operator runbook |
| Cookie set without `Secure` in production | Session theft over HTTP | Better Auth defaults; assert in integration test that cookies have `Secure` flag |
| Plaintext secret in Pino log via `JSON.stringify(err)` | Secret leak via logs (Pitfall 2) | Use Pino's error serializer; ban `JSON.stringify(err)` |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Silent polling failure (item stops updating; UI doesn't say) | User trusts stale data → bad decisions | D-12 "What's stale" inbox + per-item `last_poll_status` badge |
| Pre-post warning UI defaults to GREEN (Pitfall 10) | False confidence → user gets shadowbanned | Default to yellow when ANY rule data is missing; require explicit pass for green |
| "Show full key" button on saved API keys (Pitfall 3) | User shoulder-surfed; key leaked via screenshot | Write-once UI, last4 only, never decrypt to UI per PROJECT.md |
| Per-key error messages too vague ("Failed to fetch") | User can't diagnose; emails support | Distinguish: `quota_exhausted`, `auth_error`, `not_found`, `rate_limited`, `network_error` — each with a one-line user-facing fix hint |
| YouTube quota dashboard shows "% used" without WHAT used it | User can't reduce | Show top items by call count today; allow "demote to warm" per item |
| Adding a Reddit URL but the subreddit isn't in the curated rules DB | Pre-post warning shows nothing or generic | Show explicit "We don't have curated rules for r/X yet — here's the raw rules text Reddit returned, please configure structured fields" + nudge to PR D-04 |
| Wishlist line shows "1,247" without "last updated" | User assumes real-time, makes wrong inferences | Always show "last updated Xh ago" next to wishlist counter |
| Hot/warm/cold polling badge without explanation | "Why is my video cold?" | Tooltip: "Cold = polled daily because >30 days old. Click to pin hot for 7 more days." (D-06) |
| Deleting a game silently deletes all associated snapshots | User loses history they wanted to keep | Soft-delete with 30-day undo; export-on-delete prompt |
| Audit log timestamps in UTC | User confused about "did this happen at 2am or 7pm?" | Show in user's locale; UTC available on hover |
| One global "API key" page where all kinds mix | Wrong-field paste (Pitfall 12) | Per-kind route + per-kind copy explaining what the key gives access to |
| Empty states with no examples (TS-15 unfilled) | First-time user abandons | Concrete copy-pasteable examples per platform |
| Light-mode default with chart colors that fail in dark mode | Half the audience hits unreadable charts | TS-13 dark mode + verified chart palette per mode |
| Mobile chart unreadable on a 320px screen (TS-14 unfilled) | Indie devs check from phone after posting | Responsive chart with horizontal scroll; mobile-specific axis labels |
| English-only error messages with internal codes (`ERR_KMS_DECRYPT_FAIL`) | Indie devs in non-English markets confused | Plain-English messages; internal codes in audit log only |

## "Looks Done But Isn't" Checklist

Things that appear complete in dev but break in production. The CI / pre-release checklist:

- [ ] **Tenant scoping:** Every `/api/*` endpoint integration-tested for cross-tenant isolation. New endpoints fail CI without the test. (Pitfall 1)
- [ ] **Anonymous request:** Every `/api/*` returns 401 to unauthenticated request. CI test. (Pitfall 18)
- [ ] **Pino redaction:** Test that injects an "APP_KEK_BASE64=AAAA..." into a log line and asserts it's redacted. (Pitfall 2)
- [ ] **Secrets API response:** zod-validated response schema exists per endpoint and excludes ciphertext fields. (Pitfall 3)
- [ ] **Worker graceful shutdown:** SIGTERM handler test — start a worker, send SIGTERM, assert in-flight job completes within `stop_grace_period`. (Pitfall 6)
- [ ] **No external HTTP inside DB transaction:** Static check / code review checklist. (Pitfall 5)
- [ ] **YouTube `videos.list` batched:** Adapter test — submit 200 items, assert ≤4 API calls (50 IDs each). (Pitfall 8)
- [ ] **Reddit listing endpoint with `limit=1`:** Adapter test — assert no comment-tree iteration. (Pitfall 9)
- [ ] **Reddit User-Agent:** Adapter test — assert User-Agent matches `<platform>:<id>:<version> (by /u/<username>)` regex. (Pitfall 11)
- [ ] **Pre-post warning default behavior:** UI test — when curated rule data is missing for a subreddit, default verdict is YELLOW with explanatory message, never GREEN. (Pitfall 10)
- [ ] **Self-host smoke test in CI:** `docker compose -f infra/docker-compose.selfhost.yml up -d` runs end-to-end on every PR. (Pitfall 13)
- [ ] **License audit:** `npm ls --prod` produces no AGPL-3.0 dependencies. CI fails on AGPL detection. (Pitfall 14)
- [ ] **Cloudflare bare-Free config:** Operator runbook explicitly lists every CF feature used and confirms each is on free tier. (Pitfall 15)
- [ ] **Memory limits set:** Docker compose memory limits per service; Node max-old-space flags. (Pitfall 16)
- [ ] **`metric_snapshots` partitioned by `polled_at` month from day one** even if retention is disabled. (Pitfall 17)
- [ ] **No `is_public` field anywhere in the schema or codebase.** Grep check in CI. (Pitfall 18)
- [ ] **Audit log INSERT-only:** Test that asserts a UPDATE/DELETE attempt on `audit_log` raises an error in app code. (Pitfall 19)
- [ ] **KEK rotation runbook rehearsed** in staging with synthetic data; result documented with timing. (Pitfall 20)
- [ ] **Backup restore tested** at least once before launch and once per 6 months. (Pitfall 20)
- [ ] **Per-kind secret form routes** exist (`/settings/keys/{steam,youtube,reddit}`) with kind-specific copy. (Pitfall 12)
- [ ] **Format-validate-on-submit** for each key kind (zod regex). (Pitfall 12)
- [ ] **Validate-on-submit test API call** — secret-write triggers a known-good probe call before persisting. (Pitfall 12)
- [ ] **Trusted-proxy allowlist documented per deploy mode** (SaaS: Cloudflare ranges; self-host: localhost; docs explain extending). (ARCH Pattern 5)
- [ ] **D-04 curated rules `last_verified` field populated** for every shipped subreddit. UI shows stale-rules warning > 90 days. (Pitfall 10)
- [ ] **Hot/warm/cold cadence rule lives in ONE file** (`scheduler/tier-resolver.ts`). Grep CI rule: no `ageDays < 1` literals elsewhere. (Pitfall 7)
- [ ] **`process.env.APP_KEK_BASE64` deleted after Buffer conversion** at boot. (Pitfall 2)
- [ ] **No telemetry library imported by default in self-host build.** (Pitfall 13)
- [ ] **`THIRD_PARTY_LICENSES.md` regenerated and committed on every release.** (Pitfall 14)
- [ ] **Status page on a separate domain/provider.** (Pitfall 20)
- [ ] **GDPR data deletion script tested.** (Pitfall 20)

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Cross-tenant data leak (Pitfall 1) | HIGH (legal disclosure) | 1. Identify scope via audit log query 2. Notify affected users within 72h 3. Patch + force-rotate sessions 4. Post-mortem 5. Add regression test |
| KEK leak (Pitfall 2) | HIGH | 1. Generate new KEK 2. Run rotation script 3. Force re-link of all OAuth providers (refresh tokens may be paired with the leak) 4. Audit log `kek.rotated reason=incident` 5. Notify users to rotate their YouTube/Reddit/Steam keys (assume compromise) |
| Ciphertext leaked via API (Pitfall 3) | MEDIUM-HIGH | 1. Patch the endpoint 2. If logs show actual access by unauthorized parties, treat as KEK-leak severity 3. Otherwise, force-rotate any users whose ciphertext was exposed 4. Disclose if disclosure thresholds met |
| Queue starvation incident (Pitfall 4) | LOW | 1. Drain cold queue temporarily (pause cold workers) 2. Hot polls catch up 3. Post-mortem if user-visible 4. If single-queue model still in place, refactor to four-queue (this is the root cause) |
| Lost jobs at SIGTERM (Pitfall 6) | LOW | pg-boss retries automatically; recovery is "wait for retry to fire." If `stop_grace_period` was too short, increase. |
| Tier rules drift (Pitfall 7) | MEDIUM | 1. Identify divergent code paths 2. Move all to `tier-resolver.ts` 3. Backfill missed polls if quota allows 4. Add property test |
| YouTube quota burn (Pitfall 8) | LOW (waits until UTC midnight) | 1. Tier-downgrade affected users to warm for the day 2. Surface in D-09 dashboard 3. Email user with explanation if recurring |
| Reddit OAuth app banned (Pitfall 11) | HIGH | 1. Stop polling immediately (mark all Reddit items `last_poll_status=auth_error`) 2. Appeal to Reddit (slow) 3. Communicate to users via status page 4. As a fallback: switch SaaS to BYO-Reddit-app model (each user creates their own); already the structure for self-host |
| Wrong-field key paste (Pitfall 12) | LOW | Validate-on-submit catches it; user gets immediate friendly error; never reaches DB |
| Self-host parity broken (Pitfall 13) | MEDIUM | 1. Self-host smoke test catches; revert PR 2. If shipped: hotfix release within 24h 3. Apologize in changelog |
| AGPL contamination (Pitfall 14) | HIGH (license + repo cleanup) | 1. Identify infringing dep / pattern 2. Replace or remove 3. Re-audit 4. Re-tag releases as needed |
| Cloudflare surprise bill (Pitfall 15) | LOW (financial) | 1. Disable the offending feature 2. Set hard limits 3. Cloudflare usually refunds first-time accidents on appeal |
| VPS RAM blowup → OOM kill (Pitfall 16) | LOW-MEDIUM | 1. Restart killed container (Docker `restart: unless-stopped`) 2. Prometheus alert next time 3. Tune memory limits or upgrade VPS |
| `metric_snapshots` bloat (Pitfall 17) | MEDIUM | 1. Enable retention policy 2. Run downsample script for old rows 3. Vacuum + reindex 4. Schedule monthly maintenance |
| Public-mode creep (Pitfall 18) | CRITICAL if shipped | 1. Revoke all public links immediately 2. Audit log who-viewed-what 3. Disclosure if needed 4. Roll back the feature |
| Audit log cross-tenant leak (Pitfall 19) | HIGH | Same as Pitfall 1 |
| Operator compromise (Pitfall 20) | CRITICAL | Follow DR runbook: rotate KEK + force user re-link + restore from offline backup if needed + status page + post-mortem to users |

## Pitfall-to-Phase Mapping

| Pitfall | Severity | Prevention Phase | Verification |
|---------|----------|------------------|--------------|
| 1. Forgetting `WHERE user_id` | CRITICAL | Tier 0 (item 3) | Cross-tenant integration test in CI |
| 2. KEK leaking via env-dump / log | CRITICAL | Tier 0 (item 5) | Pino redaction test + lint ban on `process.env` in HTTP |
| 3. Ciphertext/plaintext via API | CRITICAL | Tier 1 (item 8) | zod response schema + export shape snapshot test |
| 4. Queue starvation | HIGH | Tier 2 (items 10-12) | Per-tier queue depth Prometheus metrics |
| 5. External call inside transaction | HIGH | Tier 2 (item 12) | Worker code review + `idle in tx` Postgres alert |
| 6. SIGTERM dropped jobs | HIGH | Tier 2 (item 12) | Graceful shutdown test |
| 7. Tier rules drift | HIGH | Tier 2 (item 11) | Property test on resolver + grep for ageDays literals |
| 8. YouTube quota burn | HIGH | Tier 2 (item 12); D-09 in Tier 5 (item 24) | Adapter batching test + per-user quota counter |
| 9. Reddit 429 storm | HIGH | Tier 2 (item 12) | `X-Ratelimit-Remaining` honored in code review |
| 10. Encouraging shadowbans (UI) | CRITICAL (for user) | Tier 4 (items 21-22) | Default-yellow UI test + audit log of overrides |
| 11. Reddit banning our OAuth app | HIGH | Tier 2 (item 12) | User-Agent regex enforced; freeze on 404 |
| 12. Steam key wrong-field paste | HIGH | Tier 1 (item 8) | Per-kind form + zod regex + validate-on-submit |
| 13. Self-host parity rot | HIGH | Tier 0 (item 1) | CI self-host smoke test on every PR |
| 14. AGPL contamination | HIGH | Tier 5 (item 27) | License audit in CI |
| 15. Cloudflare surprise bill | HIGH | Tier 0 (item 1) | Operator runbook + billing alert |
| 16. VPS RAM blowup | HIGH | Tier 0 (item 1) | Docker memory limits + Prometheus alert |
| 17. `metric_snapshots` bloat | HIGH (at scale) | Tier 2 (item 12) — schema; Tier 5 — retention | Monthly partition from day 1; retention policy post-MVP |
| 18. Privacy creep | CRITICAL | Tier 0 (item 3); reinforced Tier 1 | No `is_public` grep test + 401-on-anon test |
| 19. Audit log cross-tenant leak | CRITICAL | Tier 1 (item 9) | Cross-tenant test extends to audit endpoints |
| 20. Operator compromise | CRITICAL | Tier 5 (item 26) | KEK rotation rehearsal + DR doc + backup restore test |

## Sources

- PROJECT.md (locked constraints, especially constraints + key decisions sections) — HIGH
- STACK.md (envelope encryption discipline, snoowrap rejection, AGPL flag, Cloudflare Free) — HIGH
- ARCHITECTURE.md (tenant scoping pattern, four-queue split, KEK lifecycle, anti-patterns AP-1 through AP-6) — HIGH
- FEATURES.md (anti-features AF-01 through AF-15, especially AF-02 privacy / AF-04 discovery / AF-10 realtime) — HIGH
- [pg-boss v10 docs — graceful stop, dead-letter, partitions](https://github.com/timgit/pg-boss) — HIGH
- [YouTube Data API v3 quota cost calculator](https://developers.google.com/youtube/v3/determine_quota_cost) — HIGH (10k units/day per project; videos.list=1; search.list=100)
- [Reddit API rate limits + listing endpoint](https://www.reddit.com/dev/api) and [Postiz article on Reddit API limits](https://postiz.com/blog/reddit-api-limits-rules-and-posting-restrictions-explained) — MEDIUM-HIGH
- [Reddit Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy) — HIGH (basis for User-Agent + read-only scope discipline)
- [Reddit User-Agent format requirement](https://github.com/reddit-archive/reddit/wiki/API) — HIGH
- [Steamworks IWishlistService](https://partner.steamgames.com/doc/webapi_overview) — HIGH (read-only scope of Web API key, instant rotation)
- [snoowrap archived notice](https://github.com/not-an-aardvark/snoowrap) — HIGH (do-not-use)
- [Cloudflare Workers paid plan triggers](https://developers.cloudflare.com/workers/platform/pricing/) — HIGH
- [Cloudflare Free WAF rule limit](https://developers.cloudflare.com/waf/) — HIGH (5 custom rules)
- [Cloudflare R2 free tier](https://developers.cloudflare.com/r2/pricing/) — HIGH (10GB free; egress to CF free)
- [Postgres `SELECT ... FOR UPDATE SKIP LOCKED`](https://www.postgresql.org/docs/16/sql-select.html) — HIGH
- [Postgres partitioning](https://www.postgresql.org/docs/16/ddl-partitioning.html) — HIGH
- [NIST SP 800-57 (envelope encryption rotation)](https://csrc.nist.gov/publications/detail/sp/800-57-part-1/rev-5/final) — HIGH
- [AGPL-3.0 text](https://www.gnu.org/licenses/agpl-3.0.html) and [Grafana Labs licensing FAQ](https://grafana.com/licensing/) — HIGH (separate-service exemption interpretation)
- [Better Auth cookie + session config](https://better-auth.com/docs) — HIGH
- [Pino redaction docs](https://github.com/pinojs/pino/blob/main/docs/redaction.md) — HIGH
- Indie marketing community wisdom on Reddit shadowban triggers (cooldown, karma, account age, self-promo ratio, cross-posting timing) — MEDIUM, sourced from [How To Market A Game blog](https://howtomarketagame.com/) + [IMPRESS blog](https://impress.games/blog/how-to-promote-your-indie-game-on-reddit) + [Game Developer "Don't Get Downvoted"](https://www.gamedeveloper.com/business/don-t-get-downvoted-some-tips-for-promoting-your-indie-game-on-reddit) — Reddit doesn't publish thresholds; community-curated wisdom

---
*Pitfalls research for: multi-tenant indie SaaS with adaptive pollers, encrypted secrets, parallel open-source self-host, solo operator*
*Researched: 2026-04-27*
