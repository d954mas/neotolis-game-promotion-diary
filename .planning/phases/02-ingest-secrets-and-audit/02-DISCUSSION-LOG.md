# Phase 2: Ingest, Secrets, and Audit - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in `02-CONTEXT.md` — this log preserves the alternatives considered.

**Date:** 2026-04-27
**Phase:** 02-ingest-secrets-and-audit
**Mode:** discuss (interactive)
**Areas discussed:** all 8 zones surfaced (Phase Scope, Secrets, Schema Model, URL Ingestion, Soft-Delete, Events, Audit UI + Privacy, UX Baseline)

---

## Initial Gray-Area Selection

Eight gray areas were surfaced; the user selected **all 8** ("все"), confirming the selection across both AskUserQuestion turns (zones 1–4 and zones 5–8).

| # | Zone |
|---|------|
| 1 | Secrets — write-once and rotation |
| 2 | URL ingestion UX |
| 3 | Game card + channels schema |
| 4 | Soft-delete + retention |
| 5 | Events vs tracked_items |
| 6 | Audit log UI |
| 7 | UX baseline |
| 8 | Phase scope and slicing |

Discussion proceeded zone-by-zone, starting with zone 8 (strategic — sets phase boundary), then 1, 3, 2, 4, 5, 6 + privacy fold, 7.

---

## Zone 8 — Phase Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Monolith (recommended) | Keep 21 REQs in P2; ~12 plans | ✓ |
| Move Reddit OAuth to P3 | KEYS-02 lands beside `poll.reddit` | (later folded in via subsequent zone) |
| P2 + P2.1 split | events + audit UI as 2.1 | |
| P2 without Steam + Reddit OAuth | KEYS-02 + KEYS-03 to P3 | |

**User's choice:** Monolith. **Note:** subsequent discussion in zone 1 reduced scope further — KEYS-01 and KEYS-02 both moved to Phase 3 (see zones 1 below).

---

## Zone 1 — Secrets

The discussion in zone 1 reframed scope: the user observed that Reddit's OAuth flow is structurally different from a paste-key UI ("выглядит как отдельный модуль задача") and decided to move KEYS-02 to Phase 3. Then surfaced two precise questions on YouTube and Steam.

### Sub-question — Is a YouTube key needed in Phase 2?

The user asked whether there is a free / public YouTube path that avoids the API key. Answer: oEmbed (no key) covers metadata for INGEST-02; `videos.list` for view counts requires the key. Conclusion: P2 uses oEmbed; KEYS-01 (paste UI) moves to Phase 3 alongside `poll.youtube`.

| Option | Description | Selected |
|--------|-------------|----------|
| Move KEYS-01 to P3 (recommended) | P2 ingest uses oEmbed; P3 adds paste UI | ✓ |
| Keep KEYS-01 in P2 | All key UIs in one phase | |
| Schema P2, UI P3 | Mixed split | |

### Sub-question — Steam key semantics

Confirmed via PROJECT.md: Steam Web API key is per Steamworks account (one per publisher account), not per game. `steam_app_id` is per game. Edge case raised by user: a publisher with multiple Steamworks accounts under one Google login. This changed the schema model (see zone 3).

### Sub-question — Write-once UX (rotation flow)

Question was deferred when the user asked to revisit the schema model first. Eventually resolved as **Replace in single form** in `02-CONTEXT.md` D-14 (one Replace button on the masked-key view; submit performs UPDATE in one tx with audit `key.rotate`).

### Sub-question — KEYS-05 in-flight worker invalidation

Resolved as a Phase 3 invariant: the worker MUST decrypt-per-job (anti-pattern AP-3); rotation is automatically picked up by the next job. Captured in `02-CONTEXT.md` D-15.

---

## Zone 3 — Game card + channels schema

This zone went through three distinct refinement passes driven by user clarifications.

### Pass 1 — Two-list model (initial proposal)

| Option | Description | Selected |
|--------|-------------|----------|
| Two-list (games + external_accounts) | Single `external_accounts` table, no UNIQUE on `(user_id, kind)` | (rejected mid-question) |
| Collapse M:N → 1:N | `games.steam_account_id` direct FK | |
| Other | User wanted to refine | ✓ |

