# Backups (opt-in, self-host friendly)

The application has zero awareness of backups. `scripts/backup.sh` is a
standalone shell helper that pg_dumps the postgres container, gzips the
output, and uploads to any S3-compatible remote via `rclone`. Self-host
operators who don't want backups simply skip this setup; the app runs
identically with or without.

This runbook walks **any** self-host operator (not just the SaaS author)
through the opt-in backup setup for any S3-compatible remote — Cloudflare
R2, Backblaze B2, Wasabi, AWS S3, MinIO (local), or no remote at all.

## Why opt-in

- **D-25a:** the backup is a server-side cron job, NOT bundled in
  `docker-compose.selfhost.yml` or `docker-compose.prod.yml`. The
  application + database run identically with or without backups (no
  env-var coupling, no application code that reads R2 / S3 credentials —
  rclone reads its own config from `~/.config/rclone/rclone.conf`).
- **D-25b:** the same script + same crontab line work for SaaS prod
  (CF R2) and any self-host operator. No fork required.
- **Self-host parity invariant** (AGENTS.md): adding backups to the
  application code path would couple the app to a managed service,
  failing the self-host smoke gate. Keeping backups external preserves
  the gate.
- Operators who don't want off-site backups can skip §1–§4 entirely;
  the named-volume `pg_data` survives `docker compose down` (without
  `-v`) and host reboots, which is enough durability for personal scale.

The shipping artifacts are:

- `scripts/backup.sh` (~30 lines) — reusable shell script, idempotent,
  flock-locked, exits 0 silently on lock-held to avoid duplicate-run
  noise.
- `docs/self-host/backups.md` (this file) — per-provider rclone config
  flow + crontab + restore procedure.
- **No backup service in `docker-compose.*.yml`** — `app/worker/scheduler/postgres/nginx`
  only.

## §1 — Install rclone

On the VPS (as `root` or any user with sudo):

```bash
apt update
apt install -y rclone
```

rclone ≥ 1.59 is required for the R2 `provider = Cloudflare` shortcut
(stock Ubuntu 24.04 ships rclone 1.66; no extra steps needed).

Verify: `rclone version` — expect `rclone v1.66.x` or newer.

## §2 — Configure rclone for your remote

