# Production Deploy Runbook

This document walks the operator through provisioning a production deploy of
**Neotolis Game Promotion Diary** on an aeza VPS with Cloudflare-fronted TLS.

It is read top-to-bottom once during initial provisioning, then §5
("Ongoing operations") and §6 ("UAT") are consulted on every deploy.

The runbook is the **manual-prerequisite contract** per D-PRE: Phase 02.2
ships code + docs + scripts; the operator (author) executes the manual
VPS provisioning AFTER Phase 02.2 sign-off using these documents. CI is
unaffected (continues to use OAuth mock + ephemeral test KEK + Postgres
service container — no production-secrets dependency).

**Prerequisites the operator must complete BEFORE following this runbook:**

- [ ] aeza VPS purchased — any plan with at least **2 GB RAM + 2 vCPU + 20 GB SSD**, Ubuntu 24.04 LTS image
- [ ] Cloudflare account exists (the same account is used for the domain registrar AND R2)
- [ ] GitHub account with admin access to the `d954mas/neotolis-diary` repo (needed for GHCR package-visibility flip)
- [ ] A Google account that will own the production OAuth Client (the OAuth Console "support email" is shown to every signing-in user)
- [ ] An SSH keypair on the operator's workstation (`ssh-keygen -t ed25519` if you don't already have one); the public key goes onto the VPS in §1, the private key never leaves the workstation
- [ ] Local `pnpm` + `wrangler` installed for the rollback script (§5) and R2 bucket-lock setup (§2 step 7)

If any of the above is missing, stop and fix it first — the runbook below assumes they are in place.

---

## §1 — VPS provisioning + hardening

After SSHing into the fresh aeza VPS as `root`, run the following sequence
verbatim. Each block is idempotent — re-running is safe.

### Step 1 — apt update + automatic security updates

```bash
apt update && apt full-upgrade -y
apt install -y unattended-upgrades fail2ban ufw
dpkg-reconfigure --priority=low unattended-upgrades  # interactive: enable
```

`unattended-upgrades` ships security patches automatically without operator
action; this is the cheapest defense-in-depth control on a VPS.

### Step 2 — UFW firewall (default deny inbound)

```bash
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp                  # rate-limit ssh (UFW's built-in: 6/min/source)
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

UFW's `limit` profile mitigates SSH brute-force at the network layer
(orthogonal to fail2ban's application-layer detection in step 5).

### Step 3 — Non-root deploy user

```bash
useradd -m -s /bin/bash deploy
usermod -aG docker deploy
mkdir -p /home/deploy/.ssh
# (paste author's restricted public key into /home/deploy/.ssh/authorized_keys; see "Restricted SSH key" below)
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
```

The `docker` group is created by the docker-ce install in step 4; you may
need to run step 4 first then come back to add `deploy` to the group.

### Step 4 — Install Docker + compose plugin

```bash
apt install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  | tee /etc/apt/sources.list.d/docker.list >/dev/null
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Verify: `docker --version` and `docker compose version` both print without
errors.

### Step 5 — SSH hardening (after deploy user is set up + tested)

