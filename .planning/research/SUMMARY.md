# Project Research Summary

**Project:** Neotolis Game Promotion Diary
**Domain:** Multi-tenant indie game promotion-tracking SaaS with open-source self-host parity
**Researched:** 2026-04-27
**Confidence:** HIGH overall (stack and architecture fully verified; features MEDIUM-HIGH; Reddit API internals MEDIUM)

## Executive Summary

This is a solo-operated, indie-budget SaaS tool that replaces a game developer promotion spreadsheet with a structured, time-series diary. Users paste URLs (Reddit posts, YouTube videos), the service auto-fetches metrics over time, and visualises them against a Steam wishlist line, answering the question which post actually moved the needle. The canonical instance runs on a single aeza VPS behind Cloudflare Free tier. The identical codebase ships MIT-licensed for self-hosters. Every stack and infra decision must work inside that envelope: no Redis, no paid SaaS, no managed queues, no second stateful service.

The recommended approach is TypeScript end-to-end on Node.js 22 LTS: Hono backend, SvelteKit frontend, Drizzle ORM, Postgres 16 as the single stateful service, pg-boss for the job queue (Postgres-native, no Redis), Better Auth for Google OAuth, and node:crypto AES-256-GCM for envelope encryption of per-user API keys. This stack runs in three Docker containers from one image (APP_ROLE=app|worker|scheduler), is entirely MIT/Apache-2.0 licensed, and fits comfortably on a 2 GB VPS with the LGTM observability stack as an optional layer.

The two headline differentiators are the Reddit Rules Cockpit (D-01/D-02: hybrid API-pulled plus curated structured rules per subreddit, pre-post traffic-light warning) and the Annotated Wishlist Correlation Chart (D-03: daily wishlist adds line with every promotion event as a vertical marker, click-to-drill). No competitor occupies this combination. Critical risks: multi-tenant data-leak from a missing WHERE user_id filter (CRITICAL, must be solved at foundation), KEK leaking into logs or env-dump endpoints (CRITICAL, Tier 0), queue starvation from a single priority queue (HIGH, Tier 2), solo-operator compromise with no recovery runbook (CRITICAL, Tier 5). All solvable by following the patterns in ARCHITECTURE.md and PITFALLS.md.

---

## Key Findings

### Recommended Stack

A single Postgres instance is sufficient for everything: relational data, job queue (pg-boss v10 uses Postgres SKIP LOCKED and partitioned tables), and encrypted secret storage. There is no reason to introduce Redis. The same Docker image runs in all three roles. All variation between SaaS and self-host is env-var and compose-file shape, zero code branches except two single-read boot flags (APP_MODE, WORKERS_INLINE).

**Core technologies:**

- Node.js 22 LTS: runtime; LTS until April 2027; native fetch, WebCrypto, stable ESM
- TypeScript 5.6+: strict mode catches the missing userId filter mistakes that destroy multi-tenant SaaS
- Hono 4.12.x: HTTP framework; ~14 KB, web-standards, X-Forwarded-* proxy helper; lighter than NestJS/Fastify
- SvelteKit 2 / Svelte 5: frontend; 20-40% smaller bundles than Next.js; SSR + form actions fit the CRUD-heavy diary UI
- Drizzle ORM 0.45.x: schema-as-code, readable SQL migrations, no Rust engine binary; pin 0.45 (1.0-beta still beta)
- pg / PostgreSQL 16: SKIP LOCKED, pgcrypto, JSONB, partitioned tables; single backup target
- pg-boss 10.x: Postgres-native job queue; cron, DLQ, singletonKey deduplication; v10 requires explicit queue creation at boot
- Better Auth 1.6.x: Google OAuth, Drizzle adapter, HTTP-only session cookies; Lucia deprecated March 2025
- node:crypto built-in: AES-256-GCM envelope encryption; zero external deps; ~60-line implementation
- Pino 9.x: structured logging; redaction config MUST be set before first commit
- Zod 3.23+: runtime validation for all inbound bodies, env config, and external API responses
- LayerChart 2.x (Svelte 5 beta): charting; fallback is Apache ECharts via svelte-echarts

