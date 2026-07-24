# Manual production deploy

How we ship to the author's prod VPS (`neotolis-diary.dev`). The
previous `pnpm deploy` script assumed a `command="..."`-restricted SSH
key on the VPS; that setup was never finished, so the script was
silently broken. This guide replaces it.

Self-host operators follow the same shape — adjust SSH alias and
`/opt/diary` path to taste.

---

## TL;DR

```bash
# From your laptop:
ssh neotolis-diary
# On the server:
cd /opt/diary
git pull                                                            # if compose/.env changed
nano .env                                                           # add/change any new env vars
docker compose -f docker-compose.prod.yml pull                      # fetch new image from GHCR
docker compose -f docker-compose.prod.yml \
  -f docker-compose.monitoring.yml up -d                            # restart all (app + monitoring)
docker restart diary-nginx-1                                        # workaround: nginx upstream IP cache
exit
curl -fsS https://neotolis-diary.dev/healthz                        # 200 → live
```

> Omit `-f docker-compose.monitoring.yml` if monitoring is not enabled.

---

## Prerequisites

| Thing | Value |
|---|---|
| SSH alias | `neotolis-diary` (deploy user) — for normal ops |
| SSH root alias | `neotolis-diary-root` — for nginx restart / system-level fixes |
| Server app dir | `/opt/diary` |
| Compose file | `docker-compose.prod.yml` |
| Image registry | `ghcr.io/d954mas/neotolis-diary:latest` |
| Health URL | `https://neotolis-diary.dev/healthz` |

The `~/.ssh/config` aliases must already be configured locally.
Memory: they are.

---

## Step-by-step

### 1. Confirm CI on `master` is green

Before touching prod, make sure the squash-merge passed full CI on
`master` — including `docker-build-publish`, the job that pushes the
new image to GHCR. Without that job green, a `docker compose pull` will
pull the previous image and nothing changes.

```bash
gh run list --branch master --limit 1
```

All five jobs must be `success`. If `docker-build-publish` is
`skipped`, that's wrong on master and means the image wasn't pushed —
re-run the workflow or investigate.

### 2. SSH to the server and `cd` into the app dir

```bash
ssh neotolis-diary
cd /opt/diary
```

Every subsequent command in this guide assumes the working directory
is `/opt/diary` — `docker compose` reads `docker-compose.prod.yml` and
`.env` from cwd, and skipping the `cd` is the easiest way to "deploy"
nothing.

### 3. Pull repo changes (only if needed)

The Docker image holds the actual app code, so a routine deploy does
**not** need `git pull`. Pull only when one of these files changed in
the new release:

- `docker-compose.prod.yml` — service shape changed
- `docker-compose.monitoring.yml` — monitoring overlay changed
- `.env.example` — new env vars to mirror into `.env`
- `nginx/nginx.conf.template` — proxy config changed
- `monitoring/*` — Prometheus/Loki/Promtail/Grafana configs changed
- `docs/deploy/*` — operator-facing docs

```bash
git pull
```

### 4. Update `.env` if new vars were added

Compare `.env.example` against your live `.env`:

```bash
diff .env.example .env | grep -E "^<"
```

Add any new keys to `.env`. **Phase 12 (Reddit) added:**

| Var | Required? | What to set |
|---|---|---|
| `REDDIT_IMPORT_ENABLED` | yes to enable Reddit | Default `false` (import stays OFF). Set to the literal `true` to turn it on — the legally-hot platform never auto-enables just because a provider + key are present. |
| `REDDIT_PROVIDER` | yes to enable Reddit | Set to `scrapecreators` (the only buildable value). Empty (default) => Reddit is "not configured": the add-source Reddit chip renders disabled and no scraper credits are spent. |
| `SCRAPECREATORS_API_KEY` | shared | The SAME prepaid ScrapeCreators key you already use for Instagram + TikTok — Reddit draws from the ONE shared credit balance. No new key, no new budget vars. |

