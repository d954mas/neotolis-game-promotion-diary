---
created: 2026-04-28T06:30:00.000Z
title: NEW MILESTONE — file attachments per event/game (presskits, conference photos)
area: planning
files:
  - .planning/PROJECT.md (Constraints — indie budget, no paid SaaS in critical path)
  - src/lib/server/db/schema/ (new attachments table)
  - src/lib/server/services/ (new attachments service)
  - src/lib/server/storage/ (new module — backend abstraction)
  - src/routes/ (upload UI, attached-file rendering)
---

## Problem

During Phase 2 manual UAT (2026-04-28), user said:
**"Может я захочу например фото из конференции приложить. Или пресскит"**

Current state: events store `kind/title/url/occurredAt` only. No way to attach a file (presskit PDF, conference photo, screenshot of a Discord drop, etc.). Same gap on games (no game cover upload — current `coverUrl` is from Steam appdetails, not user-uploaded).

This is a **legitimate user need** for an indie dev diary:
- Conference photos document attendance
- Presskits get attached to press events
- Screenshots document Discord drops
- Game cover/marketing images for self-uploaded games (no Steam listing)

But it's a **major feature** that requires:

## Why this is a new milestone

1. **File storage backend** — needs to honor "indie / zero-budget" constraint (PROJECT.md):
   - Cloudflare R2: $0.015/GB/mo storage + free egress (best for indie)
   - Local filesystem (self-host only — bind-mount in Docker)
   - S3-compatible (Backblaze B2 cheaper than AWS)
   - Schema: `attachments` table with `storage_provider`, `storage_key`, `mime_type`, `size_bytes`, `uploaded_at`, FK to events.id and games.id

2. **Upload UI** — drag-drop + file picker, progress bar, multi-file, image previews

3. **Security**:
   - MIME validation (whitelist: image/*, application/pdf, application/zip for presskits)
   - Size limits per user (e.g., 100MB total per free tier)
   - Anti-malware: at minimum file-size limits, ideally something like ClamAV (separate sidecar or external service)
   - Signed URLs for download (so files aren't publicly browsable)
   - Per-tenant isolation — never leak A's file to B (cross-tenant 404 invariant must extend to attachments)

4. **GDPR / data deletion** — soft-delete attachments must eventually purge from R2/S3 (not just DB row) — connects to RETENTION_DAYS purge worker (Phase 3)

5. **SaaS = self-host parity** — same code path must work with R2 (SaaS) and local FS (self-host) via storage adapter pattern

6. **Storage cost in SaaS mode** — needs free-tier or freemium plan limits (probably blocks scaling without paid plan, but per PROJECT.md "indie budget" we can start with R2 free 10GB tier per author's account, raise quotas as needed)

## Suggested milestone structure (v1.1 or beyond)

If accepted as a future milestone:

**Phase A — storage foundation:**
- Storage adapter pattern (R2 / local / S3-compat)
- attachments table + service + tenant scoping
- Signed-URL download flow
- Size limits + MIME validation

**Phase B — upload UI:**
- New AttachmentUploader component
- Per-event attachments panel in event detail page (depends on todo `2026-04-28-event-detail-page`)
- Per-game attachments panel (game cover override + general media)

**Phase C — image-specific polish:**
- Thumbnail generation (sharp lib?)
- Inline preview in event/game cards
- Lightbox view

**Phase D — operational:**
- Purge worker for soft-deleted attachments (RETENTION_DAYS-aligned)
- Per-user storage quota display + warnings

## Constraints to preserve

- "Indie / zero-budget" — R2 free tier or self-host local FS
- "SaaS = self-host parity" — storage adapter abstracts both
- "Privacy: private by default" — files never publicly indexed
- "No secrets in logs" — signed URL components must be in Pino redact paths

## Effort estimate

Roughly 4-6 phases of work. Comparable in scope to Phase 1 (foundation) — file storage is a significant new domain.

Owner: PROJECT.md decision — should the v1.1 / v2 milestone include attachments? Not blocking v1 completion (Phase 2-6 ship without it).