**Critical avoids:** snoowrap (archived March 2024, write native fetch wrapper instead); BullMQ/Bull (requires Redis); Lucia Auth (deprecated March 2025); managed SaaS deps in critical path; redis anywhere.

### Expected Features

**Must have for v1 (beats the spreadsheet):**

- TS-01 Game cards: foundation; all other features attach here
- TS-02 Paste-URL ingest (Reddit + YouTube): core mental model
- TS-03 Per-item metric history with line chart: otherwise just a bookmark manager
- TS-04 Wishlist line over time: Steam Web API key path AND CSV import path (both required)
- TS-05 Combined per-game timeline (events + items + wishlist): the actual product
- TS-06 Own vs. blogger distinction on YouTube: signal hygiene, cheap
- TS-07 Per-item detail view: drill-down from the timeline
- TS-08 Free-form events timeline (conferences, Twitter posts, TG, Discord)
- TS-09 Google OAuth login: only auth method in MVP
- TS-10 Encrypted API key storage, write-once UI (last 4 chars only)
- TS-11 CSV/JSON export: anti-lock-in trust, non-negotiable on day one
- TS-12 Owner-visible audit log
- TS-13/14/15 Dark mode, responsive, empty states with copy-paste examples
- **D-01 Subreddit Rules Cockpit**: the competitive moat; ships in MVP even though it is the hardest feature
- **D-03 Annotated wishlist correlation chart**: the headline screenshot of the product
- D-04 Curated subreddit rule seed database for top ~10 indie subs (makes D-01 useful from day one)
- D-05 Multiple channels per game: cheap, locked in PROJECT.md
- D-06 Hot/warm/cold polling badges: trust signal
- D-08 Self-host parity (Docker compose, MIT): distinguishes from every closed-SaaS competitor
- D-09 Per-key quota dashboard: surfaces YouTube/Reddit headroom; quota anxiety is real

**Add after first validation (v1.x, 3-6 months post-launch):** D-02 pre-post Reddit warning UI, D-07 first-class blogger coverage entity, D-10 promotion-intensity heatmap, D-11 campaign tag grouping, D-12 stale items inbox.

**Defer to v2+:** Public share-link reports (AF-02), auto-discovery of mentions (AF-04), Twitter/X API tracking (AF-05 costs 100 USD/mo), Telegram channel auto-tracking (AF-06), multi-language UI, native mobile app (AF-12).

**Anti-features to defend against scope creep:** auto-posting (AF-01), public dashboards (AF-02), Steam scraping (AF-03), real-time wishlist counter (AF-10, Steam updates daily at best), built-in AI suggestions (AF-11).

### Architecture Approach

Three Docker containers from one image (app, worker, scheduler) backed by a single Postgres 16 instance. The scheduler reads tracked_items, classifies items into hot/warm/cold tiers via a single tier-resolver.ts function, and enqueues jobs into four named pg-boss queues. Workers dequeue, decrypt secrets, call external APIs, and write append-only snapshots. Self-host collapses to one or three containers via env vars with zero code change.

**Major components:**

1. app (APP_ROLE=app): HTTP API, SSR UI, Better Auth, tenant-scope middleware, proxy-trust middleware, secret write path; stateless
2. scheduler (APP_ROLE=scheduler): cron tick every 5 min; reads tracked_items; runs tier-resolver.ts; sends jobs to pg-boss; never writes business tables directly
3. worker (APP_ROLE=worker): dequeues from 4 named queues; envelope.decrypt; calls integration adapters; writes metric_snapshots in a short transaction
4. Postgres 16: single source of truth for all durable state
5. crypto/envelope.ts: AES-256-GCM KEK/DEK; the only place secrets are ever decrypted; pure function; used by app (write path) and worker (read path)
6. Integration adapters (youtube.ts, reddit.ts, steam.ts): pure functions with uniform poll(item, creds): Snapshot signature; no DB writes; new platform = new file, no other changes
7. Edge (Cloudflare Free + Tunnel for SaaS / Caddy for self-host): TLS, WAF, DDoS; trusted-proxy header allowlist enforced in middleware/proxy-trust.ts

**Key patterns (full TypeScript examples in ARCHITECTURE.md):**

