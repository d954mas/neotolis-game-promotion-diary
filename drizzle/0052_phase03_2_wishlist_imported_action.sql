-- Phase 03.2 Plan 01 — Add 'wishlist.imported' to audit_action enum.
--
-- Forward-only. Records the new audit verb fired by the wishlist CSV
-- import endpoint (Plan 03.2-03) when a tenant uploads a Steamworks
-- Wishlists.csv export. Metadata payload carries
-- { appId, listingId, rowCount, dateRange, skipped }.
--
-- ALTER TYPE ADD VALUE is forward-only safe but Postgres requires the new
-- value to be transaction-committed before any consumer can use it — so
-- this MUST be its own migration (Pitfall 4), separate from the table
-- migration 0051. IF NOT EXISTS makes it idempotent across re-runs
-- (Postgres 12+ syntax; 0023 precedent).

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'wishlist.imported';