```bash
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?KbdInteractiveAuthentication.*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

**WARNING:** before running this, open a **second** SSH session as `deploy`
to confirm the key works. If the deploy user's key isn't in place,
restarting sshd here locks you out — aeza's web console can recover but it
is friction.

### Step 6 — fail2ban sshd jail

```bash
cat > /etc/fail2ban/jail.d/sshd.local <<EOF
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl restart fail2ban
```

### Step 7 — Docker daemon log rotation

```bash
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<EOF
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF
systemctl restart docker
```

This caps each container's stdout log at 30 MB total (10 MB × 3 files).
Unbounded `docker logs` was the #1 cause of disk-full incidents on the
author's prior `game_idea_founder` deploys.

### Step 8 — Auto-recovery on reboot (D-22a)

```bash
systemctl enable docker     # already enabled by default on 24.04
systemctl enable cron       # already enabled by default on 24.04
systemctl is-enabled docker # expect: enabled
systemctl is-enabled cron   # expect: enabled
```

Both are enabled by default on Ubuntu 24.04 / Debian 12, but explicit
verification is part of the runbook checklist. Combined with the
`restart: unless-stopped` directive on every service in
`docker-compose.prod.yml`, the entire stack — app, worker, scheduler,
postgres, nginx, AND the backup cron — comes back without operator
action after an unexpected reboot. See §6 step 8 for the verification
procedure.

### Restricted SSH key for the deploy user

The `deploy` user's `authorized_keys` line uses a `command="..."`
restriction so that any inbound SSH session ONLY runs the deploy command.
This is the key `pnpm deploy` (§5) uses.

Paste this verbatim into `/home/deploy/.ssh/authorized_keys` (substitute
your own ed25519 public key):

```
command="cd /opt/diary && docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... author@local
```

Two-key model: the **restricted** key for `pnpm deploy`; a **second
unrestricted** key for the operator's debugging SSH and `pnpm
deploy:rollback` (which needs to edit `.env` before running compose). Keep
the unrestricted key on a separate workstation account so a compromised
deploy key cannot escalate.

---

## §2 — Domain + Cloudflare setup

### Step 1 — Choose a domain

Recommended candidates (subject to availability — confirm at registration
time):

| Candidate | TLD price (CF Registrar, 2026-05-01) | Notes |
|-----------|--------------------------------------|-------|
| `gamediary.app` | $14.20/yr | First choice. Describes the product; `.app` has HSTS-preload built into the TLD. |
| `promodiary.app` | $14.20/yr | Alternate angle (promotion-focused). |
| `neotolis.games` | $26.20/yr | Project-themed; matches `neotolis.games@gmail.com` brand. Pricier. |

Verify pricing at `https://cfdomainpricing.com/` before purchasing —
prices drift.

### Step 2 — Register via CF Registrar

In the Cloudflare dashboard → Domain Registration → Register Domains.
Cloudflare Registrar charges at-cost (no markup); the domain auto-adds to
your CF account on completion.

### Step 3 — Create A record pointing at VPS IP

In the CF dashboard → DNS → Records → Add record:

- Type: `A`
- Name: `@` (or `diary` for a subdomain — adjust everywhere accordingly)
- IPv4 address: your aeza VPS public IP
- Proxy status: **Proxied** (orange cloud)
- TTL: Auto

The orange cloud is mandatory — it's what gives you free TLS, DDoS
shield, and edge cache. Without it, you'd have to install certbot and
manage cert rotation yourself.

### Step 4 — SSL/TLS settings — Full

CF dashboard → SSL/TLS → Overview → set encryption mode to **Full**.

With Full, Cloudflare → origin is plain HTTP (matches our nginx `listen
80;`). With Full (Strict), the origin would need a valid TLS cert — that's
extra runbook effort with no security gain inside CF's network. **Do not**
use Flexible (it leaks plaintext from CF to origin even when the user
typed `https://`).

### Step 5 — Page Rule: bypass cache for `/api/*`

CF dashboard → Rules → Page Rules → Create Page Rule:

- URL pattern: `<DOMAIN>/api/*`
- Setting: `Cache Level` = `Bypass`

**Why:** Cloudflare's edge cache may otherwise serve a stale OAuth
callback response, breaking subsequent logins (Pitfall 2). Better Auth's
OAuth handlers don't emit `Cache-Control: no-store` headers, so we
bypass at the CDN.

### Step 6 — R2: create bucket `diary-backups`

CF dashboard → R2 → Create bucket → name: `diary-backups` (or operator's
chosen name; configure `RCLONE_BUCKET` in §4 step 4 accordingly).

Free tier covers 10 GB-month + 1M Class A ops + 10M Class B ops — well
above projected backup volume (~1.5 GB/month).

### Step 7 — R2 bucket-locks (immutability)

