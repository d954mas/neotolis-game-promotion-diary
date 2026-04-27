# Neotolis Game Promotion Diary

## What This Is

A self-tracking diary for indie game developers to log promotion activity (Reddit posts, YouTube videos, conferences, blogger coverage) and watch how it moves wishlists and engagement over time. The user manually adds links/events; the service auto-pulls metrics (views, upvotes, comments) and visualizes their evolution. Multi-tenant SaaS hosted by the author plus open-source code so anyone can self-host their own instance.

## Core Value

Replace messy Google Sheets / markdown files with a structured, secure, query-friendly diary so an indie developer can see — at a glance — which promotion actions actually moved the needle on wishlists and engagement.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Google OAuth login (the only auth method in MVP)
- [ ] Multiple games per developer account (game cards with title, Steam URL, cover, release date, tags/genres, free-form comments)
- [ ] Per-game associations: multiple YouTube channels / TG channels / Twitter accounts / Discord — added by the user
- [ ] Per-user encrypted API key storage (YouTube Data API, Reddit OAuth, optional Steam Web API key)
- [ ] Reddit channel: log post URLs, fetch metadata + likes/comments via Reddit API, snapshot over time
- [ ] Reddit subreddit rules: pull rules text via API + let user define structured rules per popular subreddit (cooldown, allowed flairs, self-promo limits) and warn before posting
- [ ] YouTube channel: log own videos and blogger videos (distinguished), fetch view count + metadata, plot growth over time
- [ ] Telegram (manual entry only in MVP — no API tracking)
- [ ] Events timeline: free-form entries for conferences, talks, Twitter posts, etc. (manual)
- [ ] Wishlist tracking: optional Steam Web API key auto-pull OR manual entry / CSV import from Steamworks dashboard
- [ ] Adaptive polling worker: new posts/videos polled hourly (or every 30 min) for first 24h, then 4×/day, items >30 days old → 1×/day
- [ ] Background job queue + scheduler architecture (cron-like enqueue, worker pool consumes)
- [ ] Per-game timeline view combining own actions, blogger coverage, and wishlist line on a single chart
- [ ] Per-item detail views: YouTube video card with views graph; Reddit post with likes/comments graph
- [ ] Privacy: data is private to its owner — no public dashboards, no sharing in MVP
- [ ] User-visible audit log (logins, IPs, key add/remove, exports)
- [ ] Envelope encryption for stored secrets (KEK in env, DEK per row); write-once secret UI (show last 4 chars only)
- [ ] English-only UI (i18n-ready structure but only `en` shipped)
- [ ] Open-source repo with MIT license + self-host docs (Docker compose + env-var config)
- [ ] Deployable to a small VPS (aeza) behind Cloudflare Free tier (TLS, DDoS, WAF) with optional Cloudflare Tunnel for hidden origin
- [ ] Trusted-proxy header handling (`X-Forwarded-For`, `CF-Connecting-IP`, `X-Forwarded-Proto`) so audit logs and rate-limits work behind any reverse proxy

### Out of Scope

- **Scheduling/auto-posting to Reddit/YouTube/TG** — service is read-only on social platforms; user posts manually, service tracks the result
- **Public catalog of indie games / public dashboards** — privacy-only model; sharing deferred to v2
- **Twitter/X API tracking** — paid API ($100/mo), too costly for indie. Twitter posts logged manually as timeline events
- **Telegram channel auto-tracking (Bot API or MTProto)** — added manually as timeline events; deferred to v2 to keep MVP shallow
- **Auto-discovery of mentions** ("system finds my game on YouTube/Reddit") — explicitly v2; MVP requires the user to add URLs
- **Email/password and GitHub auth** — only Google OAuth in MVP to reduce attack surface
- **Service-level TOTP / 2FA** — relies on Google's 2FA; no in-app TOTP in MVP
- **Public/shared reports for investors/colleagues** — deferred to v2 (share-link model)
- **Multi-language UI** — English only in MVP; i18n structure ready, locales added later
- **Steamworks Partner API in self-host setup notes** — supported but explicitly the user's responsibility to obtain and rotate keys