- Tenant-scoping by convention + types: every service function takes userId: string as first non-optional arg; every Drizzle query includes eq(table.userId, userId)
- Snapshot-and-forward: metric_snapshots is append-only; never mutate a tracked item metric value; D-03 depends on this history being intact
- Four named queues, not one queue with priorities: prevents cold-backlog starvation of hot polls
- No DB transaction held open across an external HTTP call: read item outside tx, decrypt creds, HTTPS call, then open short write tx

### Critical Pitfalls

The 20 pitfalls in PITFALLS.md cluster into three zones. Treat as hard constraints on phase content.

**Tier 0 concentration (Foundation):**

1. Missing WHERE user_id in one query (P1, CRITICAL): cross-tenant integration test in CI mandatory from day one; service-function userId: string signature lint rule; worker re-asserts ownership on every job load.
2. KEK leaking via log line or env-dump endpoint (P2, CRITICAL): Pino redaction config in first commit; APP_KEK_BASE64 deleted from env after Buffer.from consumes it; no route returns env.
3. Accidental public mode (P18, CRITICAL): no is_public field in v1; anonymous-401 integration test on every endpoint in CI.

**Tier 2 concentration (Polling pipeline, most pitfall-dense phase):**

4. Single priority queue starves hot polls (P4, HIGH): four named queues with separate concurrency caps (4/2/1/2); singletonKey per item.
5. DB transaction across external HTTP call (P5, HIGH): cascading connection-pool drain; two-phase pattern is mandatory.
6. YouTube quota burns by midday for power users (P8, HIGH): batch videos.list up to 50 IDs per call (50x quota efficiency); D-09 quota dashboard with 80% warning.
7. Reddit User-Agent ban or 429 storm (P9/P11, HIGH): mandatory User-Agent format; listing endpoint limit=1; X-Ratelimit-Remaining honored; freeze 404/[removed] items.
8. Tier rules duplicated across scheduler and worker (P7, HIGH): scheduler/tier-resolver.ts is the single source of truth.

**Tier 5 / operational:**

9. Solo operator compromise with no recovery runbook (P20, CRITICAL): rehearsed KEK rotation runbook is a milestone exit criterion.
10. AGPL contamination from LGTM observability stack (P14, HIGH): Grafana/Loki as separate optional containers; CI fails on AGPL in npm deps.

---

## Implications for Roadmap

The 6-tier build order from ARCHITECTURE.md is the authoritative sequencing. Map phases directly to tiers.

### Phase 1: Foundation (Tier 0)

**Rationale:** All features depend on these five components. Tenant-scope middleware, envelope encryption, and proxy-trust must be correct from the first line of application code. Retrofitting userId arguments across services after the fact is the predictable path to P1 (data leak).

**Delivers:** Bootable Docker image with three roles, Postgres with migrations-on-boot, Google OAuth login, envelope encryption unit-tested, cross-tenant integration test in CI, self-host smoke test in CI.

**Addresses:** TS-09 (auth), D-08 (self-host parity scaffold).

**Must implement:** Monorepo scaffold (apps/server, apps/web, packages/shared-types, packages/seed, infra/); multi-stage Dockerfile (distroless final image); docker-compose.saas.yml and docker-compose.selfhost.yml; full Postgres schema scaffold (all tables defined even if unpopulated); Hono skeleton + middleware/tenant.ts + middleware/proxy-trust.ts; Better Auth (Google OAuth round-trip); crypto/envelope.ts with AES-256-GCM unit tests; Pino redaction config (APP_KEK_BASE64, kek, plaintext, req.headers.cookie, etc.); config/index.ts as the only env-reading module; APP_KEK_BASE64 deleted from env after Buffer.from consumes it; Docker memory limits per container; Node --max-old-space-size flags; self-host smoke test in CI; cross-tenant integration test scaffold.

**Avoids pitfalls:** P1, P2, P13, P15, P16, P18.

**Research flag:** Standard patterns, no additional research needed.

---

### Phase 2: Ingest and CRUD (Tier 1)

**Rationale:** Ships end-to-end product without a polling worker. Validates the data model and secret write path. DTO discipline and audit log must be complete here.

**Delivers:** Games CRUD, tracked items CRUD with URL parser, encrypted API key storage with validation-on-submit, owner-visible audit log.

