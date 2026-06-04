# Self-host quick-start

Run your own Neotolis Game Promotion Diary on any Linux host with Docker. This
is the generic, proxy-agnostic path. (The author's specific aeza + Cloudflare
production runbook lives at [`docs/deploy/install.md`](../deploy/install.md) — you
don't need it to self-host.)

**Same image as the SaaS.** The hosted instance and your self-host run the exact
same Docker image, schema, and code. Only the environment differs — there are no
`APP_MODE`-conditioned features and no managed-service dependencies in the
critical path. If it boots with the env below, it behaves identically to the
SaaS.

## Requirements

- A Linux host with Docker + the Docker Compose plugin.
- A Google account to create an OAuth client (the only login method).
- A domain if you want public TLS (or use a Tunnel / a trusted LAN — see
  [reverse proxy](#choose-a-reverse-proxy)).

## 1. Minimal environment

Five values are all you need to boot. Copy `.env.example` to `.env` for the full
documented list (every variable in the app's schema); the rest have safe
defaults.

```bash
# A random Better Auth secret (min 32 chars):
openssl rand -base64 48

# The key-encryption key — must decode to exactly 32 bytes (AES-256):
openssl rand -base64 32
```

| Variable             | What it is                                                              |
| -------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`       | Postgres connection string. The compose file provides one by default.  |
| `BETTER_AUTH_URL`    | The canonical URL users reach (e.g. `https://diary.example.com`).      |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 48`.                                              |
| `OAUTH_CLIENT_ID`    | From the Google Cloud Console OAuth client.                            |
| `OAUTH_CLIENT_SECRET`| From the same Google OAuth client.                                     |
| `APP_KEK_BASE64`     | `openssl rand -base64 32` (decodes to 32 bytes — boot fails otherwise).|

> Create the Google OAuth client in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials):
> an "OAuth client ID" of type *Web application*, with the authorized redirect
> URI set to `<BETTER_AUTH_URL>/api/auth/callback/google`.

See [`.env.example`](../../.env.example) for every other variable (limits,
retention window, admin allowlist, Reddit/YouTube keys, observability) — all
optional with documented defaults.

## 2. Boot it

The shipped self-host compose file runs the app, a background worker, a
scheduler, and Postgres 16 from one image:

```bash
APP_KEK_BASE64=$(openssl rand -base64 32) \
BETTER_AUTH_SECRET=$(openssl rand -base64 48) \
BETTER_AUTH_URL=https://diary.example.com \
OAUTH_CLIENT_ID=...your-google-client-id... \
OAUTH_CLIENT_SECRET=...your-google-client-secret... \
docker compose -f docker-compose.selfhost.yml up -d --build
```

Migrations run automatically at container boot under an advisory lock. The app
serves on port `3000`. With nothing in front you can reach it at
`http://<host>:3000`; for real use, put a reverse proxy in front for TLS.

Check it came up:

```bash
docker compose -f docker-compose.selfhost.yml ps
curl -fsS http://localhost:3000/readyz && echo OK
```

## 3. Choose a reverse proxy

The app honors trusted-proxy headers behind any of: a bare port, nginx, Caddy,
or a Cloudflare Tunnel. The only thing that changes per topology is the single
`TRUSTED_PROXY_CIDR` value.

See [`reverse-proxy/`](./reverse-proxy/README.md) for the full parity matrix and
copy-pasteable configs:

- **Bare port** — leave `TRUSTED_PROXY_CIDR` empty (trusted LAN / Tailscale).
- **Caddy** — automatic Let's Encrypt TLS; `127.0.0.1/32` same-host.
- **Cloudflare Tunnel** — hidden origin; `172.16.0.0/12` (the bridge subnet,
  **not** CF edge IPs — a common foot-gun, explained there).
- **nginx** — the shipped example at the repo root (`nginx/`).

## 4. Operate it

- **Backups** — [`backups.md`](./backups.md): provider-agnostic Postgres dumps to
  R2 / B2 / Wasabi / S3 / MinIO.
- **Data export** — [`data-export.md`](./data-export.md): the GDPR Article 15
  per-user JSON export.
- **KEK rotation** — [`kek-rotation.md`](./kek-rotation.md): rotating the
  key-encryption key without downtime.

## Notes

- **Privacy by default.** All data is scoped to the signed-in user; there are no
  public dashboards or share links.
- **Optional integrations degrade gracefully.** Leave `SERVICE_YOUTUBE_API_KEYS`
  / `REDDIT_USER_AGENT` empty and those importers simply stay disabled — the app
  boots and works.
- **`/metrics` is off by default.** Set `METRICS_BEARER_TOKEN` only if you run
  the monitoring overlay (`docker-compose.monitoring.yml`).