R2 calls Object Lock "bucket locks" (Pitfall 6). Apply a 30-day
retention rule via Wrangler (run from operator's workstation, not the VPS):

```bash
npx wrangler r2 bucket lock add diary-backups --prefix '' --age-seconds 2592000
```

`2592000` seconds = 30 days; matches D-25 retention. The lock takes
precedence over any lifecycle rule, so even a compromised root account
on the VPS cannot wipe backups inside the retention window.

### Step 8 — R2 API tokens

Two tokens: **write-only** (lives on VPS, used by `scripts/backup.sh`) and
**admin** (lives on operator's local machine for monthly cleanup +
restore).

CF dashboard → R2 → Manage R2 API Tokens → Create API Token:

1. Token 1: scope = `Object Read & Write`, bucket = `diary-backups` only.
   Save the access key ID + secret on the VPS in `~/.config/rclone/rclone.conf`
   (configured interactively in `docs/self-host/backups.md` §2).
2. Token 2: scope = `Admin Read & Write`, account-wide. Save on
   workstation only — never copy to the VPS.

---

## §3 — Google OAuth Client setup

### Step 1 — Create OAuth Client

`https://console.cloud.google.com/` → APIs & Services → Credentials →
Create Credentials → OAuth Client ID.

- Application type: **Web application**
- Name: `Neotolis Diary (production)`

### Step 2 — Authorized JavaScript origins

Add: `https://<DOMAIN>` (substitute your registered domain — exact
hostname, no trailing slash, no path).

### Step 3 — Authorized redirect URIs

Add: `https://<DOMAIN>/api/auth/callback/google` — **EXACTLY** that URI,
no trailing slash, no http (Pitfall 3 — trailing-slash divergence breaks
login silently with `redirect_uri_mismatch`).

This must match what Better Auth sends. The default `OAUTH_PROVIDER_ID=google`
in `src/lib/server/config/env.ts` produces the path
`/api/auth/callback/google`.

### Step 4 — Copy credentials into VPS .env

After clicking Create, Google reveals the Client ID + Client Secret.
Paste these into the VPS `.env` (created in §4 step 4):

```bash
OAUTH_CLIENT_ID=<from console>
OAUTH_CLIENT_SECRET=<from console>
```

### Step 5 — OAuth verification submission

Cloud Console → OAuth consent screen → fill out:

- App home page URL: `https://<DOMAIN>/about`
- Application privacy policy URL: `https://<DOMAIN>/privacy`
- Application Terms of Service URL: `https://<DOMAIN>/terms`
- Application logo: skip if none
- Scopes: keep defaults (`openid`, `email`, `profile`)
- Test users: add operator's own Google account during dev (not needed
  once verified)

Submit for verification. Google review takes **1–6 weeks** (D-20).
Phase 02.2 SHIPS WITH the unverified-app warning visible — this is
normal until Google approves; allowed for fewer than 100 users. Track
status in Cloud Console weekly.

---

## §4 — First deploy

### Step 1 — SSH into VPS as deploy user

```bash
ssh deploy@<vps-ip>     # uses unrestricted key during initial setup
```

The restricted key (with `command="..."`) only works for the actual
deploy invocation; for first-time provisioning + .env editing, use the
unrestricted key.

### Step 2 — Clone the repo

```bash
sudo mkdir -p /opt/diary
sudo chown deploy:deploy /opt/diary
git clone https://github.com/d954mas/neotolis-diary.git /opt/diary
cd /opt/diary
```

`/opt/diary` is the canonical install path (matches the `command="cd
/opt/diary && ..."` restriction in the deploy key).

### Step 3 — Generate production secrets ONCE

```bash
POSTGRES_PASSWORD=$(openssl rand -base64 32)
BETTER_AUTH_SECRET=$(openssl rand -base64 48)
APP_KEK_BASE64=$(openssl rand -base64 32)

echo "POSTGRES_PASSWORD=$POSTGRES_PASSWORD"
echo "BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET"
echo "APP_KEK_BASE64=$APP_KEK_BASE64"
```

**NEVER commit these.** They go straight into `.env` (gitignored). If
you lose `APP_KEK_BASE64`, every envelope-encrypted secret in the DB is
unrecoverable — back it up to a password manager / GPG-encrypted file
on the operator's workstation.

### Step 4 — Create `.env` from `.env.example`

```bash
cp .env.example .env
$EDITOR .env
```

Fill in:

| Variable | Value |
|----------|-------|
| `DOMAIN` | the registered domain from §2 step 2 |
| `SUPPORT_EMAIL` | the operator's Google contact email (shown on `/privacy`, `/terms`, `/about`, footer) |
| `BETTER_AUTH_URL` | `https://<DOMAIN>` |
| `DATABASE_URL` | `postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/neotolis` |
| `OAUTH_CLIENT_ID` | from §3 step 4 |
| `OAUTH_CLIENT_SECRET` | from §3 step 4 |
| `APP_KEK_BASE64` | from §4 step 3 |
| `KEK_CURRENT_VERSION` | `1` (default) |
| `BETTER_AUTH_SECRET` | from §4 step 3 |
| `POSTGRES_PASSWORD` | from §4 step 3 |
| `TRUSTED_PROXY_CIDR` | paste the contents of `nginx/cf-ips.conf`, comma-separated CIDRs (no `set_real_ip_from`/`;` syntax) |
| `LIMIT_GAMES_PER_USER` | leave default `50`, or omit to use the schema default |
| `LIMIT_SOURCES_PER_USER` | leave default `50` |
| `LIMIT_EVENTS_PER_DAY` | leave default `500` |
| `IMAGE_TAG` | `latest` (rollback overwrites this — see §5) |
| `BETTER_AUTH_SECURE_COOKIES` | leave unset for direct-TLS; or `false` if testing behind a non-TLS reverse proxy |

Set restrictive perms:

```bash
chmod 600 .env
```

### Step 5 — GHCR image visibility flip

The first push of `ghcr.io/d954mas/neotolis-diary` creates a **private**
package by default — anonymous `docker pull` returns 401 (Pitfall 1).
Open this URL in a browser:

`https://github.com/users/d954mas/packages/container/neotolis-diary`

Then: Package settings → "Change visibility" → **Public** → confirm. Now
the image inherits the public-repo trust model (D-S1), and self-host
operators can `docker pull` without authentication.

This step is one-time; subsequent CI builds inherit the visibility.

### Step 6 — Pull + start the stack

```bash
cd /opt/diary
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

`pull` downloads the GHCR images for app/worker/scheduler at the tag
specified by `IMAGE_TAG`. `up -d` brings up postgres + app + worker +
scheduler + nginx in the right order (depends_on with healthcheck on
postgres).

Migrations run automatically on app boot under advisory lock (D-23) —
no manual `pnpm db:migrate` step required.

### Step 7 — Verify all services are running

```bash
docker compose -f docker-compose.prod.yml ps
```

All five services should show `running` with healthy postgres. Tail
logs for any boot errors:

```bash
docker compose -f docker-compose.prod.yml logs --tail=50 app worker scheduler
```

### Step 8 — Verify the health endpoint

```bash
curl -fsS https://<DOMAIN>/healthz
# expect: {"status":"ok"} or similar 200
```

If `/healthz` is 200, the app is up + connected to postgres + migrations
have applied + better-auth is initialized.

### Step 9 — First-user signup + UAT

Visit `https://<DOMAIN>/login` in a browser, click "Continue with Google",
sign in with the operator's Google account. Run UAT steps 1–7 from §6.

---

## §5 — Ongoing operations

### Deploy

From the operator's workstation:

```bash
DEPLOY_HOST=<DOMAIN> pnpm deploy
```

The `pnpm deploy` script SSHes via the restricted `command="..."` key,
which runs `docker compose pull && up -d` on the VPS. Then it polls
`/healthz` and exits non-zero if the new build is unhealthy (rolling-back
is then a manual decision — see Rollback below).

### Rollback

```bash
DEPLOY_HOST=<DOMAIN> pnpm deploy:rollback <previous-git-sha>
```

The script SSHes via the **unrestricted** key, sed-edits `IMAGE_TAG=<sha>`
into `/opt/diary/.env`, then runs `docker compose pull` + `up -d`. Within
~30 seconds the stack is back on the previous image. Verify with
`/healthz`.

Recover the previous SHA from `git log --oneline master | head -5` (every
master push triggers a tagged GHCR build).

### Backup verification (monthly)

```bash
rclone ls r2:diary-backups | tail -10
```

Expect daily entries `<YYYY-MM-DD>.sql.gz`, each ~5–50 MB. If gaps
appear, inspect the cron log:

```bash
ssh deploy@<vps-ip> 'tail -50 /var/log/diary-backup.log'
```

### Log inspection

```bash
ssh deploy@<vps-ip> 'docker compose -f /opt/diary/docker-compose.prod.yml logs --tail=200 app'
ssh deploy@<vps-ip> 'sudo journalctl -u docker.service --since="1 hour ago"'
```

Logs rotate at 10 MB × 3 files per container (configured in §1 step 7).

### CF IP refresh (quarterly)

Cloudflare publishes their IPv4/v6 ranges at
`https://www.cloudflare.com/ips-v4` and `/ips-v6`. The bundled
`nginx/refresh-cf-ips.sh` regenerates `nginx/cf-ips.conf`:

```bash
cd /opt/diary
bash nginx/refresh-cf-ips.sh
docker compose -f docker-compose.prod.yml restart nginx
```

Calendar this for the first of every quarter. Stale CF ranges cause
trusted-proxy walking to silently fail (proxy-trust.ts ignores
`CF-Connecting-IP` from non-trusted upstreams — secure-by-default).

### OAuth verification follow-up

Until Google approves the OAuth Client (1–6 weeks), users see an
"unverified app" warning. Check Cloud Console weekly. Once verified,
the warning disappears automatically — no redeploy needed.

### UptimeRobot setup (one-time, free tier)

`https://uptimerobot.com` → free account → New Monitor:

- Monitor type: HTTP(s)
- URL: `https://<DOMAIN>/healthz`
- Interval: 5 minutes
- Alert contacts: Telegram bot + email; configure both, alert on
  **2 consecutive failures** to avoid CF-edge transient blips paging at 3 AM