**Addresses:** TS-01, TS-02 (ingest half), TS-08, TS-10, TS-12, D-05.

**Must implement:** Games CRUD + SvelteKit pages; tracked items CRUD + URL parser (Reddit and YouTube URL detection); secrets write-once UI (per-kind form routes at /settings/keys/steam, /settings/keys/youtube, /settings/keys/reddit; zod regex format validation per kind; one test API call before persist; audit log on success/failure); SecretDto schema with only id, kind, last4, kek_version, created_at, rotated_at, never ciphertext fields; audit log read endpoint with tenant-relative cursor (WHERE user_id AND id less than cursor); events timeline CRUD (TS-08); anonymous-401 test for every endpoint in CI.

**Avoids pitfalls:** P3 (ciphertext never in API response), P12 (format validation + test call), P19 (tenant-relative cursor).

**Research flag:** Standard patterns.

---

### Phase 3: Polling Pipeline (Tier 2)

**Rationale:** The most operationally dense phase. pg-boss queues, scheduler, workers, three integration adapters, and the adaptive tier system all land together. Every worker pattern must be correct from the first commit. P4 through P9 and P11 all live here.

**Delivers:** Working adaptive poller with hot/warm/cold tiers; metric_snapshots accumulating; Steam Web API and CSV wishlist import paths working.

**Addresses:** TS-02 (polling half), TS-04, TS-06, D-06 backbone, full infrastructure behind D-03 and timeline charts.

**Must implement:** pg-boss with four named queues (poll.hot, poll.warm, poll.cold, poll.user) and per-source DLQs; singletonKey per item; scheduler/tier-resolver.ts as single source of truth (property-tested, hot_until override supported); scheduler cron tick every 5 min; worker container with per-queue concurrency caps (4/2/1/2); graceful SIGTERM handler (boss.stop graceful=true, timeout 60s); stop_grace_period 90s in compose; YouTube adapter (batched videos.list up to 50 IDs, quotaExceeded vs forbidden parsing, no search.list); Reddit adapter (native fetch ~150 LoC, mandatory User-Agent format, listing endpoint limit=1, X-Ratelimit-Remaining honored, 404/[removed] items frozen); Steam Web API adapter (daily wishlist count); CSV wishlist import path; two-phase poll pattern (read outside tx, decrypt, HTTPS call, then short write tx); metric_snapshots partitioned by month from initial schema; idempotent ON CONFLICT snapshot insert.

**Avoids pitfalls:** P4, P5, P6, P7, P8, P9, P11, P17.

**Research flag: Spike required at phase start.** Reddit /about/rules JSON schema is MEDIUM confidence (direct fetch blocked during initial research). Before locking the subreddit_rules table schema, make one live authenticated GET to /r/IndieDev/about/rules.json. This confirms whether structured fields (cooldown_days, flair_required) exist in the API response or only raw text is returned. Single call that gates D-01 data model in Phase 5.

---

### Phase 4: Visualisation (Tier 3)

**Rationale:** Without charts, the time-series data from Phase 3 is invisible. Turns the ingest pipeline into the actual product. D-03 is gated on TS-05; ship raw lines first, then add annotation markers.

**Delivers:** Per-item growth charts, combined per-game timeline, annotated wishlist correlation chart (the headline differentiator screenshot), polling status badges.

**Addresses:** TS-03, TS-05, TS-07, D-03, D-06 badge surface.

**Must implement:** Per-item detail page with LayerChart line chart over metric_snapshots (views, score, upvoteRatio, wishlistCount over time); combined per-game timeline chart (events + tracked items + wishlist line on one canvas); D-03 annotated correlation chart (wishlist line with promotion event markers; click marker shows event metrics and delta-wishlists in 24h/7d window after the event); hot/warm/cold status badges per item; /api/games/:id/timeline endpoint returning combined data in one response.

**Avoids pitfalls:** Anti-pattern 4 (charts read metric_snapshots only, never mutable tracked_items metric fields).

**Research flag:** Monitor LayerChart 2.x Svelte 5 beta API stability. Fallback is Apache ECharts via svelte-echarts, documented in STACK.md and ready to use with no rework.

---

### Phase 5: Reddit-First Differentiator (Tier 4)