Run the interactive flow (as the user that will own the cron — typically
the `deploy` user on a single-tenant box, or `root` if you're keeping
backups outside the deploy user's home):

```bash
rclone config
```

The flow asks for a remote name (the script defaults to `r2`; you can
override via `RCLONE_REMOTE=...` in the crontab line if you pick a
different name). Below are the per-provider answers; pick ONE.

### Cloudflare R2 (recommended for SaaS author + most self-hosters)

- New remote: `r2`
- Type: `s3`
- Provider: `Cloudflare`
- env_auth: `false`
- access_key_id: paste the access key from your CF R2 API token (write-only token)
- secret_access_key: paste the secret access key from the same token
- region: `auto`
- endpoint: `https://<account-id>.r2.cloudflarestorage.com`
  (find `<account-id>` in the CF dashboard → R2 → Overview)
- Leave everything else default.

R2 free tier covers 10 GB-month + 1M Class A ops + 10M Class B ops + free
egress — plenty for a daily ~50 MB backup retained 30 days.

### Backblaze B2

- New remote: `r2` (yes, the name stays `r2` — the script reads from
  `${RCLONE_REMOTE:-r2}`; you can name the remote whatever you want and
  override via env)
- Type: `b2`
- account: paste your B2 keyID
- key: paste your B2 application key
- Leave everything else default.

B2 charges ~$0.005/GB-month, free egress to Cloudflare. Cheapest
durable storage outside R2's free tier.

### Wasabi

- New remote: `r2` (same naming logic as B2)
- Type: `s3`
- Provider: `Wasabi`
- env_auth: `false`
- access_key_id: paste from Wasabi console
- secret_access_key: paste from Wasabi console
- region: `us-east-1` (or your closest Wasabi region)
- endpoint: `https://s3.wasabisys.com` (region-specific endpoints also
  work; check Wasabi docs)

Wasabi has a 90-day minimum-storage-charge — fine for backups (we keep
30 days locked + indefinite cold history).

### AWS S3

- New remote: `r2`
- Type: `s3`
- Provider: `AWS`
- access_key_id / secret_access_key: from an IAM user with bucket-write
  scope
- region: your bucket's region

Free tier: 5 GB for 12 months. After that, $0.023/GB-month + egress
charges — more expensive than B2 / R2 for this workload.

### MinIO (local self-host, e.g. on a NAS or a second VPS)

- New remote: `r2`
- Type: `s3`
- Provider: `Minio`
- env_auth: `false`
- access_key_id / secret_access_key: from your MinIO root credentials or
  a per-user policy
- region: `us-east-1` (MinIO default; doesn't matter for local)
- endpoint: `http://localhost:9000` (or your MinIO host)

Use case: you want totally self-hosted backups on hardware you control,
no third-party dependency.

### Local-only (no remote at all)

If you don't want any off-site backup, skip rclone entirely. Edit
`scripts/backup.sh` and replace the `rclone copyto` line with:

```bash
mv "$DUMP_FILE" /opt/backups/
```

Mount `/opt/backups` to a separate host disk (or another machine via
NFS / SSHFS) so a single host failure doesn't lose the backup. Cron the
script the same way as §4. Disclaimer: a fire / theft / single-disk
failure now loses both the live data AND the backup.

## §3 — Configure bucket retention (R2 specific)

For Cloudflare R2, apply a 30-day bucket-lock retention via Wrangler
(this prevents a compromised root account on the VPS from wiping
backup history; see Pitfall 6 in `docs/deploy/install.md` §7):

```bash
npx wrangler r2 bucket lock add diary-backups --prefix '' --age-seconds 2592000
```

`2592000` seconds = 30 days. The lock takes precedence over any
lifecycle rule. Run from the operator's workstation (with `wrangler
login` already done), NOT from the VPS — using the admin token rather
than the write-only token avoids leaking elevated credentials onto a
public-facing host.

For other providers, equivalent immutability features:

- **Backblaze B2:** Object Lock at bucket creation; configure via the
  CLI `b2 update-bucket --defaultRetention compliance --period 30d`.
- **Wasabi:** Compliance Mode at bucket creation (cannot be enabled
  retroactively).
- **AWS S3:** Object Lock with COMPLIANCE retention mode (must be
  enabled at bucket creation).
- **MinIO:** Object Lock with `mc retention set --default COMPLIANCE 30d`.
- **Local-only:** filesystem snapshots (ZFS / btrfs / LVM); no
  immutability guarantee against root.

## §4 — Install the script + cron

```bash
sudo cp /opt/diary/scripts/backup.sh /usr/local/bin/diary-backup
sudo chmod +x /usr/local/bin/diary-backup
sudo crontab -e
```

Add this line to the root crontab (the script needs `docker exec` access,
which is the simplest path to the postgres container):

```
0 3 * * * /usr/local/bin/diary-backup >> /var/log/diary-backup.log 2>&1
```

The schedule is locked to **03:00 UTC daily** (D-25b); operators can pick
a different time but the runbook references this canonical line so
duplicate-cron mistakes (Pitfall 8) don't compound.

If you used a non-default rclone remote name or bucket name, override
inline:

```
0 3 * * * RCLONE_REMOTE=mybackup RCLONE_BUCKET=neotolis-archive /usr/local/bin/diary-backup >> /var/log/diary-backup.log 2>&1
```

The script defaults are `RCLONE_REMOTE=r2`, `RCLONE_BUCKET=diary-backups`,
`COMPOSE_FILE=/opt/diary/docker-compose.prod.yml`. The Postgres container is
resolved via `docker compose exec -T postgres ...` against `COMPOSE_FILE`,
so the script is independent of compose project naming and works without a
`container_name:` override (Codex post-fix #1). Self-host operators on a
non-standard install path set `COMPOSE_FILE=/path/to/docker-compose.yml`
inline in the cron line.

## §5 — Verify

After 24 hours (at the next 03:00 UTC firing), expect:

```bash
# Latest log line should say "[OK]" with a non-zero size
tail /var/log/diary-backup.log

# Bucket listing should include today's filename
rclone ls r2:diary-backups | tail -5
# expected: ...  YYYY-MM-DD.sql.gz   (~5–50 MB depending on data volume)
```

If the log shows non-zero bytes but rclone reports nothing, suspect
rclone config (re-run `rclone config show r2` to verify endpoint +
credentials).

For an immediate verification (don't wait until 03:00), run the script
manually as root:

```bash
sudo /usr/local/bin/diary-backup
# expected stdout: [TIMESTAMP] starting backup YYYY-MM-DD
#                  [TIMESTAMP] dump size: NNNN bytes
#                  [TIMESTAMP] backup YYYY-MM-DD OK (NNNN bytes)
```

## §6 — Restore procedure

```bash
# 1. Pull the latest dump to /tmp on the VPS (or from operator's workstation
#    using the admin R2 token — same rclone command, different remote name)
rclone copy r2:diary-backups/<date>.sql.gz /tmp/

# 2. Stop the app + worker + scheduler so no writes hit the DB during restore
cd /opt/diary
docker compose -f docker-compose.prod.yml stop app worker scheduler

# 3. Restore (DESTRUCTIVE — replaces current DB content). Resolve the
#    Postgres container via `docker compose exec` instead of `docker exec
#    <name>` — Compose generates the runtime container name from the
#    project + service + index, and `compose exec` looks up the service
#    independently of that name (Codex post-fix #1).
gunzip -c /tmp/<date>.sql.gz \
  | docker compose -f docker-compose.prod.yml exec -T postgres pg_restore -U postgres -d neotolis -c

# 4. Restart the app + worker + scheduler
docker compose -f docker-compose.prod.yml up -d

# 5. Verify
curl -fsS https://<DOMAIN>/healthz
```

For partial restoration (e.g. recover just the `events` table after a
buggy migration drops a column), use the `pg_restore -t <table>` flag
plus `pg_restore -L <listfile>` to be surgical. Keep the original dump
file around — `pg_restore -c` (clean) drops + recreates objects, so a
full `-c` restore wipes any data added since the dump.

For point-in-time recovery beyond daily granularity, you'd need WAL
archiving (e.g. WAL-G or wal-e) — out of scope for Phase 02.2; if the
author or a self-host operator needs minute-level RPO, they configure
WAL-G separately.

## §7 — Failure modes

| Failure | Symptom | Resolution |
|---------|---------|------------|
| rclone misconfigured | Script exits non-zero; `tail /var/log/diary-backup.log` shows rclone error | Re-run `rclone config show r2` to compare against §2; fix bad endpoint / credentials; run script manually to verify |
| Disk full on `/tmp` | Script exits non-zero with `cannot write` error from gzip | `df -h /tmp` to confirm; clean `/tmp/diary-backup-*.sql.gz` orphans from previous failed runs; consider `TMPDIR=/var/tmp` in cron line if `/tmp` is a small tmpfs mount |
| Concurrent invocation (two crons or operator manual + cron) | Script exits 0 silently; no error noise | Expected behavior — `flock -n /var/lock/diary-backup.lock` prevents the duplicate; investigate why two cron entries exist (Pitfall 8) |
| Postgres container down | `docker exec` fails with "no such container" | `docker compose -f docker-compose.prod.yml ps` to confirm; restart with `up -d`; backup will succeed on the next cron run |
| R2 quota exceeded (over 10 GB-month free tier) | rclone error mentioning quota / billing | Either trim retention (lower the `--age-seconds` on the bucket lock + add a lifecycle rule), or upgrade to R2 paid tier ($0.015/GB-month), or migrate to B2 / Wasabi |
| Backup file size suddenly drops to 0 bytes | Log shows "dump size: 0 bytes" | postgres container is starting / postgres connection failed mid-dump; check `docker compose logs postgres`; usually transient — next cron run recovers |

Backup failures DO NOT page the operator (D-25b — UptimeRobot pings
`/healthz`, not backup status). Inspect the bucket manually monthly,
or when something feels off. Phase 6 may add a backup-status dashboard;
Phase 02.2 baseline is "check R2 manually monthly to confirm backups
are landing".

---

*Last reviewed: 2026-05-03 (Phase 02.2 Plan 08)*
*See also: `docs/deploy/install.md` §2 step 6–8 (R2 bucket setup +
bucket-locks) and §5 "Backup verification" (operator's monthly check).*
