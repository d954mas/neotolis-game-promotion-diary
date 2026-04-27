# Phase 2: Ingest, Secrets, and Audit - Context

**Gathered:** 2026-04-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Ship the spreadsheet-replacement product end-to-end **without** the polling worker. After this phase a developer can:

- Create game cards (title, notes, soft-delete with retention) and attach Steam store listings (multi-listing per game: Demo + Full + DLC).
- Manage three independent top-level lists per user: **games**, **social accounts** (own + blogger YouTube/Telegram/Twitter/Discord handles), and **API keys** (Steam-only in P2).
- Paste Reddit post or YouTube video URLs to register tracked items; paste Twitter or Telegram URLs to register free-form timeline events; create conference / talk / press events manually.
- Save a Steam Web API key with envelope-encrypted write-once UI (rotate / remove with audit).
- View their own audit log (logins, key add / rotate / remove, item create / delete, event create / edit / delete, game create / delete) — paginated, owner-only, tenant-relative cursor.
- Use the product on a 360 px-wide phone, with cookie-driven dark / light mode that persists across devices via a `user.theme_preference` column.

The polling worker, all wishlist auto-fetch (WISH-03), the YouTube key UI, and the Reddit OAuth dance live in **Phase 3**. The audit-log writer infrastructure was already shipped in Phase 1; Phase 2 extends the `action` vocabulary and adds the read endpoint + UI.

**Phase 2 smoke extension (per ROADMAP, 2026-04-27):** CI self-host smoke test additionally exercises "user A creates a game" via `/api/games`; cross-tenant matrix expands from `/api/me` sentinel to every new `/api/*` route added in this phase, asserting 404 (never 403, never 200).

**Coverage update:** REQUIREMENTS.md traceability moves `KEYS-01` (YouTube API key UI) and `KEYS-02` (Reddit OAuth flow) from Phase 2 to Phase 3 — both naturally land beside their poll adapter. Phase 2 covers **19 of 21 originally listed REQs** (GAMES-01..04, KEYS-03..06, INGEST-01..04, EVENTS-01..03, PRIV-02, UX-01, UX-02, UX-03). The traceability table in REQUIREMENTS.md is updated in the first Wave 0 commit of Phase 2.

</domain>

<decisions>
## Implementation Decisions

### Phase Scope (zone 8)

- **D-01 — P2 ships as a monolith on 19 REQs.** No 2.x split. Estimated ~13–14 plans organised in waves (test scaffolding → schema migrations → services → HTTP routes → UI pages → smoke extensions). The two "easy outs" (decimal phase for events / audit UI) are explicitly rejected because every shipped surface piggy-backs on the same `audit_log` and tenant-scope plumbing — splitting would just duplicate Wave 0.
- **D-02 — KEYS-01 (YouTube API key UI) moves from Phase 2 → Phase 3.** The key only matters when `videos.list` runs; INGEST-02 in P2 does metadata validation through public **oEmbed** (`youtube.com/oembed?url=…&format=json`) which needs no key and no quota. View-count tracking and the paste UI land together in Phase 3 beside `poll.youtube`. Saves ~2 plans in P2 and avoids "user pasted a key but nothing exercises it for weeks".
- **D-03 — KEYS-02 (Reddit OAuth flow) moves from Phase 2 → Phase 3.** Reddit credentials are three values (`client_id`, `client_secret`, `refresh_token`), require a full redirect dance through `https://www.reddit.com/api/v1/authorize`, and live behind Better Auth's `genericOAuth` plugin or a hand-rolled callback. Without a Reddit polling worker the credentials sit unused, so they land beside `poll.reddit` adapter. Saves ~3 plans in P2.
- **D-04 — REQUIREMENTS.md traceability is updated in Wave 0 of Phase 2.** First commit of the phase moves `KEYS-01 | Phase 2` → `KEYS-01 | Phase 3` and `KEYS-02 | Phase 2` → `KEYS-02 | Phase 3`. Phase 2 row in the coverage-by-phase table changes from 21 to 19. Phase 3 row changes from 9 to 11.

### Schema Model — three-list typed-per-kind (zones 1 + 3)

