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
docker compose -f docker-compose.prod.yml up -d                     # restart app/worker/scheduler
docker restart diary-nginx-1                                        # workaround: nginx upstream IP cache
exit
curl -fsS https://neotolis-diary.dev/healthz                        # 200 → live
```

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
- `.env.example` — new env vars to mirror into `.env`
- `nginx/nginx.conf.template` — proxy config changed
- `docs/deploy/*` — operator-facing docs

```bash
git pull
```

### 4. Update `.env` if new vars were added

Compare `.env.example` against your live `.env`:

```bash
diff .env.example .env | grep -E "^<"
```

Add any new keys to `.env`. **Phase 03.1 (Reddit) added:**

| Var | Required? | What to set |
|---|---|---|
| `REDDIT_USER_AGENT` | yes for Reddit features | `node:com.neotolis.gpd:0.1.0 (by /u/<your-handle>)` — see `.env.example` for the convention. Leave empty to disable Reddit cleanly. |
| `REDDIT_BASE_URL_OVERRIDE` | no | TEST-ONLY. Leave **unset** in production. |

Save and close.

### 5. Pull the new image and restart

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

What this does:

- `pull` — fetches the new `ghcr.io/d954mas/neotolis-diary:latest`
  built by master CI.
- `up -d` — recreates the `app`, `worker`, `scheduler` containers with
  the new image. Postgres + nginx stay up.
- App container boot runs `runMigrations()` automatically (advisory-
  locked, idempotent — see `src/server.ts`). Schema changes land here.

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

For Phase 03.1 specifically, also verify:

- `/admin` → Reddit Ops panel renders (operator-visible queue stats).
- `/sources/new` → Reddit chip appears, backfill picker shows up after
  selecting it.
- `docker compose logs worker | grep -E "reddit (batch-worker|sub_poll|posts-refresh)"`
  — confirms the 8-tick batch worker started and is draining the queue.

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

---

## Future: bring back automated deploy

If you ever finish the restricted-SSH-key setup documented in
`docs/deploy/install.md §1`, the original `scripts/deploy.sh` shape is
fine to revive. Keep the manual path as the canonical reference even
then — automation should mirror documented steps, not replace
understanding.
