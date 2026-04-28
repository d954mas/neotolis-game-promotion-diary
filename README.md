# Neotolis Game Promotion Diary

Self-tracking diary for indie game developers — log promotion activity across
YouTube, Reddit, Telegram, Twitter, Discord, conferences, and press; auto-import
content from registered sources; accumulate stats over time so charts surface
which actions actually moved wishlists.

Hosted by the author as a SaaS instance and shippable as an open-source
self-host on a small VPS. The same image, schema, and code serve both modes.

License: MIT.

## Status

Pre-launch. Phase 2.1 (architecture realignment) is in flight on the
`feat/phase-02.1-*` branches. Phase 1 (foundation) and Phase 2 (ingest +
secrets + audit) have shipped to `master` already.

## Dev setup

Requirements: Node 22 LTS (`>=22.11`), pnpm 9, Docker (for the Postgres
service container), Postgres 16.

```bash
pnpm install
docker compose -f docker-compose.selfhost.yml up -d  # boots Postgres on :5432
cp .env.example .env                                  # fill in OAuth + KEK values
pnpm db:migrate                                       # applies drizzle/0000_phase02_1_baseline.sql
pnpm dev
```

The app boots on `http://localhost:5173`.

## Phase 2.1 dev DB reset

Phase 2.1 collapses the previous two migrations into a new baseline (per
Phase 2.1 CONTEXT.md D-03 / D-04). On first checkout of this branch, run:

```bash
pnpm db:drop && pnpm db:migrate
```

This drops the dev schema and applies `drizzle/0000_phase02_1_baseline.sql`.
UAT data from Phase 2 (game cards, registered channels, tracked items,
events) is intentionally lost — that data was scratchpad for Phase 2 surface
validation, not production state. Phase 3+ resumes strict forward-only
migrations from this new baseline.

If `pnpm db:drop` is not yet wired in `package.json`, the equivalent manual
step is:

```bash
docker exec -it <postgres-container> psql -U postgres -d neotolis \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
```

## Tests

```bash
pnpm test:unit          # fast, no DB
pnpm test:integration   # boots a Postgres test DB and runs migrations
pnpm test:browser       # 360px viewport contract + Svelte 5 SSR (needs a `pnpm preview` running)
pnpm test               # all three
```

CI gates every PR with three jobs: `lint-typecheck`, `unit-integration`
(Postgres service container), and `smoke` (production Docker image, OAuth
dance via `oauth2-mock-server`, cross-tenant + anonymous-401 invariants).
The smoke job is the load-bearing trust signal for the self-host story.

## Contributing

Workflow is PR-only on `master`. Squash-merges, no merge commits, branches
auto-deleted on merge. See `AGENTS.md` (root) for the non-negotiable Privacy
and multi-tenancy invariants every change is reviewed against.