- **D-05 — User has three independent top-level lists.** This is the developer's mental model: an indie dev keeps a list of *games*, a list of *social handles* (own and blogger), and a list of *API keys*. They are linked by explicit join tables, not implicit "credentials embedded in game".
- **D-06 — Store platforms are typed-per-kind, not generic.** Different stores carry different fields (Steam: app_id + community tags + Steam categories; future Itch: slug + jam_id + price tiers; future Epic: namespace + product_id). Phase 2 lands one typed table — `game_steam_listings` — and future stores arrive as new typed tables (`game_itch_listings`, `game_epic_listings`) without an enum overload or jsonb blob. This is the explicit drift from `ARCHITECTURE.md` §"Storage Shape" which sketched a single `tracked_items.platform` enum; that drift was the user's call (2026-04-27 discussion: "разные платформы хранят разные данные").
- **D-07 — Social-handle tables are typed-per-kind.** `youtube_channels`, `telegram_channels`, `twitter_handles`, `discord_invites` — four tables, four typed schemas. Channel-name caches, follower / subscriber counts, custom URLs — these differ by platform and are columns, not jsonb. M:N to games via four `game_<kind>_channels` tables (each with its own `is_own boolean` where applicable; Discord drops the flag because Discord servers are always "ours" in this model).
- **D-08 — API-key tables are typed-per-kind.** `api_keys_steam` ships in P2; `api_keys_youtube` and `api_keys_reddit` ship in P3. Reddit's table carries **three** ciphertext column-sets (one each for `client_id` / `client_secret` / `refresh_token`) — no JSON-blob inside one ciphertext. This isolates rotation semantics per credential and keeps `last4` honest.
- **D-09 — Tracked items are also typed-per-kind for consistency.** `tracked_reddit_posts` and `tracked_youtube_videos` ship in P2 (schema only — polling lands in P3). Generic `tracked_items` would still work since polling fields *are* uniform, but typed-per-kind is consistent with everything else in the model and lets per-platform indexes (e.g. `tracked_reddit_posts(subreddit)`) live naturally. `metric_snapshots` (Phase 3) stays generic because the time-series row shape genuinely is uniform.
- **D-10 — Multi-listing per game.** `game_steam_listings UNIQUE(game_id, app_id)` (multiple Steam apps per logical game: Demo + Full + DLC + Soundtrack); `UNIQUE(user_id, app_id)` defends against accidental dupes within one user's account. Wishlist polling in P3 keys on the listing row, so each app gets its own snapshot stream.
- **D-11 — Phase 2 lands 14 new tables.** Final list:
  1. `games`
  2. `game_steam_listings`
  3. `youtube_channels` 4. `telegram_channels` 5. `twitter_handles` 6. `discord_invites`
  7. `game_youtube_channels` 8. `game_telegram_channels` 9. `game_twitter_handles` 10. `game_discord_invites`
  11. `api_keys_steam`
  12. `tracked_reddit_posts` 13. `tracked_youtube_videos`
  14. `events`

  Plus: `audit_log.action` enum extends with `key.*`, `game.*`, `item.*`, `event.*`, `theme.*`. A new column `user.theme_preference text` (default `'system'`) lands on Better Auth's `user` table.

### Secrets — Steam only in P2 (zone 1)

- **D-12 — `api_keys_steam` rows carry envelope-encrypted ciphertext.** Schema follows `EncryptedSecret` from `src/lib/server/crypto/envelope.ts`: `secret_ct`, `secret_iv`, `secret_tag`, `wrapped_dek`, `dek_iv`, `dek_tag`, `kek_version`. Plus user-visible columns: `label text` (e.g. "Studio A Steam"), `last4 text` (last four chars for UI mask), `created_at`, `updated_at`, `rotated_at?`. Plus `user_id`, `id` (UUIDv7).
- **D-13 — One Steam-key row per Steamworks account, linked per-listing.** `game_steam_listings.api_key_id` is the FK that says "this Steam listing's wishlist is polled by this key". A publisher with two Steamworks accounts has two `api_keys_steam` rows; each `game_steam_listings` row points at one. A solo dev with one key has one `api_keys_steam` row and every `game_steam_listings` row points at it.
- **D-14 — Write-once UI = single Replace form.** When a Steam key already exists for the user the settings page shows `••••••••XYZW` plus a Replace button. Replace opens the same paste form; submit performs an UPDATE in one tx with an audit `key.rotate` row. The previous ciphertext is overwritten — there is no in-process secret cache to invalidate (anti-pattern AP-3 in `ARCHITECTURE.md`), so KEYS-05 invalidation is a free side effect for the future Phase 3 worker that re-decrypts per job.
- **D-15 — KEYS-05 "rotation invalidates in-flight worker jobs" is captured as a Phase 3 invariant.** The text in `02-CONTEXT.md` and the corresponding Phase 3 plan-checker assertion: **the worker MUST decrypt per job; no process-local plaintext-secret cache.** The next job after rotation reads the new ciphertext automatically. Audit log records `key.rotate` with `last4` of the new key in metadata.
- **D-16 — INGEST-02 validation uses oEmbed, not the YouTube API key.** `GET https://www.youtube.com/oembed?url=<videoUrl>&format=json` returns title, author_name, thumbnail_url with no key and no quota. Phase 2 ingest validates the URL, parses the video id, populates `tracked_youtube_videos.title` and `tracked_youtube_videos.channel_id` (to drive the own/blogger auto-decision in D-21). View counts arrive in Phase 3.
- **D-17 — Steam key validation = one test call before persist.** When the user pastes a key, the secrets service makes one outbound call to `IWishlistService/GetWishlistItemCount/v1/?key=…&steamid=0` (or another low-cost endpoint that exercises the key without leaking other data) — non-2xx = 422 to user, do not persist. Catches typos at write time.

