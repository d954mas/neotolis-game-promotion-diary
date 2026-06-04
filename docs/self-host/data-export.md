# Data export & re-import (GDPR Article 20, anti-lock-in)

The diary is anti-lock-in by design: every byte of your data is one HTTP
request away. This page documents the export format and the order a future
importer would have to follow to round-trip it into a fresh instance —
typically when migrating off the canonical SaaS to your own self-host box.

## What the export is

`GET /api/me/export` returns a **single JSON envelope** of everything the
calling user owns. It is:

- **Auth-gated + tenant-scoped** — you only ever see your own rows; the
  endpoint has no `:userId` parameter, it operates on your session.
- **Audit-logged** — each export writes an `account.exported` row to your
  audit log.
- **Secret-free** — envelope-encrypted credentials are stripped at the DTO
  projection boundary (see "API keys" below). The export carries no
  ciphertext, no `user_id`, no OAuth tokens.
- **JSON only** — CSV is intentionally out of scope (D-06). A single JSON
  document satisfies GDPR Article 20 ("data portability") and is the honest
  machine-readable form for a relational dataset; a flat CSV cannot represent
  the table relationships.

The response is sent as a `diary-export-YYYY-MM-DD.json` attachment.

## The 11 top-level keys

| Key | Contents |
| --- | --- |
| `exported_at` | ISO-8601 timestamp of when the export was generated. |
| `user` | Your account row (id, email, name, timestamps). No OAuth tokens. |
| `games` | Your game cards (title, cover, tags, comments, derived release info). |
| `game_steam_listings` | Steam store listings attached to your games (appId, label). |
| `data_sources` | Registered content sources (YouTube channels, Reddit accounts, etc.) + their config. |
| `events` | Your full promotion timeline — every logged event across all platforms, with attached `gameIds`. |
| `api_keys_steam` | Steam key **metadata only** (label, last-4, timestamps). **The secret ciphertext is stripped — keys must be re-entered after a restore.** |
| `audit_log` | Your audit trail (logins, key add/remove, exports, etc.). |
| `wishlist_snapshots` | Your Steam wishlist daily time-series (adds / deletes / balance per listing). Commercially sensitive, tenant-owned. |
| `youtube_video_snapshots` | Per-video metric history (views / likes / comments over time) for the YouTube videos in your events. Public data. |
| `reddit_post_snapshots` | Per-post metric history (score / comments / upvote ratio over time) for the Reddit posts in your events. Public data. |

The wishlist + metric-history sections were added in the trust-and-self-host
phase (PRIV-03). Before that the export silently dropped them — so "take all
your data and leave" was a partial promise. It is now complete: your promo log,
**how each post grew**, and your wishlist curve all travel together.

## Tenant-owned vs public-data sections

Two of the metric-history sections — `youtube_video_snapshots` and
`reddit_post_snapshots` — are **public-data** tables with no `user_id` column.
The same view count or upvote total is identical for everyone, so the diary
stores them once per video/post and shares them across tenants. In the export,
the tenant boundary is the set of `external_id`s drawn from **your own events**:
you receive metric history only for the videos and posts you actually logged.

`wishlist_snapshots` is the opposite — it is tenant-owned and
commercially-sensitive (a pre-launch wishlist curve is competitive
intelligence). It is filtered to your `user_id` and never crosses tenants.

## Re-import: table order & FK dependencies

There is **no import endpoint in v1** (see below) — this section documents the
contract a future importer (or a manual `psql` restore from the JSON) MUST
follow. Rows reference each other by foreign key, so they must be inserted
parent-before-child:

```
user
  → games                 (FK: user)
  → api_keys_steam        (FK: user)            -- re-enter the secret; export carries metadata only
  → game_steam_listings   (FK: user, games, api_keys_steam[set null])
  → data_sources          (FK: user)
  → events                (FK: user, data_sources[source_id nullable])
  → event_games           (FK: events, games, user)   -- the M:N junction; in the export it is folded into events[].gameIds
  → wishlist_snapshots    (FK: user, game_steam_listings)
```

Notes:

- **`event_games` is not a top-level export key.** The attachment of events to
  games is carried inline as `events[].gameIds`; a future importer reconstructs
  the junction rows from that array after inserting `events` and `games`.
- **`api_keys_steam` secrets are NOT in the export.** Only label / last-4 /
  timestamps survive the DTO strip. After a restore you re-enter each Steam Web
  API key in the UI (write-once). Re-keying is also the primary mitigation if a
  key ever leaks.
- **The public-data snapshot tables are import-SKIPPABLE.**
  `youtube_video_snapshots` and `reddit_post_snapshots` re-populate themselves
  from normal polling once your events exist on the new instance. They are
  included in the export for **completeness and offline analysis**, not for
  round-trip restore. A new instance with your events will start collecting
  fresh snapshots on its own polling cadence.

## Primary use case: SaaS → self-host migration

The reason this matters is the migration path off the canonical SaaS instance
(`neotolis-diary.dev`) onto your own VPS:

1. On the SaaS instance: `GET /api/me/export` → save the JSON.
2. Stand up your own self-host instance (`docs/deploy/install.md`).
3. Re-import the JSON in FK order (manual `psql` / a community importer).
4. Re-enter your Steam Web API key(s) in the new instance.
5. Re-register your data sources' auto-import; polling repopulates the
   public-data snapshot tables over time.

Because SaaS and self-host run the identical image and schema, the export from
one imports cleanly into the other — no format translation.

## No import endpoint in v1 (deferral, D-10)

The diary ships the **export** half of portability now; the **import** half is
**documented but not yet implemented**. Rationale:

- Export is the load-bearing GDPR / anti-lock-in guarantee — you can always
  leave with your data.
- A safe importer needs careful handling of id collisions, FK ordering,
  partial-restore semantics, and re-keying — non-trivial surface for a feature
  with no current caller.
- **Deferral trigger:** an actual migration need — a self-host operator (or the
  author) with a real export to round-trip. When that lands, the importer
  follows exactly the FK order above.

Until then, a manual restore via the documented order is the supported path.

---

*Last reviewed: 2026-06-04 (Phase 06 Plan 02, PRIV-03 / D-10).*
*See also: `docs/self-host/backups.md` (operational DB backup/restore, distinct
from this user-facing data export).*
