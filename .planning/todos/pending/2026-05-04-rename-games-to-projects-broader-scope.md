---
created: 2026-05-04T14:15:37.266Z
area: planning
status: pending
---

# Rename `games` → `projects` (broader scope) + add `url` field

## Idea

Generalize the `games` abstraction to `projects`. The author wants to track
promotion activity for **multiple project types**:

- Indie games (the original use case)
- This service itself (Neotolis Diary — open-source meta-promotion)
- His game engine
- Future: any project the operator promotes online

"Game" is too narrow. "Project" covers all of the above without
contortions like "track this engine as if it were a game".

Add a `url` field on the project (for project homepage / Steam page /
GitHub repo / etc.) — currently `games` only has title + Steam-listing
sub-table. Top-level URL on the project itself is more flexible.

## Surface area (rough)

- **Schema rename:** `games` table → `projects`. `event_games` junction
  → `event_projects`. New `projects.url` text column.
- **Audit verbs:** `game.created` / `game.deleted` / `game.restored` →
  `project.*`. ALTER TYPE migration on the `audit_action` pgEnum.
- **Service layer:** `services/games.ts` → `services/projects.ts`. All
  functions: `createGame` → `createProject`, `assertGameOwnedByUser` →
  `assertProjectOwnedByUser`, etc.
- **Routes:** `/games` → `/projects`, `/games/[id]` → `/projects/[id]`,
  `/api/games` → `/api/projects`, `/api/games/:gameId/listings` →
  `/api/projects/:projectId/listings`.
- **Paraglide keys:** every `games_*` / `game_*` / `confirm_game_*` /
  `audit_action_game_*` key — rename + matching UI cases (per
  Phase 2.1 lock-step closure rule).
- **Nav tab label:** "Games" → "Projects".
- **Settings link:** `/settings` Account block doesn't reference games
  by name; check anyway.
- **Docs:** README.md, PROJECT.md, AGENTS.md "Architecture" section,
  install.md, all `.planning/phases/` artifacts that mention `games`.
- **Migration data:** existing rows in `games` (operator's existing
  data after deploy) need to migrate. Forward-only — rename table not
  drop.

## When to do this

NOT in v1.0 (Phase 02.2 scope is already locked + shipping). Either:
- New milestone (v1.1 or v2.0) post-v1.0 sign-off
- Or insert as a Phase 5+ pre-polling-pipeline item if operator wants
  it before publicly releasing the service

Touches every layer (DB, services, routes, UI, docs). Significant work
— probably a 6-10 plan phase.

## Captured

2026-05-04 during Phase 02.2 ship-to-prod live aeza VPS deploy. The
operator was reviewing the dashboard during UAT and realized he wants
to track this same service as a "project" alongside his games + game
engine.