### URL Ingestion (zone 2)

- **D-18 — Single global paste-box on each game page.** One input labelled "Paste a URL". The URL parser (`src/lib/server/services/url-parser.ts`) inspects the host:
  - `reddit.com` / `redd.it` → resolve to canonical `https://reddit.com/r/<sub>/comments/<id>/...` → create `tracked_reddit_posts` row
  - `youtube.com` / `youtu.be` → resolve to canonical `https://youtube.com/watch?v=<id>` → fetch oEmbed → create `tracked_youtube_videos` row
  - `twitter.com` / `x.com` → create `events` row (`kind='twitter_post'`); use `https://publish.twitter.com/oembed` for preview text/handle
  - `t.me` → create `events` row (`kind='telegram_post'`)
  - any other host → reject inline with "URL not yet supported — try Reddit, YouTube, Twitter, or Telegram. Add as a free-form event."
- **D-19 — INGEST-04 invariant: malformed → reject inline + never half-write.** All `tracked_*_*` and `events` services run validation FIRST and return early with an `AppError` (typed); the INSERT happens only after validation passes. No `try/catch` after `insert(...)` that "cleans up". Tested in `tests/integration/ingest.test.ts` via fault-injection (parser throws after partial state populated → assert no row exists in any table).
- **D-20 — Tracked-item rows carry user_id (denormalised).** Same rationale as `metric_snapshots.user_id` from `ARCHITECTURE.md`: workers in P3 read tracked-item rows by id and re-assert ownership without joining `games`. PITFALL P1 (cross-tenant via job-payload tampering).
- **D-21 — own/blogger auto-decision via `youtube_channels.is_own`.** When ingesting a YouTube video, the parser pulls `author_url` from oEmbed → resolves to `channel_id` → looks up `youtube_channels WHERE user_id=? AND channel_id=?`. If row exists with `is_own=true` → set `tracked_youtube_videos.is_own=true`. Otherwise default `is_own=false` (blogger). User can toggle later on the item page (INGEST-03 "toggle later").

### Soft-Delete + Retention (zone 4)

- **D-22 — Retention window = 60 days, configurable via `RETENTION_DAYS` env.** Default in `.env.example` is `60`. Self-host operators may set their own.
- **D-23 — Soft-cascade with transactional restore.** When a `games` row is soft-deleted (`deleted_at = now()`), all of its children inherit the same `deleted_at` value in one tx: `game_steam_listings`, `game_youtube_channels` / `game_telegram_channels` / `game_twitter_handles` / `game_discord_invites`, `tracked_reddit_posts`, `tracked_youtube_videos`, `events`. Restore reverses the same set in one tx (`deleted_at = NULL` only on rows whose `deleted_at = parent.deleted_at`). This means a row that was already soft-deleted before the parent stays deleted on parent restore.
- **D-24 — `social_accounts` (`youtube_channels` etc.) and `api_keys_steam` are NOT cascaded.** They live at user level and are reused across games. Deleting a game removes only the `game_<kind>_channels` link rows, never the underlying social-account row.
- **D-25 — Purge worker is a Phase 3 deferral.** Phase 2 has no scheduler / cron / pg-boss handler (those land in Phase 3). The purge implementation in P3 is a single recurring job that hard-deletes rows where `deleted_at < now() - RETENTION_DAYS::interval`. Phase 2 ships only the `deleted_at` column + restore UI + an audit `*.deleted` action; the badge "scheduled for purge in N days" is computed from `deleted_at` at read time.
- **D-26 — Multi-tenant edge case: two users register the same `app_id`.** Already handled by Pattern 1 (`userId` filter on every query) — both users get independent rows in `game_steam_listings`, independent api-key links, independent `tracked_*_*` rows, independent `metric_snapshots` (P3). The `appdetails` payload is fetched twice (once per user). A shared metadata cache (`steam_app_metadata_cache`) is a Phase 6 deferred optimisation.

### Events (zone 5)

- **D-27 — `events` table is separate from `tracked_*_*`.** Different concerns: `tracked_*_*` carries items that get polled by an external API; `events` is a free-form timeline entry that never polls. They join into the same per-game timeline view via the route handler in P4, not via a discriminator column.
- **D-28 — `events.kind` is a Postgres enum closed picklist.** Values: `'conference'`, `'talk'`, `'twitter_post'`, `'telegram_post'`, `'discord_drop'`, `'press'`, `'other'`. UI: dropdown in the create-event form; each kind renders a different icon in the timeline (P4).
- **D-29 — Twitter / Telegram URL pasted into the global paste-box auto-creates an `events` row.** D-18 already handles routing. The implementation reuses `events` service for INSERT; oEmbed (`publish.twitter.com/oembed`, no auth needed) provides preview text and author handle for `events.title` / `events.notes`. No polling, ever.
- **D-30 — `events` columns:** `id (uuidv7)`, `user_id`, `game_id`, `kind`, `occurred_at timestamptz`, `title`, `url?`, `notes?`, `created_at`, `updated_at`, `deleted_at?`. `EVENTS-03` audits `event.created`, `event.edited`, `event.deleted` via the existing P1 audit writer.