**Rationale:** D-01 (Subreddit Rules Cockpit) and D-02 (pre-post warning) are the primary competitive moat with no competitor equivalent in the indie game dev space. Deferred to Tier 4 because the full stack must be working first. Without them the product is capable but not defensible.

**Delivers:** Subreddit rules visible in-app with structured cooldown/flair fields, last-posted countdown per subreddit per game, pre-post traffic-light warning, curated seed data for top ~10 indie subreddits.

**Addresses:** D-01, D-02, D-04.

**Must implement:** subreddit_rules table + curated seed import (packages/seed/subreddit-rules.json) for top ~10 indie subs (r/IndieDev, r/IndieGaming, r/indiegames, r/playmygame, r/WebGames, r/DestroyMyGame, r/godot, r/Unity3D, r/Unity2D, r/unrealengine) with last_verified timestamp; worker job to auto-pull raw rules text from Reddit /r/{sub}/about/rules.json on subreddit attach; subreddit rules cockpit UI (per-game view, editable structured fields, raw text display, stale badge for entries older than 90 days); D-02 pre-post warning (traffic-light verdict on Reddit URL submit; checks cooldown + flair + self-promo ratio greater than 10 percent of 30d posts + cross-posting frequency 5 or more posts in 24h + duplicate URL; default-to-yellow on any missing data; override is non-blocking; every override audit-logged with the overridden verdict); in-app docs page on shadowban mechanics linked from D-01.

**Avoids pitfalls:** P10 (default-to-yellow, stale badge, override audit trail).

**Research flag:** Reddit /about/rules schema confirmed by Phase 3 spike. Curated seed content (final subreddit list) should be reviewed by the author before content work begins; can run in parallel with Phase 3-4 code.

---

### Phase 6: Trust and Parity Polish (Tier 5)

**Rationale:** Converts interesting tool into I will switch off the spreadsheet. Export, quota dashboard, and stale inbox signal data ownership and honesty. Self-host docs and open-source release formally complete D-08. Disaster recovery runbook must be a rehearsed artifact before this phase closes.

**Delivers:** CSV/JSON export, per-key quota dashboard, stale-item inbox, complete self-host docs, rehearsed KEK rotation runbook, open-source release with THIRD_PARTY_LICENSES.md.

**Addresses:** TS-11, D-09, D-12, D-08 finalisation.

**Must implement:** Per-game CSV/JSON export endpoint (audit-logged; export schema explicitly excludes secrets table; snapshot-tested against JSON shape); D-09 per-key quota dashboard (daily YouTube units used, Reddit rate-limit headroom, 80% warnings); D-12 stale items inbox (last_polled_at greater than 48h; nav badge); docs/self-host.md, docs/kek-rotation.md, docs/trusted-proxy.md; LGTM as optional --profile observability in self-host compose; AGPL explained in docs; KEK rotation runbook rehearsed against staging dataset (timing documented, steps verified); docs/operations.md (lost VPS recovery, suspected KEK leak, suspected DB leak, GDPR deletion script, abuse suspension); THIRD_PARTY_LICENSES.md generated from npm ls --prod; CI fails on AGPL-3.0 in npm deps; status page on separate provider.

**Avoids pitfalls:** P14 (AGPL isolation formalised), P17 (backup retention policy documented), P20 (disaster recovery rehearsed, not aspirational).

**Research flag:** Standard patterns.

---

### Phase 7: Post-Launch Iteration (Tier 6)

Features deferred until product-market validation: D-07 (blogger coverage as first-class entity), D-10 (promotion-intensity heatmap), D-11 (campaign tag grouping), D-02 expansion to ~25 subreddits with community PRs. Trigger criteria for each are documented in FEATURES.md.

---

### Phase Ordering Rationale

- Tenant-scope middleware and envelope encryption in Phase 1: retrofitting after services exist is the most dangerous rework path in the codebase.
- Polling pipeline in one phase (Phase 3): pg-boss, scheduler, and workers are co-dependent. YouTube adapter validates the entire worker scaffolding shape; Reddit and Steam follow on the same pattern.
- Visualisation (Phase 4) gated on time-series data existing: D-03 (annotated correlation chart) cannot be built before snapshots accumulate.
- Reddit Rules Cockpit (Phase 5) deliberately last among features: requires the full stack, is the most labour-intensive, is the primary competitive moat.
- Trust polish (Phase 6) after all features: amplifies an existing working product.
- Self-host parity verified at every phase exit via CI smoke test, not only at Phase 6.

