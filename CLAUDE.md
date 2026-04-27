<!-- GSD:project-start source:PROJECT.md -->
## Project

**Neotolis Game Promotion Diary**

A self-tracking diary for indie game developers to log promotion activity (Reddit posts, YouTube videos, conferences, blogger coverage) and watch how it moves wishlists and engagement over time. The user manually adds links/events; the service auto-pulls metrics (views, upvotes, comments) and visualizes their evolution. Multi-tenant SaaS hosted by the author plus open-source code so anyone can self-host their own instance.

**Core Value:** Replace messy Google Sheets / markdown files with a structured, secure, query-friendly diary so an indie developer can see — at a glance — which promotion actions actually moved the needle on wishlists and engagement.

### Constraints

- **Auth**: Google OAuth only — no email/password, no GitHub. Reduces auth attack surface.
- **Privacy**: private-by-default. No public dashboards in MVP. All data scoped to `user_id`.
- **Security — at-rest secrets**: API keys must be envelope-encrypted (KEK from env, DEK per row), write-once in UI (show only last 4 chars after save), never logged, never returned in API responses.
- **Security — transport**: TLS 1.3 + HSTS via Cloudflare. No raw HTTP in production.
- **Budget**: indie/zero-budget. Every infra component must work on free tier (Cloudflare Free, small aeza VPS, no paid SaaS dependencies for critical path).
- **Tech stack**: deferred to research phase — author trusts the researcher to pick the standard 2025 stack for this kind of multi-tenant SaaS. Required: Docker-deployable to a Linux VPS, Postgres-compatible storage acceptable, must support a background worker pool.
- **Hosting**: aeza VPS as primary, Cloudflare Free tier (with optional Tunnel for hidden origin) as edge.
- **License**: MIT.
- **Languages**: English-only UI in MVP; code must be i18n-structured.
- **Open-source compatibility**: must run identically in SaaS multi-tenant mode and self-host single-tenant mode. Trusted-proxy headers must be honored so the service works behind any of: bare port, nginx, Caddy, Cloudflare Tunnel.
- **Polling cadence**: adaptive (hot/warm/cold) to stay inside YouTube and Reddit quotas with comfortable headroom.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## TL;DR Recommendation
## Recommended Stack
### Core Technologies
| Technology | Version | Purpose | Why Recommended | Confidence | License |
|------------|---------|---------|-----------------|------------|---------|
| **Node.js** | 22 LTS (≥22.11) | Runtime | LTS until April 2027; native test runner, native `fetch`, native `WebCrypto`, stable ESM. Single language for backend, frontend, and workers — one tool surface for the operator. | HIGH | — |
| **TypeScript** | 5.6+ | Language | De-facto standard 2026; required for Drizzle's inferred types and Better Auth's typed config. Strict mode catches the multi-tenant `user_id` mistakes that destroy SaaS. | HIGH | Apache-2.0 |
| **Hono** | 4.12.x | Backend HTTP framework | ~14 KB, web-standards (Request/Response), runs identically on Node, Bun, Deno, Cloudflare Workers. Faster than Fastify on Node, dramatically lighter than NestJS. Critical for self-host: tiny container image, no DI graph cold-start. Built-in helpers for CORS, JWT, secure headers, **and** an official proxy helper that handles `X-Forwarded-For` / `X-Forwarded-Proto` cleanly. | HIGH | MIT |
| **@hono/node-server** | 1.19.x | Node adapter for Hono | The supported way to run Hono on Node.js. Maintained by the Hono core team. | HIGH | MIT |
| **PostgreSQL** | 16.x (≥16.4) | Database | Postgres 16 is the current production target. Supports `SKIP LOCKED` (queue), `pgcrypto` (defense in depth), partitioned tables (pg-boss v10 uses these), and JSONB (rules/audit metadata). Single binary; trivial to back up with `pg_dump`; no managed-only features used. | HIGH | PostgreSQL (BSD-style) |
| **Drizzle ORM** | 0.45.x stable (1.0 beta available — pin to 0.45 for MVP) | ORM + query builder | TypeScript-first, schema-as-code, generates **readable SQL migrations**, smaller bundle than Prisma, no separate engine binary (Prisma 7 still ships one). Migrations are plain SQL files committed to git — reviewable in PR, runnable with `drizzle-kit migrate` in the same container at boot. | HIGH | Apache-2.0 |
| **pg (node-postgres)** | 8.13+ | Postgres driver | Battle-tested, used under the hood by both Drizzle and pg-boss; pg-boss v10 currently requires `pg` (not `postgres.js`). Using one driver across ORM and queue means one connection-pool config to reason about. | HIGH | MIT |
| **pg-boss** | 10.x | Job queue + scheduler | The single most important pick. Postgres-native (no Redis), supports cron-like schedules, retries, dead-letter queues, exponential backoff, priorities, rate limiting per queue, and partitioned storage in v10. Solves adaptive polling natively: enqueue with `startAfter` to push warm/cold items into the future. Self-host parity is automatic — no second service to operate. | HIGH | MIT |
| **SvelteKit** | 2.58+ (Svelte 5) | Frontend full-stack | 20–40 % smaller bundles than Next.js, compile-time reactivity, runs on Node behind the same Hono service or as static-adapter output. Lower hosting cost on a small VPS. SSR + form actions handle the diary's CRUD-heavy UI cleanly. **Svelte 5 runes** are stable; SvelteKit 2 supports them. | HIGH | MIT |
| **Better Auth** | 1.6.x | Authentication | Lucia v3 was deprecated March 2025; Better Auth is the de-facto successor in 2026. Native Google OAuth provider, Drizzle adapter, manages its own schema + migrations, server-only session cookies (no JWT in browser), supports cookie domain config so the same code serves SaaS multi-tenant and self-host single-tenant. No paid SaaS dependency (unlike Clerk/Auth0). | HIGH | MIT |
| **@better-auth/drizzle-adapter** | matched | Better Auth ↔ Drizzle | Lets Better Auth own its tables but keep them inside the same Postgres instance with the same migration tooling. | HIGH | MIT |
| **Pino** | 9.x | Structured logging | Fastest Node logger; JSON-by-default; trivially shippable to Loki via `pino-loki` transport, or just to stdout for `docker logs` / promtail to pick up. Self-host: stdout is enough; SaaS: add the transport. | HIGH | MIT |
### Supporting Libraries
| Library | Version | Purpose | When to Use | Confidence | License |
|---------|---------|---------|-------------|------------|---------|
| **googleapis** | 144.x | YouTube Data API v3 client | Official Google client; covers `videos.list`, `channels.list`, `search.list`. Includes typed responses. Pair with stored per-user OAuth tokens (or API key for read-only public data). | HIGH | Apache-2.0 |
| **google-auth-library** | 9.x | Google OAuth token mgmt | Used internally by `googleapis`; surfaces refresh-token flow we need for per-user keys. | HIGH | Apache-2.0 |
| **(custom) Reddit client** | n/a — write a thin module | Reddit API | **`snoowrap` is archived (March 2024)** — do NOT add it to the dependency graph. Reddit's OAuth + JSON API is small enough to wrap in ~150 lines using native `fetch`: `POST /api/v1/access_token` for OAuth, `GET /comments/{id}.json` for post snapshots, `GET /r/{sub}/about/rules` for rules. This is also safer for self-host (no abandoned transitive deps). | HIGH | (own code, MIT) |
| **(direct fetch) Steam Web API** | n/a — write a thin module | Steam wishlist + app data | Endpoints: `IWishlistService/GetWishlistItemCount/v1`, `IWishlistService/GetWishlist/v1`, `ISteamApps/GetAppList/v2`. Key per Steamworks publisher; user-supplied. No npm wrapper is worth its maintenance risk; raw `fetch` is sufficient. | HIGH | (own code, MIT) |
| **zod** | 3.23+ | Runtime validation + types | Validate all inbound request bodies, env config, and **API responses** from YouTube/Reddit/Steam (their schemas drift). Pairs with Hono's `@hono/zod-validator`. | HIGH | MIT |
| **@hono/zod-validator** | 0.4+ | Hono request validation | Adapter that ties zod schemas into Hono routes with type inference. | HIGH | MIT |
| **rate-limiter-flexible** | 5.x | Rate limiting | Tier-aware rate limits on login, key writes, and external API egress. Has `RateLimiterMemory` (in-process) and `RateLimiterPostgres` backends — start with memory for self-host, switch to Postgres backend for SaaS multi-instance. Same library, two configs. | HIGH | ISC |
| **Paraglide JS** | 2.x | i18n compiler | Officially recommended by Svelte for SvelteKit. Compile-time tree-shaken messages → near-zero runtime cost. English-only at MVP but the structure is in place; adding a locale is dropping a JSON file. | HIGH | Apache-2.0 |
| **LayerChart** | 1.x (Svelte 4) / 2.x beta (Svelte 5) | Charts | Built on Layer Cake, same author as Svelte UX. Unopinionated primitives → time-series with gridlines, tooltips, multi-axis (wishlist vs. own actions). Pure Svelte, no DOM-foreign canvas issues. **Fallback:** Apache ECharts via `svelte-echarts` if a more turnkey kitchen-sink is needed. | MEDIUM | MIT |
| **pino-loki** | 2.x | Loki transport for Pino | Optional — only used when Loki is wired up. Self-host can skip and just `docker logs`. | MEDIUM | MIT |
| **dotenv** | 16.x | Env loading (dev) | Production reads from real env (set via Docker / systemd); dotenv is a dev convenience. | HIGH | BSD-2-Clause |
### Encryption (envelope: KEK in env, DEK per row)
| Library | Version | Purpose | Confidence | License |
|---------|---------|---------|------------|---------|
| **Node.js `node:crypto`** (built-in) | runtime | AES-256-GCM for both KEK-wrap-DEK and DEK-encrypt-secret | HIGH | (Node core) |
### Development Tools
| Tool | Purpose | Notes | License |
|------|---------|-------|---------|
| **Vitest** | 4.x — Unit + integration tests | Native ESM, Vite-shared config, ~5–10× faster than Jest. Browser-mode via Playwright if needed. | MIT |
| **Playwright** | 1.50+ — E2E tests | Industry standard 2026; runs in CI against the Docker compose stack. | Apache-2.0 |
| **Drizzle Kit** | matched to drizzle-orm | `drizzle-kit generate`, `drizzle-kit migrate`, `drizzle-kit check` (the v0.45+ commutativity check catches branch-merge migration conflicts before they hit prod). | Apache-2.0 |
| **tsx** | 4.x — TypeScript runner | For dev `node --watch` equivalent and one-off scripts. | MIT |
| **Biome** | 2.x — Lint + format | Single binary replacing ESLint+Prettier. Faster, simpler self-host story (one tool instead of two configs). Acceptable alternative: ESLint 9 flat config + Prettier if Biome's Svelte support lags for you. | MIT |
| **Docker** + **Docker Compose v2** | Container build + multi-service orchestration | Single `Dockerfile` (multi-stage, distroless final), single `docker-compose.yml` for self-host (app + postgres + cloudflared optional). | Apache-2.0 (Compose), Apache-2.0 (Engine) |
### Observability (free, self-hostable)
| Tool | Purpose | Notes | License |
|------|---------|-------|---------|
| **Grafana** | 11.x — Dashboards | The visualization layer everyone agrees on. | AGPL-3.0 ⚠ |
| **Loki** | 3.x — Log aggregation | Cheap log indexing (labels, not full text). 2–4 GB RAM is enough on a small VPS. | AGPL-3.0 ⚠ |
| **Prometheus** | 3.x — Metrics | Worker queue depth, polling latency, API quota consumption per tier. | Apache-2.0 |
| **node-exporter** | 1.8+ — Host metrics | CPU/disk/mem from the VPS. | Apache-2.0 |
| **Alertmanager** | 0.27+ — Alerts (optional) | Email/Discord alerts when queue depth or error rate spikes. | Apache-2.0 |
### Container build + deploy
| Component | Choice | Rationale |
|-----------|--------|-----------|
| Base image | `node:22-alpine` build stage → `gcr.io/distroless/nodejs22-debian12:nonroot` runtime | Distroless = no shell, no package manager, ~80 MB final image. Same image runs SaaS and self-host. |
| Process model | One container per role: `app` (Hono+SvelteKit), `worker` (pg-boss workers), `scheduler` (pg-boss cron) | Lets self-host operators scale workers independently and lets the SaaS operator restart workers without dropping web sessions. All three use the same image with different `CMD`. |
| Reverse proxy (SaaS) | Cloudflare Free + (optional) Cloudflare Tunnel | TLS, DDoS, WAF, hidden origin. Tunnel free tier supports up to 1000 tunnels per account — plenty for one app. |
| Reverse proxy (self-host) | Caddy (recommended in docs) or nginx, or bare cloudflared | Caddy = zero-config HTTPS via Let's Encrypt; matches indie-friendly ergonomics. Trusted-proxy headers documented per option. |
| Migrations | `drizzle-kit migrate` runs at container boot, before the app server starts listening | Idempotent; safe to re-run; works identically in SaaS and self-host. |
## Installation
# Core runtime + framework
# Database
# Job queue (no Redis)
# Auth
# External APIs (Reddit + Steam clients are written in-house — see Supporting Libraries note)
# Logging + ops
# Frontend (separate workspace recommended)
# Dev / test
## Alternatives Considered
| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| **Hono** | Fastify 5.x | If team needs the larger plugin ecosystem and is Node-only with no edge-runtime ambition. Fastify is excellent on a VPS but has a heavier surface area for the same wins. |
| **Hono** | NestJS 10+ | Avoid for this size of app — DI graph and module-graph cold-start cost more than they're worth on a 2 GB VPS, and the abstractions hide the things a single-operator dev needs to see. |
| **Hono** | Express 5 | Express 5 is fine but slower, fewer typed primitives, and weaker web-standards story. Pick Express only if integrating an existing Express middleware that has no Hono equivalent. |
| **SvelteKit** | Next.js 16 (App Router) | Use Next if you have hard React-ecosystem needs (e.g. an existing component library). For self-host, ships ~30–40 % more JS to the browser. |
| **SvelteKit** | Remix / React Router v7 | Solid for form-heavy apps. SvelteKit wins on bundle size and operator-friendliness. Pick this if author insists on React. |
| **SvelteKit** | Astro | Astro is content-first; this app is dashboard-first with lots of reactive client state. Wrong tool. |
| **Drizzle** | Prisma 7 | Prisma 7 closed the perf gap and dropped its Rust engine, but still has more codegen and a heavier dev loop. Pick Prisma only if author already deeply knows it. |
| **Drizzle** | Kysely | Kysely is a query builder, not an ORM — you give up the schema-as-types story. Pick Kysely if you want raw SQL with type-safety and don't want a migration tool opinion. |
| **pg-boss** | BullMQ | **Avoid for this project — requires Redis,** which kills the "Postgres-only single-VPS" story. BullMQ is the right answer when you already have Redis and need queue throughput >5k jobs/sec. |
| **pg-boss** | graphile-worker | Excellent alternative; similar perf, simpler API, but smaller community (~42k weekly DLs vs pg-boss ~96k) and fewer cron / dead-letter primitives out of the box. Pick graphile-worker if you want the smallest dependency surface or are already running PostGraphile. |
| **pg-boss** | River (Go) | River is the best-in-class Postgres queue but Go-only. Picking it forces a polyglot deploy: TS web + Go workers. Reject for one-operator simplicity. |
| **pg-boss** | Hatchet, Trigger.dev | Both are SaaS-first and add a managed dependency. Reject. |
| **pg-boss** | Inngest | SaaS-first; self-host story exists but is heavier than pg-boss. Reject for indie budget. |
| **Better Auth** | Auth.js (NextAuth) | Auth.js works on SvelteKit but is still framework-shaped around Next; Better Auth is more SvelteKit-native and has a cleaner Drizzle adapter. |
| **Better Auth** | Lucia v3 | **Deprecated March 2025; do not use.** Lucia is a learning resource now. |
| **Better Auth** | Clerk / Auth0 / WorkOS | All paid SaaS, all violate "no required paid SaaS dependency in critical path." |
| **Better Auth** | Roll-your-own session cookies + `googleapis` OAuth | Tempting and possible (it's what Lucia taught us), but session rotation, CSRF defenses, account-linking, audit hooks are real work. Better Auth bundles these and is MIT. |
| **Node `crypto` (envelope)** | AWS Encryption SDK for JavaScript | Use only if migrating to KMS-backed KEK. Adds AWS SDK dependency mass for zero gain on a single VPS. |
| **Node `crypto` (envelope)** | Google Tink for JS | Same reasoning — Tink shines with Cloud KMS; without KMS it's overkill. |
| **Pino** | Winston | Slower (~5×), more transports historically but Pino's transport story has caught up. |
| **LayerChart** | Apache ECharts (`svelte-echarts`) | If you outgrow LayerChart's primitives or need 3D / heatmap. Larger bundle. |
| **LayerChart** | Chart.js (`svelte-chartjs`) | Acceptable but Canvas-only and less Svelte-native. |
| **Postgres** | SQLite (libSQL/Turso) | SQLite would be even simpler for self-host, but breaks `SKIP LOCKED` queue semantics, makes pg-boss unusable, and complicates the SaaS multi-tenant story. Stick with Postgres. |
| **Postgres** | MySQL/MariaDB | No `pg-boss` equivalent; weaker JSONB; loses partitioned-table queue. Reject. |
| **Caddy (self-host proxy)** | nginx | Nginx is fine; Caddy is recommended because zero-config HTTPS keeps the self-host README short. |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **Lucia Auth** | Deprecated since March 2025 — repository is a learning resource only. | Better Auth |
| **snoowrap (Reddit wrapper)** | **Archived on GitHub 2024-03-17.** Last release May 2021. Brings unmaintained transitive deps (notably `request`, also abandoned). | Native `fetch` against Reddit's documented OAuth endpoints (~150 LoC) |
| **BullMQ / Bull** | Requires Redis — adds a second stateful service. Doubles backup surface, doubles ops surface. Conflicts with the "single small VPS" constraint. | pg-boss |
| **Redis as a hard dep anywhere** | Same reasoning. If Redis sneaks in for sessions/cache/rate-limit, you've lost the self-host simplicity story. | Postgres for queue (pg-boss), in-process LRU for cache, `RateLimiterMemory` then `RateLimiterPostgres` for rate limits |
| **NestJS** | DI graph + module system overhead is wrong-shape for a one-operator indie SaaS. Cold start and bundle size both regress. | Hono |
| **Prisma 6 and earlier** | Old Rust query engine = ~80 MB binary in the container. Prisma 7 dropped it but Drizzle is simpler still. | Drizzle ORM |
| **Sequelize** | Outdated patterns, weak TypeScript story, slow migrations. | Drizzle ORM |
| **Vercel / Netlify as the SaaS host** | Free tier has function-duration limits that break adaptive polling workers. SaaS self-host story implies a long-running process model. | aeza VPS + Docker compose |
| **Cloudflare Workers as the only runtime** | Workers have CPU-time and storage limits incompatible with long polling jobs and a single Postgres connection pool. | Use Workers only as edge / Cloudflare Tunnel |
| **Email/password auth** | Adds password-reset flow, brute-force surface, and breach-list checking — all out of scope per project constraints. | Google OAuth via Better Auth (only) |
| **JWT in browser-accessible storage** | Token theft via XSS. Better Auth's default is HTTP-only session cookies, which is correct. | HTTP-only, `Secure`, `SameSite=Lax` cookies (Better Auth default) |
| **Storing the KEK in the database** | Defeats envelope encryption — a leaked DB then leaks all secrets. | `APP_KEK_BASE64` env var only; documented rotation procedure |
| **Logging full request bodies / API key writes** | Trivial way to leak secrets into Loki / `docker logs`. | Pino redaction config (`redact: ['req.headers.authorization', '*.apiKey', '*.refreshToken']`) |
| **`request`, `request-promise` (Reddit/HTTP libs)** | Both deprecated in 2020. They're snoowrap's transitive dep — yet another reason to skip snoowrap. | Native `fetch` (Node 22 has it built-in) |
| **`crypto-js` for AES** | Pure-JS, slow, has had subtle issues; not authenticated by default. | Node's built-in `node:crypto` (AES-256-GCM) |
| **`bcrypt` / `argon2` for API keys** | These are *password* hashers — wrong primitive. API keys must be **encrypted** (recoverable) so the worker can use them, not hashed. | Envelope-encrypt with AES-256-GCM (above) |
| **MongoDB / DynamoDB** | No mature Postgres-equivalent queue, no `SKIP LOCKED`, complicates the schema migration story. | Postgres |
| **Sentry self-host (managed FE only on free tier)** | Self-host Sentry is heavy (multiple services, ~4 GB RAM). | Pino → Loki + Grafana alerts is enough at indie scale |
## Stack Patterns by Variant
- Three containers from one image: `app`, `worker`, `scheduler`
- Cloudflare Free + Cloudflare Tunnel → cloudflared sidecar in compose
- Loki + Prometheus + Grafana on the same VPS (Caddy-proxied)
- Rate limit backend: `RateLimiterPostgres` (so multiple app replicas share state — even if today there's only one, future-you will thank you)
- Backups: nightly `pg_dump` to Cloudflare R2 (R2 free tier = 10 GB)
- Same three containers, or run worker+scheduler in the app container behind feature flags (env: `WORKERS_INLINE=true`)
- Reverse proxy: Caddy (default in docs) or nginx
- Observability: optional — default to stdout logging, document optional Loki side-deploy
- Rate limit backend: `RateLimiterMemory`
- Backups: documented `pg_dump` cron
## Version Compatibility
| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `pg-boss@10.x` | `pg@8.13+`, Postgres ≥13 (16 recommended) | v10 requires queues to be created explicitly before insert. Migration from v9 is **not automatic** — start fresh on v10. |
| `pg-boss@10.x` | Node ≥20 | v10 dropped Node 18 support. |
| `drizzle-orm@0.45.x` | `pg@8.x`, Postgres 12+ | Use `drizzle-kit check` before merging migrations from feature branches — catches commutativity issues. |
| `drizzle-orm@1.0-beta` | (still beta — pin 0.45 for MVP) | Migration to 1.0 is straightforward but unnecessary risk for an MVP. Revisit at milestone 2. |
| `hono@4.12.x` | `@hono/node-server@1.19.x` | Always upgrade together. |
| `better-auth@1.6.x` | `drizzle-orm@0.45.x` | Use `@better-auth/drizzle-adapter` matched to better-auth version. |
| `@sveltejs/kit@2.58+` | `svelte@5.x` | Svelte 5 runes (`$state`, `$derived`) are stable; SvelteKit 2 supports them. |
| `paraglide-js@2.x` | `@sveltejs/kit@2.x` | Use `@inlang/paraglide-sveltekit` adapter. |
| `googleapis@144.x` | `google-auth-library@9.x` | Bundled together in practice. |
| `vitest@4.x` | `node@22` | Vitest 4 introduced browser mode via Playwright; Node 22 required for some test-runner features. |
## Critical "must work the same in both modes" implementation notes
## License Risk Summary
| Component | License | Risk Level | Notes |
|-----------|---------|------------|-------|
| Node, TS, Hono, Drizzle, pg-boss, Better Auth, SvelteKit, Pino, zod, rate-limiter-flexible | MIT / Apache-2.0 / BSD / ISC | **None** | All permissive, MIT-compatible. |
| googleapis, google-auth-library | Apache-2.0 | None | Apache-2.0 is MIT-compatible for our use. |
| Paraglide, LayerChart | Apache-2.0 / MIT | None | — |
| **Grafana, Loki** | **AGPL-3.0** | **Low** | AGPL only matters if we redistribute the modified service or link it into our process. We run it as a separate container; our app code is not derivative. **Document this clearly in self-host docs**: "AGPL components are optional; you can omit Loki/Grafana." |
| PostgreSQL | PostgreSQL License (BSD-style) | None | — |
## Sources
- [Hono official docs (4.12.x)](https://hono.dev/docs) — confirmed framework features, proxy helpers, Node adapter — HIGH
- [Hono Node.js Server adapter (npm)](https://www.npmjs.com/package/@hono/node-server) — version 1.19.12 confirmed — HIGH
- [Hono Releases on GitHub](https://github.com/honojs/hono/releases) — version 4.12.14 confirmed — HIGH
- [Hono Proxy Helper docs](https://hono.dev/docs/helpers/proxy) — `X-Forwarded-*` handling — HIGH
- [Hono "Behind a reverse proxy" example](https://hono.dev/examples/behind-reverse-proxy) — HIGH
- [pg-boss on GitHub](https://github.com/timgit/pg-boss) — MIT license, Postgres-native queue — HIGH
- [pg-boss v10 release notes](https://github.com/timgit/pg-boss/releases/tag/10.0.0) — Node 20+, Postgres 13+, dead-letter queues, partitioned tables — HIGH
- [Drizzle ORM official site](https://orm.drizzle.team/) — schema-as-code, SQL migrations, Apache-2.0 — HIGH
- [Drizzle ORM Releases (GitHub)](https://github.com/drizzle-team/drizzle-orm/releases) — 0.45.2 stable, 1.0-beta available — HIGH
- [Drizzle vs Prisma 2026 (MakerKit)](https://makerkit.dev/blog/tutorials/drizzle-vs-prisma) — Migration workflow comparison — MEDIUM
- [Better Auth official site](https://better-auth.com/) — MIT license confirmed — HIGH
- [Better Auth Google OAuth docs](https://better-auth.com/docs/authentication/google) — Setup steps verified — HIGH
- [Better Auth Drizzle adapter docs](https://better-auth.com/docs/adapters/drizzle) — HIGH
- [Better Auth releases (GitHub)](https://github.com/better-auth/better-auth/releases) — current 1.6.x, 1.7-beta — HIGH
- [Lucia Auth deprecation announcement](https://lucia-auth.com/) — confirmed maintenance mode — HIGH
- [SvelteKit on npm](https://www.npmjs.com/package/@sveltejs/kit) — version 2.58.x confirmed — HIGH
- [SvelteKit vs Next.js vs Remix 2026 comparison](https://dev.to/pockit_tools/nextjs-vs-remix-vs-astro-vs-sveltekit-in-2026-the-definitive-framework-decision-guide-lp5) — Bundle size & self-host fit — MEDIUM
- [Paraglide JS for SvelteKit](https://inlang.com/m/gerre34r/library-inlang-paraglideJs/sveltekit) — Officially recommended by Svelte — HIGH
- [LayerChart](https://layerchart.com/) — Svelte 5 migration in progress — MEDIUM
- [snoowrap GitHub](https://github.com/not-an-aardvark/snoowrap) — **Archived 2024-03-17, last release May 2021** — HIGH (do not use)
- [googleapis on npm](https://www.npmjs.com/package/googleapis) — Official Google client, Apache-2.0 — HIGH
- [YouTube Data API OAuth 2.0 server-side guide](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps) — HIGH
- [Steamworks IWishlistService](https://partner.steamgames.com/doc/webapi_overview) — `IWishlistService/GetWishlist/v1` is the current wishlist endpoint — HIGH
- [Node.js crypto docs (AES-256-GCM)](https://nodejs.org/api/crypto.html) — built-in, no third-party SDK needed — HIGH
- [AWS Encryption SDK for JavaScript](https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/javascript.html) — KMS-coupled; not needed for env-KEK — HIGH (rejected for our scope)
- [rate-limiter-flexible on GitHub](https://github.com/animir/node-rate-limiter-flexible) — ISC, supports Memory and Postgres backends — HIGH
- [Pino on npm](https://www.npmjs.com/package/pino) — Fastest Node logger — HIGH
- [pino-loki transport](https://www.npmjs.com/package/pino-loki) — Self-host Loki integration — MEDIUM
- [Cloudflare Tunnel free tier limits](https://developers.cloudflare.com/cloudflare-one/account-limits/) — 1000 tunnels/account on free Zero Trust — HIGH
- [Distroless Node.js image](https://github.com/GoogleContainerTools/distroless) — Final container target — HIGH
- [LGTM observability stack overview (Grafana Labs)](https://grafana.com/oss/) — Logs+Metrics+Traces+Metrics, AGPL components flagged — HIGH
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