### Audit Log (zone 6)

- **D-31 — `/api/audit` returns 50 rows per page with cursor pagination on `(user_id, created_at desc)`.** The cursor is `(created_at, id)` Base64-encoded; tenant-relative by construction (PITFALL P19). Page size is fixed at 50 in P2. Future tunable in P6.
- **D-32 — Dropdown filter by `action` value.** Valid values exposed in UI: `all`, `session.signin`, `session.signout`, `session.signout_all`, `key.add`, `key.rotate`, `key.remove`, `game.created`, `game.deleted`, `game.restored`, `item.created`, `item.deleted`, `event.created`, `event.edited`, `event.deleted`, `theme.changed`. The full list lives in `src/lib/server/audit/actions.ts` as a const enum so plan-phase / planner can extend it phase-by-phase without drift.
- **D-33 — Date-range filter is deferred to Phase 6.** P6 polish phase already touches the audit log surface.
- **D-34 — `audit_log.metadata` for `key.add` / `key.rotate` / `key.remove`:** `{kind: 'steam'|'youtube'|'reddit', key_id: uuid, label: string, last4: string}`. `last4` is NOT a secret (already exposed in the secrets settings UI as the masked tail) — including it in audit metadata is the explicit forensics path so a leaked-key incident can identify which key was leaked. Pino redact rules already cover anything secret-shaped (`*.apiKey`, `*.access_token`, etc.); adding `last4` does not trip them because the key is the last4 string itself, not "a secret".
- **D-35 — `/api/audit` is in `MUST_BE_PROTECTED`.** Anonymous-401 sweep covers it; cross-tenant integration test asserts user A's `/api/audit?cursor=...` cannot ever surface a row owned by user B.

### Privacy & Multi-Tenancy (zone 6 fold + AGENTS.md uplift)

- **D-36 — AGENTS.md gets an extended "Privacy & multi-tenancy" block in Wave 0 of Phase 2.** Replaces the current single line "Privacy: private by default. No public dashboards. All data scoped to user_id." with the full block reproduced below. The block is non-negotiable for every future phase.
- **D-37 — Each new P2 table carries `user_id text NOT NULL` indexed.** Cross-tenant integration test (`tests/integration/tenant-scope.test.ts`) extends to every new endpoint: `/api/games`, `/api/games/:id`, `/api/games/:gameId/listings`, `/api/games/:gameId/listings/:listingId`, `/api/social-accounts/<kind>`, `/api/social-accounts/<kind>/:id`, `/api/games/:gameId/social-links/<kind>`, `/api/api-keys/steam`, `/api/api-keys/steam/:id`, `/api/items/reddit`, `/api/items/reddit/:id`, `/api/items/youtube`, `/api/items/youtube/:id`, `/api/events`, `/api/events/:id`, `/api/audit`. Cross-tenant access returns 404 (NotFoundError), never 403.
- **D-38 — ESLint rule `no-unfiltered-tenant-query`** lands as a Wave 0 task (alongside the AGENTS.md uplift). AST-walks Drizzle calls; rejects `db.select().from(<TENANT_TABLE>)` / `db.update(<TENANT_TABLE>)` / `db.delete(<TENANT_TABLE>)` without a `.where(...)` clause that references `userId`. Allowlist of shared tables: `subreddit_rules` (Phase 5), `pgboss.*` (Phase 3), and Better Auth core (`user`, `session`, `account`, `verification`). Each allowlist entry has a one-line comment explaining why.
- **D-39 — DTO discipline extends with new tables.** `src/lib/server/dto.ts` projection functions for every new tenant-owned entity (`toGameDto`, `toGameSteamListingDto`, `toYoutubeChannelDto`, …, `toApiKeySteamDto`, `toRedditPostDto`, `toYoutubeVideoDto`, `toEventDto`, `toAuditEntryDto`). `toApiKeySteamDto` strips every ciphertext column AND `kek_version` — only `{id, label, last4, created_at, updated_at, rotated_at}` survives. Behavioural test in `tests/unit/dto.test.ts` asserts the strip happens at runtime.

### UX Baseline (zone 7)

- **D-40 — Theme = cookie + DB persist with SSR-flash mitigation.** Storage layers:
  1. `__theme` cookie (`light` / `dark` / `system`, default `system` if absent). Read in `src/hooks.server.ts` before SvelteKit handler runs; passed into `event.locals.theme` so `+layout.svelte` renders the right CSS class on the SSR root element. No flash.
  2. `user.theme_preference text` column on Better Auth's `user` table (default `'system'`). When the user signs in, server reconciles cookie ↔ DB: cookie wins if both exist (last touched), otherwise hydrate cookie from DB. Sync across devices.
  3. JS toggle in header + settings page; `POST /api/me/theme` updates both cookie and DB.