### Research Flags Summary

| Phase | Flag | Action |
|-------|------|--------|
| Phase 1 | None | Standard patterns, proceed |
| Phase 2 | None | Standard patterns, proceed |
| Phase 3 | Reddit /about/rules JSON schema | One live authenticated GET before locking subreddit_rules schema |
| Phase 4 | LayerChart 2.x Svelte 5 stability | Monitor changelog; fallback to ECharts documented |
| Phase 5 | Curated subreddit seed list | Author review before content work |
| Phase 6 | None | Standard patterns, proceed |

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All core picks verified against current official docs (2026-04-27). LayerChart 2.x is MEDIUM (Svelte 5 migration in progress). |
| Features | MEDIUM-HIGH | Table stakes and anti-features verified across multiple competitor surveys. Reddit /about/rules endpoint shape is MEDIUM (direct fetch blocked, spike in Phase 3). |
| Architecture | HIGH | Derived from locked PROJECT.md constraints and verified stack picks. All five major patterns have concrete TypeScript examples in ARCHITECTURE.md. |
| Pitfalls | HIGH / MEDIUM | Architectural pitfalls HIGH. Reddit anti-spam thresholds MEDIUM (community-curated wisdom, not Reddit published numbers). |

**Overall confidence: HIGH** - sufficient to begin roadmap and execution without additional research, with one spike at Phase 3 start.

### Gaps to Address

- Reddit /about/rules JSON schema: one live authenticated GET before locking subreddit_rules table schema in Phase 3. Confirms whether structured fields (cooldown_days, flair_required) exist in the API or only raw text.
- LayerChart 2.x Svelte 5 stability: monitor changelog at Phase 4 start; fallback to Apache ECharts documented in STACK.md and ready to use with no rework.
- VPS RAM budget: STACK.md budgets 2 GB VPS; PITFALLS.md recommends 4 GB minimum if running full LGTM stack. Decide before Phase 1 infra setup: provision 4 GB, or default to stdout-only logging. Both paths documented.
- Curated subreddit seed list: author should review the proposed ~10 subs before D-04 content work begins in Phase 5.

---

## Sources

Full citations in each source file.

### Primary (HIGH confidence)
- .planning/research/STACK.md (2026-04-27): all core technology picks with version confirmation
- .planning/research/ARCHITECTURE.md (2026-04-27): component map, patterns, data flows, 6-tier build order
- .planning/research/PITFALLS.md (2026-04-27): 20 pitfalls with severity, phase mapping, and concrete mitigations
- .planning/research/FEATURES.md (2026-04-27): feature landscape, dependency graph, MVP definition, anti-features
- .planning/PROJECT.md: locked constraints and requirements
- Official docs: Hono 4.12.x, pg-boss v10, Drizzle 0.45, Better Auth 1.6, SvelteKit 2 / Svelte 5, Node.js 22 crypto, Cloudflare Free tier limits, YouTube Data API v3 quota, Steamworks IWishlistService
- snoowrap GitHub archived notice (2024-03-17): do-not-use confirmed
- Lucia Auth deprecation notice (March 2025): do-not-use confirmed

### Secondary (MEDIUM confidence)
- Competitor survey: GameDiscoverCo, IMPRESS / Coverage Bot, VG Insights, SteamDB, RedChecker, RedShip, Buffer / Hootsuite / Metricool
- Reddit /about/rules endpoint shape: confirmed via secondary docs (apidog, latenode, zuplo); direct fetch blocked during research
- LayerChart 2.x Svelte 5 migration status: layerchart.com
- SvelteKit vs Next.js bundle-size comparison: community benchmark posts

### Tertiary (LOW confidence)
- RedChecker specific feature set: launch announcement and indie-hackers post only
- Reddit anti-spam thresholds: community-curated wisdom from 2024-2025 indie marketing posts; not Reddit published documentation

---
*Research completed: 2026-04-27*
*Ready for roadmap: yes*