D-26: mandatory for open-signup launch. A 502 with no monitoring means
the user is gone forever (they don't come back to retry).

### Backup setup (one-time)

See `docs/self-host/backups.md` for the rclone interactive flow + crontab
line. Same script + same crontab line work for self-host operators.

### Failure modes (D-22a)

| Failure | Recovery | ETA |
|---------|----------|-----|
| VPS deletion (aeza account closed, etc.) | Provision new VPS following §1 + §4. Restore latest backup: `rclone copy r2:diary-backups/<latest>.sql.gz /tmp/` then `docker exec -i diary_postgres pg_restore -U postgres -d neotolis -c < /tmp/<latest>.sql.gz`. Update DNS A record to new IP. | ~30 min |
| Cloudflare outage (rare) | No VPS action needed — UptimeRobot will alert; CF restores within minutes; users will see "Cloudflare error" page in the meantime. | external |
| Deploy interrupted (network drop mid-`docker compose pull`) | Re-run `pnpm deploy`. Idempotent — `pull` is incremental, `up -d` is a no-op if containers are already on the target image. | ~1 min |
| Data corruption (e.g. a buggy migration on master, caught in prod after merge) | Restore from latest R2 backup using the **admin** R2 token from the operator's workstation (see §2 step 8): download via rclone, `pg_restore -d neotolis -c`. Then `pnpm deploy:rollback <previous-sha>` to pin to the last-good code. | ~15 min |
| OAuth verification revoked by Google | Resubmit per §3 step 5. Users will see the unverified-app warning again until reapproved. App functions normally otherwise. | weeks |

---

## §6 — Russian UAT (post-deploy smoke)

Этот блок — единственный раздел рунбука на русском (per AGENTS.md USER
memory: "Russian for technical conversations + UAT step-by-step"). Запускается
автором после первого деплоя, плюс выборочно после каждого `pnpm deploy`.

- [ ] **Шаг 1 — Регистрация:** Открыть `https://<DOMAIN>/login`. Нажать
      "Continue with Google". Авторизоваться. Ожидать: попасть на `/feed`.
      Проверить: `GET /api/me` возвращает email из Google.
- [ ] **Шаг 2 — Первая игра:** Перейти на `/games` (или `/feed` → "Создать
      игру"). Создать игру с названием "Test". Ожидать: 200 OK, виден в
      списке.
- [ ] **Шаг 3 — Лимиты:** Через curl создать 51-ю игру:
      ```
      for i in $(seq 1 51); do \
        curl -s -b cookies.txt -X POST https://<DOMAIN>/api/games \
          -H 'content-type: application/json' \
          -d "{\"title\":\"test-$i\"}"; \
      done
      ```
      Ожидать: 51-й вызов возвращает 429 с body
      `{error:"quota_exceeded", metadata:{kind:"games", limit:50, current:50}}`.
      Открыть `/audit` — есть событие `quota.limit_hit`.
- [ ] **Шаг 4 — Privacy/Terms/About:** Открыть `/privacy`, `/terms`,
      `/about`. Ожидать: 200 на каждой странице, контактный email =
      `SUPPORT_EMAIL` из `.env`, на `/about` есть ссылка на GitHub-репозиторий.
- [ ] **Шаг 5 — Экспорт:** В `/settings/account` нажать "Export my data".
      Ожидать: скачивается `diary-export-YYYY-MM-DD.json`. Открыть и
      проверить: есть ключи `exported_at`, `user`, `games`, `data_sources`,
      `events`, `api_keys_steam`, `audit_log`. НЕТ литеральных подстрок
      `secret_ct`, `wrapped_dek`, `googleSub`, `refreshToken`, `accessToken`,
      `idToken` (`grep -E '(secret_ct|wrapped_dek|googleSub|refreshToken|accessToken|idToken)' diary-export-*.json` должен ничего не находить).
- [ ] **Шаг 6 — Удаление + восстановление:** В `/settings/account` нажать
      "Delete my account". Подтвердить через "Type DELETE" dialog. Ожидать
      200, redirect на `/login`. Попытка вернуться в `/feed` со старой
      cookie → 401. Зайти заново через "Continue with Google" — ожидать
      banner "Account scheduled for deletion in 60 days." Нажать "Restore
      my account". Ожидать: банер исчезает, все игры из шага 2 возвращены.
- [ ] **Шаг 7 — UptimeRobot:** Подождать 5 минут после первого деплоя.
      Проверить, что monitor показывает зелёный, Telegram-бот не
      алертит, email-уведомлений нет.
- [ ] **Шаг 8 — Reboot test (D-22a):** `sudo reboot` на VPS. Ждать 60
      секунд. Ожидать: `curl https://<DOMAIN>/healthz` возвращает 200;
      UptimeRobot timeline без даунтайма >5 минут (один промежуточный
      ping может пропасть — это нормально).
- [ ] **Шаг 9 — Backup:** Дождаться 03:00 UTC (или ручной запуск
      `/usr/local/bin/diary-backup` под пользователем `root` для немедленной
      проверки). Проверить:
      - `tail /var/log/diary-backup.log` — строка `backup <дата> OK
        (<size> bytes)` за сегодня.
      - `rclone ls r2:diary-backups | tail -5` — есть `<сегодня>.sql.gz`.
- [ ] **Шаг 10 — Rollback:** Выкатить новый деплой через push в master,
      дождаться `docker-build-publish` job, потом откатить:
      `pnpm deploy:rollback <previous-sha>`. Ожидать: смена `IMAGE_TAG`
      в `/opt/diary/.env`, `docker compose pull` + `up -d`, `/healthz`
      200 в течение 30 секунд.

Каждый шаг помечается галочкой после успешного прохождения. Если хотя бы
один шаг не прошёл — Phase 02.2 не подписан, фикс приоритетный.

---

## §7 — FAQ / Pitfalls

A registry of every "if X happens, do Y" rooted in the 12 numbered
pitfalls from `.planning/phases/02.2-ship-to-prod/02.2-RESEARCH.md`
"Common Pitfalls" section. If something looks wrong post-deploy, scan
this section first — there's a high chance it's listed.

### GHCR image returns 401 on docker pull from a clean machine

GHCR visibility defaults to **private** (Pitfall 1). Flip to public via
the URL in §4 step 5: `https://github.com/users/d954mas/packages/container/neotolis-diary`
→ Package settings → Change visibility → Public.

Symptom: `docker pull ghcr.io/d954mas/neotolis-diary:latest` returns
`unauthorized` even though the Git repo is public.

### Sporadic OAuth login failures ("invalid state token")

Cloudflare's edge cache may serve a stale `/api/auth/callback/google`
response (Pitfall 2). Fix: ensure §2 step 5 Page Rule (`URL pattern:
<DOMAIN>/api/*` → `Cache Level = Bypass`) is in place. Verify with
`curl -I https://<DOMAIN>/api/health` — response should NOT carry
`cf-cache-status: HIT`.

### "Error: redirect_uri_mismatch" on first login

The redirect URI in Google Cloud Console doesn't EXACTLY match what
Better Auth sends (Pitfall 3). Trailing slash, http vs https, port number
all matter. Re-verify §3 step 3: the Authorized redirect URI must be
`https://<DOMAIN>/api/auth/callback/google` (no trailing slash, https not
http, no port).

### Account-delete: stale tabs still show authenticated UI for ~seconds

This is expected (Pitfall 4). Better Auth's session validation re-reads
the DB on every request — the next request from a stale tab gets 401.
The DB row deletion is the load-bearing barrier; in-memory caches in
other workers self-correct on next request.

### `pnpm db:check` fails after a PR merge with "schema drift"

Two PRs probably both added migration `0009_*.sql`; one merged first;
the other has stale numbering (Pitfall 5). Fix: rebase the offending PR,
rename the migration file to the next number, regenerate
`drizzle/meta/_journal.json`, force-push.

### "How do I enable Object Lock on my R2 bucket?"

R2 calls it **bucket locks**, not Object Lock (Pitfall 6). It CAN be
enabled on existing buckets via Wrangler (NOT via the dashboard for
prefix locks). See §2 step 7.

### After `docker compose stop`, containers come back on host reboot

Use `restart: unless-stopped` (Pitfall 7), not `restart: always`. The
`docker-compose.prod.yml` template ships with `unless-stopped` already.
A deliberate `docker compose stop` survives a host reboot (operator
intent preserved).

### `journalctl | grep diary-backup` shows two firings within seconds

Operator probably ran `crontab -e` twice and ended up with two backup
cron entries (Pitfall 8). The `flock -n /var/lock/diary-backup.lock`
guard at the top of `backup.sh` keeps the second invocation from
duplicating work; just clean up the duplicate crontab line.

### Self-host user reports a feature missing that "works for me"

Probably someone added `if (env.APP_MODE === 'saas') { ... }` somewhere
in `src/` (Pitfall 9). The CI grep step in
`.github/workflows/ci.yml` (extended in Plan 02.2-07) catches this.
The smoke gate boots `docker-compose.selfhost.yml` with no
SaaS-specific env vars — anything that doesn't work in selfhost.yml
fails the gate.

### Privacy Policy claim "OAuth tokens encrypted at rest" doesn't match reality

In Phase 02.2, only `api_keys_*` tables (Phase 2 envelope-encryption) are
truly encrypted at rest. Better Auth's `account.refresh_token` /
`access_token` / `id_token` are stored as `text` (plaintext, TLS in
transit). Privacy Policy in `/privacy` accurately discloses this; do
not "improve" the wording without first encrypting the underlying
schema (Phase 6 territory).

### Build-time env placeholders showing in `docker history`

Already mitigated (Pitfall 11). The Dockerfile's runtime stage starts
fresh `FROM node:22-alpine`, NOT from the build stage; build-stage
placeholder env vars (e.g. dummy KEK for SvelteKit module init) don't
propagate into the runtime image. Verified once during Phase 1 review;
no operator action needed.

### TypeScript error: "Property 'deletedAt' does not exist on type 'PgTable...'"

Migration `0008_add_user_soft_delete_and_account_audit_actions.sql`
adds the column; the Drizzle schema file `src/lib/server/db/schema/auth.ts`
adds the field. If you see this error in a fresh checkout, you missed
running migrations (`docker compose up -d` runs them automatically on
boot, but local dev needs `pnpm db:migrate`).

---

*Runbook last reviewed: 2026-05-03 (Phase 02.2 Plan 08)*
*Next review: when Phase 3 (polling pipeline) lands new env vars or
new external dependencies (Resend / SMTP / etc.).*
