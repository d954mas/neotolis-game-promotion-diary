---
created: 2026-04-30T14:00:00.000Z
title: Files & Uploads infrastructure (S3 abstraction + MinIO + Cloudflare R2 + sharp + game icon as first consumer)
area: infrastructure
phase_candidate: 3.1 (Files & Icons — decimal phase, INSERTED between Phase 3 and Phase 4 if user activates)
captured-during: Plan 02.1-39 round-6 polish #14 UAT discussion (2026-04-30)
related-todos:
  - 2026-04-28-attachments-feature-new-milestone.md (broader scope — events/games attachments; this todo is narrower — game icon first, infrastructure shared)
files:
  - src/lib/server/storage/ (NEW — S3 abstraction module)
  - src/lib/server/db/schema/files.ts (NEW)
  - src/lib/server/services/files.ts (NEW)
  - src/lib/server/services/games.ts (extends — game.icon_file_id FK)
  - src/lib/server/http/routes/files.ts (NEW)
  - src/lib/server/http/routes/games.ts (extends — POST /api/games/:id/icon)
  - src/lib/components/IconUploadField.svelte (NEW)
  - docker-compose.dev.yml (extends — MinIO sidecar)
  - .github/workflows/ci.yml (extends — MinIO service container)
  - drizzle/ (NEW migrations: files table, games.icon_file_id FK)
---

## Trigger

User decides icons / images on game cards / cover uploads / any future file feature is needed.

Currently triggered by **game-icon upload** request during Plan 02.1-39 round-6 polish #14 walkthrough (`/games/[gameId]` redesign discussion).

## User quote (verbatim, ru)

> "потом планирую добавить файлы, так что мб будет полезно сразу"
>
> ("planning to add files later, so might be useful to do right away")

User also referenced (separate quote, ru):

> "Хочется добавить так-же тут про игру. У меня есть название игры, хочется ещё описание и возможность задать мою иконку."
>
> ("Want to also add something about the game. I have the game title, I'd like to also have a description and the ability to set my own icon.")

`games.description` shipped in plan 02.1-39 polish #14a (forward-only migration 0007 + service + endpoint). The icon-upload portion was deferred to this todo because it requires the file-storage infrastructure not yet built.

## Why a new milestone (decimal phase, not a single plan)

A reasonable single-plan scope would only ship game-icon upload with a hard-coded local-FS path. That violates two constraints:

1. **SaaS = self-host parity** — local FS is fine for self-host but the SaaS instance runs on aeza VPS where ephemeral disk is not durable; needs Cloudflare R2 (or any S3-compat).
2. **Indie / zero-budget** — Cloudflare R2 has free egress + free 10GB storage tier; the right call for SaaS. Self-host needs MinIO sidecar OR local FS bind-mount.

Both modes need the same code path → S3-compatible API as the universal abstraction. Once that's built, every future file feature (event attachments, presskit PDFs, conference photos, screenshots, exports) reuses it. Building the abstraction once is cheaper than retrofitting later.

## Scope (architecture pre-discussed during round-6 walkthrough)

### Data layer

- `files` table:
  - `id` (UUIDv7 PK)
  - `user_id` (FK to user, tenant scope per AGENTS.md invariant 1)
  - `kind` (enum — `game_icon`, `game_cover`, `event_attachment`, `presskit`, ...)
  - `mime` (text)
  - `size_bytes` (bigint)
  - `storage_key` (text — S3 object key, e.g., `users/<user_id>/icons/<file_id>.webp`)
  - `status` (enum — `pending` | `ready` | `deleted`)
  - `width` (int, nullable — set after sharp processing)
  - `height` (int, nullable)
  - `created_at`, `deleted_at`
- `games.icon_file_id` (FK to files, nullable; `ON DELETE SET NULL`)
- Future extensions: `events.attachment_file_ids` (array FK or junction table — TBD by attachment-feature todo `2026-04-28-attachments-feature-new-milestone.md`)
- Tenant scope: `eslint-plugin-tenant-scope/no-unfiltered-tenant-query` extends `TENANT_TABLES` to include `files`

### Storage abstraction

- Module: `src/lib/server/storage/`
- Single interface (`StorageBackend`) with implementations:
  - **MinIO** (local dev — `docker-compose.dev.yml` sidecar; `S3_ENDPOINT=http://minio:9000`)
  - **MinIO** (CI — `.github/workflows/ci.yml` service container)
  - **Cloudflare R2** (SaaS prod — `S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`)
  - **Self-host** — operator chooses MinIO sidecar OR any S3-compatible service (Backblaze B2, AWS S3, Wasabi). The `.env.example` documents `S3_ENDPOINT` + `S3_BUCKET` + `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` + `S3_PUBLIC_BASE_URL`.
- Methods: `putObject(key, buffer, contentType)`, `getSignedDownloadUrl(key, ttlSec)`, `deleteObject(key)`.
- Library: `@aws-sdk/client-s3` (S3 protocol — works with all backends above; lockstep version bump in dedicated PR per AGENTS.md Practices).

### Image processing pipeline

- Library: `sharp` (Node-native, fast).
- For `kind=game_icon`: resize to 512×512 + center-crop + WebP encoding + quality 85.
- For other kinds (future): pipeline parameters per `kind`.
- Pipeline runs in the route handler (synchronous within the request — game icons are small, ~50-200KB output). Larger files (Phase 3+ event attachments) might need a worker queue (pg-boss already in stack).

### Routes (Hono sub-router)

Three patterns to choose from:

- **Pattern A — Server-proxy upload (chosen for game-icon):**
  - `POST /api/games/:id/icon` — multipart/form-data upload; route validates ownership (assertGameOwnedByUser), pipes through sharp, calls `storage.putObject`, INSERTs into `files`, UPDATEs `games.icon_file_id` (db.transaction wrap).
  - Pro: simplest UX; client sends the raw file once; server does everything.
  - Con: server bandwidth hit on upload. Fine for icons (≤2MB raw input); not fine for large files.