User's clarification: *"А вот если есть аккаунт издателя ютуб. Он например хочет следит за своими видко и связанными играми. И Ютуб ключ, нужен для получения данных. По сути тогда 3 списка. Игры, аккаунты и ключи?"* — surfaced the channel-vs-key distinction.

### Pass 2 — Three-list model

| Option | Description | Selected |
|--------|-------------|----------|
| Three-list: games / social_accounts / api_keys (recommended) | Channels are public handles; api_keys are credentials; both linked to games separately | ✓ |
| Different naming | | |
| Split is_own into separate kind | | |
| Question on the model | | |

### Pass 3 — Game ↔ Platforms split (user clarification)

User's clarification: *"Так смотри. У игры может юбыть несколько платформ, и вот данные храним для именно стим платформы … Теги из стима, и других платформ. Важно каждая платформа хранит свои данные."* — drove the move of all per-store metadata from `games` to `game_steam_listings` (and future `game_itch_listings` etc.).

### Pass 4 — Typed-per-platform decision

User's clarification: *"Так а нормально ли хранить вот так. А не по отдельной таблице для каждой платформы. Тк данные могут быть разные."* — confirmed typed-per-kind for stores.

| Option | Description | Selected |
|--------|-------------|----------|
| Typed (game_steam_listings etc.) | One typed table per store kind | (subsumed by next question) |
| Hybrid (game_platforms + extras) | Common fields shared, specifics per kind | |
| JSONB blob | Generic with jsonb | |

### Pass 5 — Full typed-per-kind across all three lists

User's clarification: *"Так все платформы, аккаунты хранят данные отдельно. Тк данные могут быть разные."* — extended the typed-per-kind rule to social accounts and API keys.

| Option | Description | Selected |
|--------|-------------|----------|
| Full typed (recommended) | 13 tables in P2; future kinds = new tables | ✓ |
| Typed only platforms + keys | Social channels generic | |
| Reduce GAMES-04 scope | Defer Twitter / Discord channels to P3 | |
| Question | | |

### Pass 6 — Multi-listing per game (user edge case)

User's question: *"Что произойдет если пользовател А добавил игре стимА и стимБ. А пользователь Б Добавил игру стимВ м стимА"* — surfaced that one logical game can have multiple Steam app_ids (Demo + Full + DLC). Resolved in `UNIQUE(game_id, app_id)` + `UNIQUE(user_id, app_id)`.

| Option | Description | Selected |
|--------|-------------|----------|
| Multi-listing (recommended) | UNIQUE(game_id, app_id) | ✓ |
| Strict one-listing-per-game | UNIQUE(game_id) | |
| Question | | |

### Pass 7 — Cover and tags

User's clarification (folded into D-G3..D-G6 in CONTEXT.md): metadata is per-platform, fetched via Steam appdetails (public, no key), stored in `raw_appdetails jsonb` for forensic refresh.

---

## Zone 2 — URL Ingestion

### Sub-question — Paste-box vs typed forms

| Option | Description | Selected |
|--------|-------------|----------|
| Global paste-box (recommended) | URL parser routes to right table | ✓ |
| Typed forms | "Add Reddit post" / "Add YouTube video" buttons | |
| Paste-box + own/blogger toggle | Manual flag at ingest | |

### Sub-question — own/blogger detection for YouTube

| Option | Description | Selected |
|--------|-------------|----------|
| Auto via youtube_channels.is_own (recommended) | Look up channel_id from oEmbed | ✓ |
| Always default 'blogger' | User flips to own | |
| Ask explicitly on the form | | |

---

## Zone 4 — Soft-Delete + Retention

### Sub-question — Retention window

| Option | Description | Selected |
|--------|-------------|----------|
| 30 days (recommended) | SaaS standard | |
| 60 days | More forgiving | ✓ |
| 90 days | GDPR-style | |
| 7 days | Undo only | |

### Sub-question — Cascade behaviour on children