> **Reddit is a paid ScrapeCreators adapter, default-OFF.** Phase 12 razed
> the old free public-`.json` transport (whole datacenter proxy pools were
> 403-fenced by Reddit, and self-service OAuth closed Nov 2025) and rebuilt
> Reddit on **ScrapeCreators** — the same paid provider that serves Instagram
> + TikTok. Instagram + TikTok + Reddit draw the ONE shared prepaid credit
> balance (`SOCIAL_PROVIDER_DAILY_CAP_CREDITS` /
> `SOCIAL_PROVIDER_PREPAID_BALANCE_CREDITS`). Two source kinds:
> `reddit_account` (a user's submitted-post history by handle — the PRIMARY
> path) and `reddit_subreddit` (a subreddit's recent posts — SECONDARY).
>
> To enable, set BOTH `REDDIT_IMPORT_ENABLED=true` AND
> `REDDIT_PROVIDER=scrapecreators` (with the shared `SCRAPECREATORS_API_KEY`
> present). Leave any of the three empty and Reddit degrades gracefully to
> "not configured" — the chip is disabled, pasting a Reddit URL returns "not
> configured", and no credits are ever spent.

**Phase 07 (Observability) added:**

| Var | Required? | What to set |
|---|---|---|
| `METRICS_BEARER_TOKEN` | yes for monitoring | `openssl rand -hex 32`. Write the SAME value to `monitoring/prometheus/metrics-token` (one line, no trailing newline). Without it `/metrics` returns 404. |
| `GF_SECURITY_ADMIN_PASSWORD` | yes for monitoring | Strong password for Grafana UI. Compose refuses to start without it. |
| `GF_SERVER_ROOT_URL` | prod with nginx | `https://neotolis-diary.dev/grafana/` — Grafana needs to know its public URL for redirects. Bare-port selfhost can omit (defaults to `http://localhost:3001/`). |
| `GF_SERVER_SERVE_FROM_SUB_PATH` | prod with nginx | `true` — tells Grafana it's served under `/grafana/` path. Omit for bare-port selfhost. |
| `ALERT_WEBHOOK_URL` | no | Discord/Telegram webhook for alert notifications. Empty = alerts silently disabled. |
| `COMPOSE_NETWORK` | conditional | Override if your compose project dir isn't `/opt/diary`. Default `diary_default` matches the documented path. |

```bash
# Generate and write metrics token
openssl rand -hex 32 > monitoring/prometheus/metrics-token
echo "METRICS_BEARER_TOKEN=$(cat monitoring/prometheus/metrics-token)" >> .env

# Generate Grafana password
echo "GF_SECURITY_ADMIN_PASSWORD=$(openssl rand -hex 16)" >> .env

# Prod nginx sub-path config
echo "GF_SERVER_ROOT_URL=https://neotolis-diary.dev/grafana/" >> .env
echo "GF_SERVER_SERVE_FROM_SUB_PATH=true" >> .env
```

Save and close.

### 5. Pull the new image and restart

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml \
  -f docker-compose.monitoring.yml up -d
```

What this does:

- `pull` — fetches the new `ghcr.io/d954mas/neotolis-diary:latest`
  built by master CI.
- `up -d` — recreates the `app`, `worker`, `scheduler` containers with
  the new image. Postgres + nginx stay up. Monitoring containers
  (Prometheus, Loki, Grafana, Promtail) start if not already running.
- App container boot runs `runMigrations()` automatically (advisory-
  locked, idempotent — see `src/server.ts`). Schema changes land here.

> Omit `-f docker-compose.monitoring.yml` to run without monitoring.

**Env-only changes (same image).** If you only edited `.env` and didn't
pull a new image, `up -d` will skip the restart because Compose sees no
config drift. Force-recreate the affected services explicitly:

```bash
docker compose -f docker-compose.prod.yml \
  -f docker-compose.monitoring.yml up -d --force-recreate app worker scheduler
```

(Postgres and nginx never need env-driven recreate from this guide.)

### 6. Nginx upstream-IP cache workaround

Memory note: after `app` container restart, nginx caches the old
container's IP and serves 502 until restarted itself. Quick fix:

```bash
docker restart diary-nginx-1
```

A real fix in `nginx.conf.template` (use a resolver + `set $upstream`
variable) is pending — for now just bounce nginx.

### 7. Verify

From the server:

```bash
curl -fsS http://localhost/healthz && echo
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=50 app worker scheduler
```

Or from your laptop:

```bash
curl -fsS https://neotolis-diary.dev/healthz
```

Should return `200 OK`. If you see 502 — go back to Step 6.

For Phase 07 (Observability), also verify:

- `/metrics` responds inside the container (bearer-gated, not exposed externally):
  ```bash
  TOKEN=$(cat monitoring/prometheus/metrics-token)
  docker compose -f docker-compose.prod.yml exec app \
    wget -qO- --header="Authorization: Bearer $TOKEN" http://localhost:3000/metrics | head -5
  ```
- Prometheus scrapes successfully:
  ```bash
  docker exec diary-prometheus-1 \
    wget -qO- http://localhost:9090/api/v1/targets 2>/dev/null | grep -o '"health":"[^"]*"'
  ```
- Grafana accessible at `https://neotolis-diary.dev/grafana/` (login: `admin` + `GF_SECURITY_ADMIN_PASSWORD` from `.env`).
  Two dashboards auto-provisioned: **Neotolis Overview** + **Neotolis Logs**.
  Three alert rules: error-rate-spike, high-latency-p95, memory-pressure.
- Loki receiving logs: in Grafana Explore → Loki → `{service="app"}` should show app logs.

For Phase 12 (Reddit), also verify — only if you enabled it (`REDDIT_IMPORT_ENABLED=true` + `REDDIT_PROVIDER=scrapecreators`):

- `/sources/new` → the Reddit chip is enabled (it renders disabled /
  "not configured" when either var is unset). Adding a `reddit_account`
  handle or a `reddit_subreddit` shows the backfill picker.
- `/admin/quota` → the shared ScrapeCreators budget (Instagram + TikTok +
  Reddit) is visible; Reddit spend draws it down.
- `docker compose logs worker | grep -i reddit` — confirms the adapter
  imports posts and runs the active/cold subject walks without errors.

---

## Rollback

If a deploy breaks prod:

```bash
ssh neotolis-diary
cd /opt/diary
nano .env                                              # set IMAGE_TAG=<previous-git-sha>
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker restart diary-nginx-1
```

The `docker-compose.prod.yml` uses `${IMAGE_TAG:-latest}` for the app
image — overriding `IMAGE_TAG` in `.env` pins to a specific build. Find
the previous sha in `git log master` or in GHCR's package tags page.

**Monitoring rollback** — monitoring is fully isolated from app:

```bash
docker compose -f docker-compose.monitoring.yml down    # stop monitoring, app unaffected
docker compose -f docker-compose.prod.yml \
  -f docker-compose.monitoring.yml up -d                # bring it back
```

Schema-forward migrations cannot be rolled back via this path —
investigate the migration that broke instead. Pre-restore the DB from
the latest nightly backup if necessary (see `scripts/backup.sh`).

---

## Troubleshooting

### `docker compose pull` doesn't fetch the new image

The image name has `:latest` tag. GHCR-side latest moves to the most
recent `master` push — so if your local `master` is ahead of remote,
there's nothing new yet. Cross-check `gh run list --branch master
--limit 1` shows the run is `completed/success` AND the `docker-build-
publish` job succeeded.

### Migrations failed at boot

App container exits if `runMigrations()` throws. `docker compose logs
app` shows the SQL error. The advisory lock auto-releases on connection
close, so a retry is safe.

If migration drift is the cause (Drizzle hash mismatch from header
edits), re-applying with `IF NOT EXISTS` ALTERs by hand is the
escape hatch — see the dev-DB notes in your shell history.

### 502 stays after `docker restart diary-nginx-1`

Check nginx itself: `docker logs diary-nginx-1 --tail=30`. Look for
upstream timeout vs upstream resolution failure. If app container is
healthy (`curl -fsS http://localhost:3000/healthz` inside the network
returns 200), the issue is nginx config — `nginx -t` inside the
container, or restore previous `nginx.conf.template` from `git`.