## Context

- **Author profile**: indie developer, technical (asks about workers/queues/quotas/encryption), Russian-speaking, on a tight budget — cost-sensitivity drives every infra choice toward free tiers.
- **Trigger**: author currently tracks promotion activity in Google Sheets / markdown files; this is brittle, hard to query, and doesn't surface "what worked".
- **Domain**: Steam wishlists are the dominant proxy for an indie game's pre-launch health; Reddit and YouTube are the highest-leverage promotion channels for indies in 2025.
- **Reddit nuance**: every subreddit has its own rules (cooldowns, allowed flairs, self-promo caps); accidentally violating them risks shadowbans, which destroys promotion runway. Surfacing rules in-app prevents this.
- **Distribution model**: author hosts the canonical SaaS instance on aeza VPS; code is MIT-licensed so security-conscious devs can self-host. Code must run identically in both modes.
- **API quotas — why per-user keys matter**: YouTube Data API quota is per Google Cloud project (10k units/day); Reddit API is per OAuth app. Pooling under one app key fails at scale. Each user supplies their own keys → quotas distribute, attack surface shrinks, blast radius of a leaked server is bounded.
- **Steam Web API key risk**: it's per-publisher (one key per Steamworks account, not per game), grants read access to wishlist + sales data but cannot deploy builds or change store pages (those need a separate Steamworks login). Users can rotate the key in Steamworks at any time, which fully invalidates the leaked one — this is the primary mitigation.
- **Design workflow**: author wants to use the design.md workflow (Google Stitch generates UI → exported as `design.md` spec → Claude Code implements). This shapes the UI phase but not earlier phases.

## Constraints

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

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| SaaS + open-source self-host (single multi-tenant codebase) | Author hosts canonical instance; security-conscious devs self-host. One codebase serves both. | — Pending |
| Per-user API keys (YouTube/Reddit/Steam), encrypted at rest | Distributes quotas, bounds blast radius of a leaked server, makes self-host trivial. | — Pending |
| Steam Web API key is optional (manual/CSV fallback) | Lets risk-averse devs use the service without exposing a high-privilege key. | — Pending |
| Hybrid ingestion: user pastes URL → service auto-fetches metrics over time | Matches author's mental model ("I add a thing, system tracks it"); avoids ToS-risky scraping/auto-discovery. | — Pending |
| Reddit rules: API-pulled text + user-curated structured rules per popular subreddit | API exposes raw rules; structured cooldown/flair fields require manual curation. Hybrid is the only honest model. | — Pending |
| Adaptive polling (hot/warm/cold tiers) | Matches API quota envelope; spends polling budget where data is actually changing. | — Pending |
| Google OAuth as the only auth method in MVP | Smallest auth attack surface; offloads 2FA to Google; no password reset flows to build. | — Pending |
| Privacy-only (no public dashboards in MVP) | Promotion data is sensitive (financials via Steam); shareable views deferred to v2. | — Pending |
| MIT license | Permissive, standard for indie tools, encourages self-host adoption. | — Pending |
| English-only MVP, i18n structure ready | Indie scene is global; English maximizes reach; structure ready when contributors add locales. | — Pending |
| Cloudflare Free + optional Tunnel | Free tier covers TLS/DDoS/WAF + Tunnel hides origin. Zero recurring infra cost. | — Pending |
| Envelope encryption (KEK in env, DEK per row) for secrets | A leaked DB without server env doesn't disclose secrets. | — Pending |
| Stack choice deferred to researcher | Author has no strong preference; standard 2025 multi-tenant SaaS stack will surface from research. | — Pending |
| Design via design.md workflow (Google Stitch + Claude Code) | Author wants to try this handoff style for UI phases. | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-27 after initialization*