- **Pattern B — Presigned upload (for future large files):**
  - `POST /api/files/presign {kind, mime, sizeBytes}` — server validates per-kind constraints, returns `{uploadUrl, fileId}`; client PUTs directly to S3.
  - `POST /api/files/:id/finalize` — client notifies server upload complete; server runs sharp processing (if image) + flips status to `ready`.
  - Pro: server bandwidth not in critical path; works for multi-GB files.
  - Con: 2-step flow; orphaned `pending` rows need GC.

For game-icon (first consumer): Pattern A. Future event attachments + presskits: Pattern B.

### DTO

- `toFileDto(row)` projects: `id`, `kind`, `mime`, `width`, `height`, `displayUrl` (constructed from `S3_PUBLIC_BASE_URL` + `storage_key` for public-read buckets, OR signed URL with TTL for private buckets — env-configurable).
- Strips `storage_key` (could leak bucket structure), `size_bytes` (not user-facing usually), `user_id` (per P3 dto-discipline).

### Frontend

- New component: `src/lib/components/IconUploadField.svelte`
- Surface: `<input type="file" accept="image/*">` + drag-drop dropzone + preview + replace/remove buttons.
- POSTs multipart/form-data to `/api/games/:id/icon`.
- On success, updates parent component's `game.iconFileId` + invalidates the relevant SvelteKit loader.

### Garbage collection

- pg-boss cron job: every hour, find `files` rows with `status='pending'` AND `created_at < NOW() - 1 hour` → delete from S3 + DELETE row.
- Same job: find `files` rows with `status='deleted'` AND `deleted_at < NOW() - RETENTION_DAYS` → delete from S3 (already-deleted rows finalize their purge).

### CI

- `.github/workflows/ci.yml smoke job` boots MinIO as service-container alongside Postgres. Smoke flow extends with file upload + display assertion.
- Self-host CI parity preserved: smoke runs against MinIO (S3-compat), proves the abstraction works without Cloudflare R2 in the loop.

### Tests

- Unit: storage backend mocks (no real S3 calls in unit tier).
- Integration: real MinIO service container; CRUD + cross-tenant 404 + cleanup.
- Browser: IconUploadField at 360px (drag-drop, error states, preview).

## Constraints to honor

- **Privacy: private by default** — bucket is private; files served via signed URLs OR public-read bucket with un-guessable storage keys (`crypto.randomUUID()` segment in path).
- **No secrets in logs** — `S3_SECRET_ACCESS_KEY` + presigned URL components added to Pino redact paths in same commit.
- **Tenant scope** — `files.user_id` + `eq(files.userId, userId)` on every query; ESLint rule covers it.
- **Cross-tenant 404 (never 403)** — file routes return 404 for cross-tenant access per AGENTS.md invariant 2.
- **Anonymous-401 sweep** — new `/api/files/*` and `/api/games/:id/icon` routes added to `MUST_BE_PROTECTED`.
- **Forward-only migrations** — files table + games.icon_file_id FK in one migration; no down path.
- **MIME validation** — whitelist (`image/png`, `image/jpeg`, `image/webp` for icons; extend per kind).
- **Size limits** — per-user total (e.g., 100MB free tier) + per-file (e.g., 5MB icon, 50MB presskit).
- **Self-host parity** — same Docker image; only env vars differ (S3_ENDPOINT, etc.); CI smoke proves it.

## Estimated effort

3-5 days of focused work for a full Phase 3.1:
- Day 1: schema + service + storage abstraction + MinIO docker-compose
- Day 2: routes (Pattern A for game-icon) + DTO + Hono sub-router + tenant scope tests
- Day 3: IconUploadField component + game-icon as first consumer + sharp pipeline
- Day 4: CI integration (MinIO service container) + smoke extension
- Day 5: cross-tenant + anonymous-401 sweep + GC cron + buffer for issues

Comparable in scope to Plan 02-04 (games-services) + Plan 02-05 (api-keys-steam-service) combined — file storage is a new domain.

## Naming candidate

**Phase 3.1: Files & Icons** — decimal phase, INSERTED between Phase 3 (Polling Pipeline) and Phase 4 (Visualization). Why decimal:

- Phase 3 is co-dependent and pitfall-dense (poll workers + adapters + wishlist ingest); Phase 3.1 is independent of Phase 3 but builds on its infrastructure (pg-boss cron is already in scope by Phase 3).
- Could activate BEFORE Phase 3 if user decides icons are higher priority than polling — flexible insertion point.
- Mirrors Phase 2.1 precedent (architecture realignment INSERTED after Phase 2 UAT).

Alternative: roll into Phase 6 polish backlog if user decides icons are not top-of-queue. But the architecture (S3 abstraction) being load-bearing for future features (presskit attachments, exports, screenshots) suggests landing it earlier is the indie-budget-correct call.

## Activation criteria

User says "yes, ship icons / file uploads next" — this todo flips into a `/gsd:plan-phase 3.1` invocation.

## Out of scope (defer to later todos / Phase 6)

- Multi-file uploads / drag-drop multi-select (Phase 4+ event attachments)
- Image lightbox view (Phase 5+ visualization polish)
- Per-user storage quota dashboard (Phase 6 — QUOTA-* requirements)
- Anti-malware scanning (ClamAV sidecar — Phase 6+ if user-facing security review needs it)
- Existing `2026-04-28-attachments-feature-new-milestone.md` covers the broader event-attachments scope; this todo is the narrower "ship the storage layer + game-icon as first consumer" trigger