### Reddit chip stays disabled / "not configured"

Reddit is a paid ScrapeCreators adapter that ships **default-OFF**. The
add-source Reddit chip renders disabled until ALL of these are set:

```bash
REDDIT_IMPORT_ENABLED=true          # literal "true" — the isolation kill-switch
REDDIT_PROVIDER=scrapecreators      # the only buildable provider
SCRAPECREATORS_API_KEY=<your-key>   # the SAME key Instagram + TikTok use
```

With any one empty, Reddit degrades gracefully — the chip is disabled,
pasting a Reddit URL returns "not configured", and no credits are spent. If
the chip is still disabled after setting all three, force-recreate so the new
env is parsed:

```bash
docker compose -f docker-compose.prod.yml up -d --force-recreate app worker scheduler
```

Reddit shares the ScrapeCreators prepaid balance with Instagram + TikTok, so
if imports stop, check the shared budget under `/admin/quota` — an exhausted
daily cap or prepaid balance pauses all three until it refills / resets.

---

## Future: bring back automated deploy

If you ever finish the restricted-SSH-key setup documented in
`docs/deploy/install.md §1`, the original `scripts/deploy.sh` shape is
fine to revive. Keep the manual path as the canonical reference even
then — automation should mirror documented steps, not replace
understanding.