| Option | Description | Selected |
|--------|-------------|----------|
| Soft-cascade (recommended) | deleted_at propagates; restore is transactional | ✓ |
| Hard-cascade | Children deleted immediately | |
| Soft for content, unlink for shared | api_keys + social_accounts only unlink | |

### Sub-question — Multi-tenant edge case (user follow-up)

User's question: *"Я издатель, добавил все ключи, игру и тд, собрал кучу данных. А затем новый пользователь, просто добавил мою игру как свою, без указания стим ключа."* — confirmed the model handles this correctly: multi-tenant isolation (Pattern 1) means two users can register the same `app_id` without ever seeing each other's data. Possible storage optimisation (`steam_app_metadata_cache`) deferred to Phase 6.

User's follow-up: *"Так и вот про приватность. Это важно и должно быть в agents.md что данные пользователя, все собираем на пользолвателя."* — drove the AGENTS.md uplift in zone 6 / D-36.

---

## Zone 5 — Events vs tracked_items

### Sub-question — Twitter URL behaviour

| Option | Description | Selected |
|--------|-------------|----------|
| Auto → events row (recommended) | URL parser routes Twitter / t.me to events | ✓ |
| Reject | "URL not yet supported" | |
| Auto + confirm modal | "Add as event?" modal | |

User asked whether the same scoping behaviour applies to all data types — confirmed via the matrix in `02-CONTEXT.md` (zone 6 fold) that everything is tenant-scoped except explicit `shared` resources (`subreddit_rules` in P5, future `steam_app_metadata_cache` in P6).

### Sub-question — Event categories

| Option | Description | Selected |
|--------|-------------|----------|
| Closed picklist (recommended) | Postgres enum | ✓ |
| Free-text | text column | |
| Picklist + tags | Hybrid | |

---

## Zone 6 — Audit Log UI + Privacy uplift

### Sub-question — Page size + filter

| Option | Description | Selected |
|--------|-------------|----------|
| 50 rows + action filter (recommended) | Cursor on (user_id, created_at desc) | ✓ |
| 20 rows, no filter | | |
| 100 rows + filter + search | | |

### Sub-question — `audit_log.metadata` for `key.*`

| Option | Description | Selected |
|--------|-------------|----------|
| kind + label + last4 (recommended) | Forensics-useful | ✓ |
| Only kind + key_id | | |
| kind + label + last4 + IP details | Redundant | |

### Sub-question — AGENTS.md privacy uplift (user-driven)

| Option | Description | Selected |
|--------|-------------|----------|
| Lock the extended block (recommended) | AGENTS.md gets full "Privacy & multi-tenancy" section in Wave 0 | ✓ |
| Adjust wording | | |
| Add "data residency" point | | |

---

## Zone 7 — UX Baseline

### Sub-question — Theme storage

| Option | Description | Selected |
|--------|-------------|----------|
| Cookie + DB persist (recommended) | SSR-flash-free; cross-device sync | ✓ |
| Cookie only | | |
| localStorage only | | |

### Sub-question — Empty-state copy storage

| Option | Description | Selected |
|--------|-------------|----------|
| messages/en.json (recommended) | Preserves Paraglide locale-add invariant | ✓ |
| Hardcoded in pages | Breaks P1 i18n invariant | |
| Central registry + JSON config | Duplicates Paraglide | |

---

## Final Confirmation

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, write CONTEXT.md (recommended) | Proceed to artefact creation | ✓ |
| Revisit a zone | | |

---

## Claude's Discretion (recorded for planner)

The planner picks during plan-phase:
- URL-parser entry-point file naming
- Postgres enums vs text + check-constraint for `events.kind` and `audit_log.action` (Drizzle 0.45 ergonomics)
- Modal vs inline-form for Replace-key
- Whether the global paste-box lives only on game-detail pages or also as a site-wide floating button
- Cursor encoding for `/api/audit`
- Generic-parametrised vs four typed services for the four `game_<kind>_channels` tables
- Number of Drizzle migrations (one combined vs many) for the 14-table change

## Deferred Ideas (carried into CONTEXT.md `<deferred>`)