- **D-41 — Empty-state copy lives in `messages/en.json` (Paraglide).** Each empty-state component takes a `key` prop; the route page passes a route-specific key like `m.empty_games_example_url()`, `m.empty_items_example_reddit_url()`, `m.empty_events_example()`. Six to eight new keys land in `messages/en.json`. The P1 invariant ("locale-add is content-only") is preserved.
- **D-42 — UX-02 (360 px viewport) is a hard requirement.** Every new route in P2 has a vitest browser test (or visual snapshot if planner picks Playwright in P2) at 360 px width that asserts: no horizontal scroll, every primary action is reachable without zoom, every chart placeholder reflows. plan-checker enforces this.
- **D-43 — UX-03 example URLs are real but inert.** Empty-state placeholders show URLs like `https://reddit.com/r/IndieDev/comments/abc123/...` and `https://youtube.com/watch?v=dQw4w9WgXcQ` styled in monospace; clicking them does nothing (UX-only). The "next action" CTA opens the paste box with focus.

### Claude's Discretion (planner picks)

- Exact name of the URL-parser entry point (`urlParser.ts` vs `url-parser/index.ts` vs `services/ingest.ts`).
- Whether to ship Drizzle enums for `events.kind` and `audit_log.action` as Postgres enums OR text + check-constraint (planner picks based on Drizzle 0.45 ergonomics; Postgres enum has migration friction).
- Exact modal vs inline-form decision for "Replace key" — both fit D-14; planner picks based on simplicity.
- Whether the global paste-box lives on the game-detail page only, or also on a "+ Add" floating button site-wide. Both meet INGEST-01..04.
- Cursor encoding format for `/api/audit` — base64 of `(created_at, id)` or jose-style JWT-no-sig. Planner picks.
- Whether the four `game_<kind>_channels` link tables share a generic service (parametrised by kind) or get four typed services. Hinging on TS ergonomics; planner picks.
- Whether Wave 0 lands all 14 migrations as one Drizzle generate or twelve. Planner picks based on Drizzle 0.45's atomic-migration story.

### Folded Todos

None — `gsd-tools todo match-phase 2` returned zero matches at discussion time (2026-04-27).

</decisions>

<deviations>
## Decision Deviations Recorded During Discussion

