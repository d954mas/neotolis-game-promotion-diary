#!/usr/bin/env bash
# diary-backup — daily Postgres dump → S3-compatible push (D-25, D-25a, D-25b).
#
# Idempotent: flock prevents concurrent runs. Same-day filename means
# multiple runs the same day overwrite the same key; bucket-side
# versioning (R2 Object Lock / B2 keep-versions / Wasabi compliance)
# preserves the prior version.
#
# Failures DO NOT page the operator (D-25b — UptimeRobot pings /healthz,
# not backup status). Operator inspects the bucket manually monthly.
#
# rclone reads its own config from ~/.config/rclone/rclone.conf; the
# application has zero awareness of backup credentials (D-25a). Works
# against any S3-compatible remote (CF R2, Backblaze B2, Wasabi, MinIO,
# AWS S3) — the operator picks one in docs/self-host/backups.md.
#
# RCLONE_REMOTE / RCLONE_BUCKET / PG_CONTAINER are env-overridable so
# this script is reusable across self-host and author-instance setups
# without forking it.

set -euo pipefail

LOCK="/var/lock/diary-backup.lock"
DATE="$(date -u +%Y-%m-%d)"
DUMP_FILE="/tmp/diary-backup-${DATE}.sql.gz"
RCLONE_REMOTE="${RCLONE_REMOTE:-r2}"
RCLONE_BUCKET="${RCLONE_BUCKET:-diary-backups}"
PG_CONTAINER="${PG_CONTAINER:-diary_postgres}"

# flock: -n = non-blocking; exit 0 silently if held (no error noise).
exec 200>"$LOCK"
flock -n 200 || { echo "[$(date -u)] backup already running, skipping"; exit 0; }

echo "[$(date -u)] starting backup ${DATE}"

# pg_dump runs INSIDE the postgres container (no postgresql-client
# install on the host required). -Fc = custom format; restored via
# pg_restore. gzip on the host side.
docker exec "$PG_CONTAINER" pg_dump -Fc -U postgres neotolis | gzip > "$DUMP_FILE"
SIZE=$(stat -c%s "$DUMP_FILE")
echo "[$(date -u)] dump size: ${SIZE} bytes"

rclone copyto "$DUMP_FILE" "${RCLONE_REMOTE}:${RCLONE_BUCKET}/${DATE}.sql.gz"

rm -f "$DUMP_FILE"
echo "[$(date -u)] backup ${DATE} OK (${SIZE} bytes)"