- `steam_app_metadata_cache` — Phase 6
- Date-range filter in audit UI — Phase 6
- `api_keys_youtube` + `api_keys_reddit` tables and UI — Phase 3
- Purge worker — Phase 3
- User-private "campaign" tags — backlog
- Cover image upload — out of scope
- Itch / Epic / GOG store listings — Phase 3+
- Twitter / Telegram auto-tracking via API — already excluded by PROJECT.md

---

## Post-creation refinement (2026-04-27, after initial CONTEXT.md commit)

After 02-CONTEXT.md was first written and committed (835a8a7), the user proposed shrinking Phase 2 further with a "пример + паттерн, остальное позже" rule. Two follow-up exchanges:

### Exchange 1 — social handles

User: *"Так а вот про social давай создадим ютуб для примера сейчас. А остальное будем создавать когда будем добавлять новое."*

Question asked: "Telegram / Twitter / Discord соц-хэндлы — что с ними?"

| Option | Description | Selected |
|--------|-------------|----------|
| Полностью вынести (recommended) | Remove all three from P2; GAMES-04 splits into 04a (YT, P2) + 04b/c/d (backlog) | ✓ |
| Phase 2.1 | Decimal phase to add the missing kinds soon | |
| Phase 3+ by trigger | Distribute across phases | |

### Exchange 2 — extend rule to all lists

User: *"Да и про остальное тоже. Делаем пример, чтобы было понимание и паттер. Остальное позже."*

This generalised the rule. Affected decisions:

- **D-07 — Social handles:** P2 ships only `youtube_channels` + `game_youtube_channels`. `telegram_channels`, `twitter_handles`, `discord_invites` deferred to backlog by trigger (DV-8: GAMES-04 split).
- **D-09 — Tracked items:** P2 ships only `tracked_youtube_videos`. `tracked_reddit_posts` deferred to Phase 3 alongside `poll.reddit` (DV-7: INGEST-01 → P3).
- **D-11 — Schema scope:** 14 tables → **7 tables**.

Question asked: "Фиксируем «пример + паттерн» финал: 7 таблиц (Steam-only, YouTube-only social, YouTube-only ingest)? Reddit ingest + Reddit OAuth уезжают в Phase 3."

| Option | Description | Selected |
|--------|-------------|----------|
| Да, фиксируем (recommended) | Rewrite CONTEXT.md with shrunk scope; REQUIREMENTS / ROADMAP updated in Wave 0 | ✓ |
| Keep Reddit ingest in P2 | INGEST-01 stays | |
| Question | | |

### Exchange 3 — terminology check (mid-edit)

User: *"Tracked items │ tracked_youtube_videos │ tracked_reddit_posts → P3 (рядом с poll-reddit; ingest и polling вместе) вот это что? что за tracked таблица? это то что мы потом проверяем? получаем данные? это тоже на каждого пользователя свое?"*

Confirmed in the assistant's reply and folded into D-09:
- `tracked_*` tables are per-user (Pattern 1: tenant-scoping with `user_id NOT NULL`).
- Two users registering the same `video_id` produce two independent rows.
- Polling in Phase 3 reads each row separately and writes to `metric_snapshots` (also per-user).
- The `tracked_` naming follows `ARCHITECTURE.md` "Pattern 2: Snapshot-and-Forward" — these are the entities we periodically poll for time-series metrics.

### Final question — naming check

| Option | Description | Selected |
|--------|-------------|----------|
| Да, продолжай (recommended) | Keep `tracked_youtube_videos` naming | ✓ |
| Rename to monitored_* / watched_* / game_youtube_videos | | |
| More questions on schema | | |

### New deviations recorded after refinement

- **DV-7:** INGEST-01 (Reddit URL ingest) Phase 2 → Phase 3.
- **DV-8:** GAMES-04 splits into GAMES-04a (P2, YouTube) + GAMES-04b/c/d (backlog by trigger).

### Final P2 shape (post-refinement)

- 7 tables (was 14)
- 16 distinct REQ-IDs (was 19)
- ~10–11 plans (was ~13–14)