These are explicit drifts from earlier locked context (`PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `01-foundation/01-CONTEXT.md`, `.planning/research/ARCHITECTURE.md`) that the user accepted on 2026-04-27. Future agents must treat them as authoritative refinements.

- **DV-1: REQUIREMENTS.md traceability for KEYS-01 / KEYS-02 moves Phase 2 → Phase 3.** Original mapping had both YouTube key and Reddit OAuth in Phase 2. Updated mapping puts each beside its poll adapter in Phase 3. The first Wave 0 task of Phase 2 edits the table in REQUIREMENTS.md, the coverage-by-phase row counts, and the Phase 2 / Phase 3 success criteria in ROADMAP.md.
- **DV-2: ARCHITECTURE.md ER schema drift — `secrets (user_id, kind) UNIQUE` becomes typed-per-kind tables.** ARCHITECTURE sketched a single `secrets` table with `(user_id, kind) UNIQUE` constraint. Phase 2 ships `api_keys_steam` (per-row, not per-kind-per-user) so an indie publisher with two Steamworks accounts can carry two keys. Future kinds (`api_keys_youtube`, `api_keys_reddit`) follow the same pattern in Phase 3. ARCHITECTURE.md "Storage Shape" section is updated by the same Wave 0 commit (or a follow-up doc PR — planner picks).
- **DV-3: ARCHITECTURE.md ER schema drift — `tracked_items` becomes `tracked_reddit_posts` + `tracked_youtube_videos`.** Original sketch had a single `tracked_items.platform` enum. Discussion (2026-04-27) made the user's "разные данные" rule global: typed tables wherever per-platform fields differ. `metric_snapshots` (Phase 3) stays generic because the time-series shape is uniform.
- **DV-4: ARCHITECTURE.md ER schema drift — game-attached "channels" are typed.** `youtube_channels`, `telegram_channels`, `twitter_handles`, `discord_invites` plus four `game_<kind>_channels` link tables. Originally implied as a single `game_subreddits`-style table with `kind`. Same rationale.
- **DV-5: ROADMAP Phase 2 success criterion #3 narrows to Steam-only secrets in P2.** The original text "User saves a YouTube API key, authorizes Reddit OAuth, and optionally saves a Steam Web API key" is split: P2 covers Steam; P3 covers YouTube + Reddit. Phase 2 acceptance check verifies write-once + rotate + audit for `kind='steam'` only. Phase 3 acceptance extends to the other two.
- **DV-6: AGENTS.md gets a strengthened "Privacy & multi-tenancy" block in Wave 0 of Phase 2.** This is an uplift, not a behavioural change — every constraint named in the new block is already enforced by Phase 1 code. The block makes the constraints visible and reviewable for future phases.

</deviations>

<canonical_refs>
## Canonical References

**Downstream agents (researcher, planner, checker, executor) MUST read these before doing their work.**

### Project context

- `.planning/PROJECT.md` — locked product context, Google-OAuth-only auth, indie-budget constraint, Steam Web API key risk model, distribution model (SaaS + open-source self-host on one image).
- `.planning/REQUIREMENTS.md` — REQ-IDs in scope for Phase 2: GAMES-01..04, KEYS-03..06, INGEST-01..04, EVENTS-01..03, PRIV-02, UX-01..03. Note: KEYS-01 and KEYS-02 are deviated to Phase 3 by D-02 / D-03 above.
- `.planning/ROADMAP.md` §"Phase 2: Ingest, Secrets, and Audit" — phase goal, six success criteria, Phase 2 smoke extension.
- `AGENTS.md` (root) — non-negotiable constraints (auth, privacy, secrets at rest, transport, budget, OSS parity, license). The "Privacy & multi-tenancy" section is uplifted in Wave 0 of Phase 2; downstream agents read the *post-Wave-0* version.

### Research (read before planning)

- `.planning/research/STACK.md` — locked versions for Hono / SvelteKit / Drizzle / pg-boss / Better Auth / Paraglide / Pino / Vitest. Phase 2 introduces no new top-level deps; planner verifies before adding any.
- `.planning/research/ARCHITECTURE.md` §"Pattern 1 (Tenant Scope)" — the single most load-bearing pattern in this phase; §"Pattern 4 (Envelope Encryption)" — `api_keys_steam` row layout follows this; §"Storage Shape (ER Outline)" — starting point, but read DV-2 / DV-3 / DV-4 above for the typed-per-kind drift; §"Data Flow A" (paste YouTube URL) and §"Data Flow C" (rotate Steam key) — informative for INGEST + secrets services.
- `.planning/research/PITFALLS.md` — P1 (cross-tenant data leak; Pattern 1 + cross-tenant test), P2 (KEK leakage; already mitigated in P1, do not re-introduce env reads outside `config/env.ts`), P3 (DTO discipline; extend per D-39), P13 (self-host parity rot; smoke test extension is the gate), P19 (audit log scoping; already-honoured tenant-relative cursor — extend), P14 (AGPL contamination; planner verifies any new dep).
- `.planning/phases/01-foundation/01-CONTEXT.md` — Phase 1 locked decisions Phase 2 inherits: D-06 UUIDv7, D-09..D-11 envelope encryption module, D-19 / D-20 trusted-proxy + audit IP, D-23 / D-24 Pino redact, the `tenantScope` middleware, the `NotFoundError` (404-not-403) policy, the anonymous-401 sweep, the cross-tenant integration test. Read the `<deviations>` block too — D-13 mechanism update (oauth2-mock-server) and Phase 1 DEPLOY-05 scope deferral both inform Phase 2 smoke extension.

### Code (already shipped in Phase 1, reused in Phase 2)

- `src/lib/server/crypto/envelope.ts` — `encryptSecret`, `decryptSecret`, `rotateDek`. Phase 2's `api_keys_steam` service calls these directly. Do not re-implement.
- `src/lib/server/audit.ts` — `writeAudit({userId, action, ipAddress, userAgent, metadata})`. Phase 2 only extends the `action` enum (D-32) and adds the read service.
- `src/lib/server/db/schema/audit-log.ts` — schema; do not modify the table shape, only extend the action vocabulary.
- `src/lib/server/services/errors.ts` — `NotFoundError` (cross-tenant 404), `ForbiddenError` (reserved). Phase 2 services throw `NotFoundError` exclusively for tenant-owned resources.
- `src/lib/server/http/middleware/tenant.ts` — `tenantScope` middleware. Every new `/api/*` route in Phase 2 mounts under this.
- `src/lib/server/http/middleware/proxy-trust.ts` — resolves `event.locals.clientIp`. `audit.ipAddress` is taken from here, never from raw headers.
- `src/lib/server/dto.ts` — projection functions strip secret-shaped fields. Phase 2 extends per D-39.
- `src/lib/server/http/app.ts` — Hono app composition. `MUST_BE_PROTECTED` array in `tests/integration/auth-sweep.test.ts` extends with every new `/api/*` route per D-37.
- `src/lib/server/db/client.ts`, `src/lib/server/db/migrate.ts`, `src/lib/server/db/schema/index.ts` — Drizzle plumbing; Phase 2 adds 14 new schema files in `src/lib/server/db/schema/`, registers them in the barrel re-export.
- `messages/en.json`, `project.inlang/settings.json`, `src/lib/paraglide/` — Paraglide JS 2 wiring; Phase 2 adds ~6–8 new keys per D-41 without changing the wiring.
- `tests/integration/tenant-scope.test.ts`, `tests/integration/auth-sweep.test.ts` — Phase 2 extends both per D-37.

### External (verify versions during planning)

- Steam Web API — `IWishlistService/GetWishlistItemCount` (https://partner.steamgames.com/doc/webapi/IWishlistService) — used for D-17 paste-time validation; same endpoint used in P3 for daily polling.
- Steam appdetails — `https://store.steampowered.com/api/appdetails?appids=…` — public, no key, response shape used to populate `game_steam_listings.cover_url`, `release_date`, `genres`, `steam_tags`, `raw_appdetails`.
- YouTube oEmbed — `https://www.youtube.com/oembed?url=…&format=json` — public, no key, used for INGEST-02 metadata in P2; also used in D-21 to extract `channel_id` for own/blogger detection.
- Twitter / X oEmbed — `https://publish.twitter.com/oembed?url=…&omit_script=1` — public, no key, used for `events kind='twitter_post'` preview text.
- Drizzle ORM 0.45 — https://orm.drizzle.team/docs/ — Postgres enum vs check-constraint syntax informs Claude's Discretion entry on `events.kind` / `audit_log.action`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **Envelope encryption module** — `src/lib/server/crypto/envelope.ts` is fully tested (Phase 1 plan 01-04). Phase 2's `api_keys_steam` service calls `encryptSecret(plaintext)` on write, `decryptSecret(s)` on read (only path: D-17 validation), `rotateDek(s, newVersion)` on KEK rotation. Plaintext lives only inside the function scope; never logged (Pino redact at D-24).
- **Audit writer** — `src/lib/server/audit.ts` `writeAudit()` is INSERT-only and never throws. Phase 2 callers: `services/games.ts` (game.created/deleted/restored), `services/api-keys-steam.ts` (key.add/rotate/remove), `services/items-reddit.ts` and `services/items-youtube.ts` (item.created/deleted), `services/events.ts` (event.created/edited/deleted), `services/me.ts` (theme.changed via PATCH /api/me/theme).
- **Tenant scope middleware** — `src/lib/server/http/middleware/tenant.ts` already attaches `c.var.userId` and `c.var.sessionId`. Every new `/api/*` route in Phase 2 mounts under it.
- **NotFoundError** — `src/lib/server/services/errors.ts` is the cross-tenant carrier. Every Phase 2 service that fetches a tenant-owned row by id MUST throw this when the row is missing OR owned by another user. The HTTP boundary translates to 404 + `{error:'not_found'}`. Body never contains "forbidden" / "permission".
- **DTO projection** — `src/lib/server/dto.ts` `toUserDto()` is the template for new projections. Phase 2 adds one per entity (D-39); each strips ciphertext and `kek_version` columns.
- **UUIDv7 helper** — `src/lib/server/ids.ts` `uuidv7()`. Every primary key uses this default.
- **Trusted proxy + clientIp** — `src/lib/server/http/middleware/proxy-trust.ts` populates `c.var.clientIp`. Audit log uses this; do not read raw headers.
- **Drizzle barrel re-export** — `src/lib/server/db/schema/index.ts` — Phase 2 adds 14 new files and lists them here.
- **Pino logger + redact** — `src/lib/server/logger.ts` already redacts `apiKey`, `accessToken`, `refreshToken`, `idToken`, `secret`, `encrypted_*`, `wrapped_dek`, `dek`, `Authorization`, `Cookie`. Phase 2 introduces no new secret-shaped field names; `last4` is intentionally not redacted (D-34 forensics).

### Established Patterns (Phase 1 → Phase 2 inheritance)

- **`userId` first-arg in services.** Every new Phase 2 service file (`services/games.ts`, `services/api-keys-steam.ts`, `services/items-reddit.ts`, `services/items-youtube.ts`, `services/events.ts`, `services/youtube-channels.ts` etc.) starts every function signature with `userId: string`. Type system + ESLint rule (D-38) enforce.
- **`eq(table.userId, userId)` on every query.** Drizzle queries on the 14 new tables. ESLint rule rejects calls without it.
- **Cross-tenant 404, never 403.** Tested per route in `tenant-scope.test.ts`; bodies asserted not to contain "forbidden" / "permission".
- **Anonymous-401 sweep.** `MUST_BE_PROTECTED` array extends with every new `/api/*` route (D-37); CI fails the PR if a new route is missing.
- **Append-only audit log + tenant-relative cursor.** New `/api/audit` endpoint reads via `(user_id, created_at desc)` cursor; never observes another tenant's IDs by construction (PITFALL P19).
- **Strict env discipline.** `src/lib/server/config/env.ts` is the only file that reads `process.env`. Phase 2 adds `RETENTION_DAYS` (D-22) here and only here.
- **Single-source i18n.** All UI strings flow through `m.*()` Paraglide compiled functions (Phase 1 plan 01-09). Phase 2 adds ~6-8 new keys to `messages/en.json` per D-41.

### Integration Points

- **Hono app composition** — `src/lib/server/http/app.ts` extends `app.route('/api', ...)` with new sub-routers per entity. The order matters: `app.use('/api/*', tenantScope)` must remain BEFORE these new mounts (already in place from Phase 1).
- **SvelteKit pages** — `src/routes/` adds new directories: `games/`, `games/[gameId]/`, `games/[gameId]/listings/`, `accounts/`, `keys/`, `audit/`, `events/`. Each has `+page.svelte` (UI) and `+page.server.ts` (data loader calling `/api/*`).
- **`+layout.server.ts`** — extended to read `__theme` cookie and pass `event.locals.theme` into the layout (D-40).
- **Drizzle migrations** — `src/lib/server/db/schema/*.ts` files generate one `drizzle/<NN>_phase02_*.sql` migration (or several — planner picks; D-Discretion). Migration runs at boot under advisory lock from Phase 1.
- **CI workflow extension** — `.github/workflows/ci.yml` smoke job extends to: boot image with minimal env → sign in via oauth2-mock-server → POST `/api/games` (create) → GET `/api/games` (list) → assert cross-tenant 404 → assert anonymous 401 on every new route.

</code_context>

<specifics>
## Specific Ideas

- **"Three lists, not one bag."** The user's mental model is that a developer keeps three independent top-level lists: games, social handles, API keys. Linkage is explicit (M:N tables, FK columns), not implicit (credentials embedded in game). This is the load-bearing simplification of the schema and the reason the typed-per-kind tables exist instead of generic `secrets` / `tracked_items`.
- **"A publisher with two Steamworks accounts."** Concrete edge case the user raised that drove the model: indie publisher with two `api_keys_steam` rows, each labelled, each linked to different `game_steam_listings.api_key_id`. Multi-listing per game (Demo + Full + DLC + Soundtrack) is the same flexibility on the listing axis.
- **"Multi-tenant edge case is not a bug."** Two users registering the same `app_id` is correctly handled by Pattern 1 — both get independent rows, independent snapshots, independent audit logs. No "ownership stamping" needed; we are privacy-only, not a public catalog (PROJECT.md anti-feature). This came up explicitly in the discussion and is captured in D-26.
- **"Make privacy visible in AGENTS.md, not implicit."** The user's request that the privacy / multi-tenant invariants be lifted into AGENTS.md as a named, reviewable section is captured in D-36 / DV-6. This is uplift, not change — the rules already hold in code; this just makes them load-bearing for future agents.
- **"oEmbed is the free path."** YouTube and Twitter both expose oEmbed without a key. P2 uses YouTube oEmbed for D-16 (INGEST-02 validation + title) and D-21 (own/blogger via `author_url`). P2 uses Twitter oEmbed for D-29 (events preview). This keeps the indie-budget constraint honest — no quota burn until P3 actually needs `videos.list`.

</specifics>

<deferred>
## Deferred Ideas

These came up during discussion but are explicitly out of scope for Phase 2:

- **Shared Steam appdetails cache (`steam_app_metadata_cache`)** — Phase 6 storage optimisation. Avoids N copies of `raw_appdetails` when many users register the same `app_id`. Not needed at indie scale; deferred until storage actually hurts.
- **Date-range filter in audit-log UI** — Phase 6 polish phase. Page-size selector and search-by-metadata.last4 also Phase 6.
- **`api_keys_youtube` and `api_keys_reddit` tables + UI** — Phase 3, beside `poll.youtube` and `poll.reddit` adapters. Reddit OAuth flow (full redirect dance + 3-credential storage) particularly belongs there.
- **Purge worker (hard-delete after retention)** — Phase 3, runs as a recurring pg-boss job. Phase 2 ships only `deleted_at` + restore UI + scheduled-purge badge.
- **User-private "campaign" tags on `games`** — out of scope for P2; if needed later, lands as a separate phase or post-MVP backlog. Current model says all tags come from store platforms.
- **Cover image upload (file storage, R2 / S3 / volume)** — out of scope, indie-budget-constrained. Cover always comes from public Steam appdetails URL or future per-platform fetcher.
- **Per-game custom domains / white-label** — already excluded by PROJECT.md. Not revived.
- **Itch / Epic / GOG store listings** — out of scope for P2. Will arrive as new typed tables (`game_itch_listings`, etc.) when there is concrete demand.
- **Twitter / Telegram channel auto-tracking via API** — already excluded by PROJECT.md (Twitter API paid; Telegram Bot API privacy-invasive). Both stay manual via `events`.
- **Real-time wishlist counter / public dashboards / share links** — already excluded by PROJECT.md. Not revived.

### Reviewed Todos (not folded)

None — `gsd-tools todo match-phase 2` returned zero todos at discussion time.

</deferred>

---

*Phase: 02-ingest-secrets-and-audit*
*Context gathered: 2026-04-27*
