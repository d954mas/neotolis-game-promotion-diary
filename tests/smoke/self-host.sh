#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Self-host smoke test
# ============================================================
# Scope: boot + auth happy path + tenant scope hold + all three roles
# dispatch correctly + i18n message resolution + no SaaS-only assumption
# leaked.
#
# Asserts these invariants:
#   1. APP_ROLE=app boots (image ENTRYPOINT); /healthz 200; /readyz 200 after migrations
#   2. APP_ROLE=worker boots (image ENTRYPOINT); stdout contains "worker ready"
#   3. APP_ROLE=scheduler boots (image ENTRYPOINT); stdout contains "scheduler ready"
#   4. OAuth login (mocked via oauth2-mock-server) lands on /api/me with the
#      seeded user; dashboard renders Paraglide English text
#   5. Cross-tenant: user B's /api/me returns user B (NOT user A's email);
#      anonymous /api/me returns 401
#   6. Minimal env (no CF_*, no ANALYTICS_*) is sufficient for boot
# Time budget: <5 min on GitHub-hosted runners.
#
# ALL `docker run` commands below use the image's actual ENTRYPOINT
# (defined in Dockerfile as ["node", "build/server.js"]). NO `sh -c`
# wrapper. NO entrypoint override. This is the production startup path
# under test — the whole point of the smoke gate is to exercise the same
# code path a self-host operator runs.

# CI-only by default. ALLOW_LOCAL_SMOKE=1 is the documented opt-in for
# local testing.
if [[ -z "${CI:-}" ]] && [[ -z "${ALLOW_LOCAL_SMOKE:-}" ]]; then
  echo "self-host smoke is CI-only by default. Set ALLOW_LOCAL_SMOKE=1 to run locally."
  exit 0
fi

APP_PORT="${SMOKE_APP_PORT:-3000}"
MOCK_PORT="${SMOKE_MOCK_PORT:-9090}"
DB_URL="${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/neotolis}"
BETTER_AUTH_URL_VAL="${BETTER_AUTH_URL:-http://localhost:$APP_PORT}"
BETTER_AUTH_SECRET_VAL="${BETTER_AUTH_SECRET:-ci-smoke-better-auth-secret-32-chars-min}"
KEK_BASE64="${APP_KEK_BASE64:-MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=}"
OAUTH_CLIENT_ID_VAL="${OAUTH_CLIENT_ID:-mock-client-id}"
OAUTH_CLIENT_SECRET_VAL="${OAUTH_CLIENT_SECRET:-mock-client-secret}"
# genericOAuth plugin (review blocker P0-2 fix) reads OIDC discovery from
# this URL at boot. Smoke runs the mock IdP on localhost:$MOCK_PORT, so the
# discovery document is at http://localhost:$MOCK_PORT/.well-known/openid-configuration.
# Production self-host points at https://accounts.google.com/.well-known/openid-configuration
# (the env.ts default).
OAUTH_DISCOVERY_URL_VAL="${OAUTH_DISCOVERY_URL:-http://localhost:$MOCK_PORT/.well-known/openid-configuration}"

# ============================================================
# Helpers
# ============================================================
log() { echo "[smoke $(date +%H:%M:%S)] $*"; }
fail() {
  log "FAIL: $*"
  log "----- recent app logs -----"
  docker logs --tail 100 smoke-app 2>&1 || true
  log "---------------------------"
  exit 1
}

# Common env-var args for `docker run` — every role gets the full set.
# env.ts is module-level and validates everything at import time, so even
# the worker / scheduler roles need every var present (CLAUDE.md / Plan
# 01-01 lock this discipline).
#
# BETTER_AUTH_SECURE_COOKIES=false (review blocker P1 fix): smoke runs the
# production image (NODE_ENV=production via Dockerfile) over plain HTTP.
# Better Auth would otherwise emit `__Secure-neotolis.session_token` and
# browsers / spec-compliant clients refuse to set `__Secure-` cookies over
# HTTP — the cookie jar would be empty and the smoke driver would fail.
# This override matches what a self-host operator does behind plain HTTP
# behind a reverse-proxy that terminates TLS.
common_env_args() {
  cat <<EOF
-e APP_MODE=selfhost
-e DATABASE_URL=$DB_URL
-e BETTER_AUTH_URL=$BETTER_AUTH_URL_VAL
-e BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET_VAL
-e OAUTH_CLIENT_ID=$OAUTH_CLIENT_ID_VAL
-e OAUTH_CLIENT_SECRET=$OAUTH_CLIENT_SECRET_VAL
-e OAUTH_DISCOVERY_URL=$OAUTH_DISCOVERY_URL_VAL
-e APP_KEK_BASE64=$KEK_BASE64
-e TRUSTED_PROXY_CIDR=
-e BETTER_AUTH_SECURE_COOKIES=false
EOF
}

cleanup() {
  log "cleanup"
  docker stop smoke-app smoke-worker smoke-scheduler 2>/dev/null || true
  docker rm   smoke-app smoke-worker smoke-scheduler 2>/dev/null || true
}
trap cleanup EXIT

# ============================================================
# 0. Image must exist
# ============================================================
log "verifying neotolis:ci image exists"
docker image inspect neotolis:ci > /dev/null || fail "image neotolis:ci not built"

# ============================================================
# 1. APP_ROLE=app — boot via image ENTRYPOINT, healthz, readyz
# ============================================================
log "(1) booting APP_ROLE=app via image ENTRYPOINT"
# shellcheck disable=SC2046
docker run -d --name smoke-app --network host \
  -e APP_ROLE=app \
  -e PORT=$APP_PORT \
  $(common_env_args) \
  neotolis:ci

# Wait up to 60s for /readyz (migrations need to apply on first boot)
log "waiting for /readyz"
ready=false
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$APP_PORT/readyz" > /dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == "true" ]] || fail "(1) /readyz never returned 200 within 60s"

curl -fsS "http://localhost:$APP_PORT/healthz" | grep -q '^ok$' \
  || fail "(1) /healthz did not return 'ok'"
curl -fsS "http://localhost:$APP_PORT/readyz" | grep -q '"ok":true' \
  || fail "(1) /readyz did not return ok:true"
log "(1) PASS — app role healthy (image ENTRYPOINT exercised)"

# ============================================================
# 2. APP_ROLE=worker — boot via image ENTRYPOINT; grep stdout for "worker ready"
# ============================================================
# CRITICAL (BLOCKER 7): use the image's actual ENTRYPOINT. NO `sh -c`,
# NO entrypoint override. The Dockerfile's ENTRYPOINT ["node", "build/server.js"]
# dispatches on APP_ROLE — that is the contract under test.
log "(2) booting APP_ROLE=worker via image ENTRYPOINT"
# shellcheck disable=SC2046
docker run -d --name smoke-worker --network host \
  -e APP_ROLE=worker \
  $(common_env_args) \
  neotolis:ci
# Stream logs and wait up to 30s for the ready signal. The worker's
# bootstrap path guarantees the literal `worker ready` appears on stdout
# (dual-emit: console.log + logger.info).
# pipefail trap: when `grep -m1` matches and exits, it closes the pipe and
# `docker logs -f` dies with SIGPIPE (nonzero); pipefail then propagates that
# failure even though grep succeeded. Disable pipefail just for this pipeline.
set +o pipefail
timeout 30 docker logs -f smoke-worker 2>&1 | grep -q -m1 "worker ready"
worker_ready=$?
set -o pipefail
if [ $worker_ready -ne 0 ]; then
  log "----- worker logs -----"
  docker logs smoke-worker 2>&1 | tail -50 || true
  log "-----------------------"
  fail "(2) worker did not print 'worker ready' within 30s"
fi
docker stop smoke-worker > /dev/null
log "(2) PASS — worker prints 'worker ready' (image ENTRYPOINT exercised)"

# ============================================================
# 3. APP_ROLE=scheduler — boot via image ENTRYPOINT; grep stdout for "scheduler ready"
# ============================================================
log "(3) booting APP_ROLE=scheduler via image ENTRYPOINT"
# shellcheck disable=SC2046
docker run -d --name smoke-scheduler --network host \
  -e APP_ROLE=scheduler \
  $(common_env_args) \
  neotolis:ci
set +o pipefail
timeout 30 docker logs -f smoke-scheduler 2>&1 | grep -q -m1 "scheduler ready"
scheduler_ready=$?
set -o pipefail
if [ $scheduler_ready -ne 0 ]; then
  log "----- scheduler logs -----"
  docker logs smoke-scheduler 2>&1 | tail -50 || true
  log "--------------------------"
  fail "(3) scheduler did not print 'scheduler ready' within 30s"
fi
docker stop smoke-scheduler > /dev/null
log "(3) PASS — scheduler prints 'scheduler ready' (image ENTRYPOINT exercised)"

# ============================================================
# 4. OAuth login flow (mocked via oauth2-mock-server) — drives the dance via tsx
# ============================================================
# OAuth mock mechanism: `oauth2-mock-server` (sidecar) replaces the
# "Better Auth test provider" mechanism that does not exist in Better
# Auth 1.6.x. The driver script `tests/smoke/lib/oauth-mock-driver.ts`
# boots the mock, configures claims, and replays the redirect dance
# manually with cookie jar accumulation.
log "(4) running OAuth dance via oauth-mock-driver (oauth2-mock-server)"
set +e
SESSION_COOKIE_A=$(pnpm -s tsx tests/smoke/lib/oauth-mock-driver.ts \
  --app-url "http://localhost:$APP_PORT" \
  --mock-port "$MOCK_PORT" \
  --sub "user-a-sub" \
  --email "alice@smoke.test" \
  --name "Alice" 2>&1)
driver_status=$?
set -e
if [ $driver_status -ne 0 ] || [[ -z "$SESSION_COOKIE_A" ]]; then
  log "----- oauth-mock-driver output (status=$driver_status) -----"
  echo "$SESSION_COOKIE_A"
  log "----- recent app logs -----"
  docker logs smoke-app 2>&1 | tail -50 || true
  log "---------------------------"
  fail "(4) OAuth dance failed (driver exit=$driver_status, cookie=${SESSION_COOKIE_A:0:80})"
fi

# Hit /api/me with the cookie — proves the tenantScope + getMe pipeline.
log "(4) /api/me with session cookie (first 60 chars): ${SESSION_COOKIE_A:0:60}..."
ME_HTTP=$(curl -s -o /tmp/me-body.txt -w '%{http_code}' -H "cookie: $SESSION_COOKIE_A" "http://localhost:$APP_PORT/api/me" || echo "curl-failed")
ME_RESPONSE=$(cat /tmp/me-body.txt 2>/dev/null || echo "")
log "(4) /api/me HTTP status=$ME_HTTP"
if [[ "$ME_HTTP" != "200" ]]; then
  log "----- /api/me response body -----"
  echo "$ME_RESPONSE"
  log "----- recent app logs -----"
  docker logs smoke-app 2>&1 | tail -80 || true
  log "---------------------------"
  fail "(4) /api/me did not return 200 (got $ME_HTTP)"
fi
echo "$ME_RESPONSE" | grep -q '"email":"alice@smoke.test"' \
  || fail "(4) /api/me did not return Alice. Got: $ME_RESPONSE"

# DTO discipline invariant: /api/me MUST NOT carry OAuth provider id or
# any token. `dto.ts` strips these even when the underlying row carries
# them; the smoke test is the runtime tripwire.
for forbidden in googleSub refreshToken accessToken idToken; do
  if echo "$ME_RESPONSE" | grep -q "$forbidden"; then
    fail "(4) /api/me leaked $forbidden! response: $ME_RESPONSE"
  fi
done

# Render the dashboard — must contain English text from Paraglide (the
# `Promotion diary` literal in messages/en.json). This is the load-bearing
# parity assertion: a self-host operator who
# pulls the production image gets a working dashboard out of the box, end to
# end (Hono outer + SvelteKit adapter-node handler + Paraglide compiled
# messages). Fatal on miss — never PARTIAL — because anything else lets a
# regression in the SvelteKit-mount path slip through to master.
log "----- pre-dashboard diagnostic: container state -----"
docker ps -a --filter name=smoke-app
docker exec smoke-app sh -c "ls -la /app/build" 2>&1 || echo "(docker exec failed)"
docker exec smoke-app sh -c "ls -la /app/build/server" 2>&1 || true
docker exec smoke-app sh -c "ls -la /app/.svelte-kit/output 2>/dev/null | head -10 || echo 'no .svelte-kit/output'" 2>&1 || true
docker exec smoke-app sh -c "head -3 /app/build/handler.js" 2>&1 || true
log "------------------------------------------------------"

# Authenticated `/` 303-redirects to `/feed` (the default landing).
# Use --location so curl follows the redirect; assert the resolved page
# carries the Paraglide title literal. The HTTP-code check accepts 200
# (final landing); the redirect itself is a transparent intermediate.
DASH_HTTP=$(curl -sL -o /tmp/dash.html -w '%{http_code}' -H "cookie: $SESSION_COOKIE_A" "http://localhost:$APP_PORT/" || echo "curl-failed")
DASH_HTML=$(cat /tmp/dash.html 2>/dev/null || echo "")
log "(4) dashboard HTTP=$DASH_HTTP body-bytes=${#DASH_HTML}"
log "----- dashboard response (first 600 chars) -----"
echo "${DASH_HTML:0:600}"
log "------------------------------------------------"
log "----- recent app logs (last 80 lines) -----"
docker logs smoke-app 2>&1 | tail -80 || true
log "-------------------------------------------"

if [[ "$DASH_HTTP" != "200" ]] || ! echo "$DASH_HTML" | grep -q "Promotion diary"; then
  fail "(4) authenticated landing (/feed via /) did not render 'Promotion diary' (Paraglide). HTTP=$DASH_HTTP"
fi
log "(4) PASS — OAuth login + /api/me + /feed (via / redirect) renders English"

# ============================================================
# 5. Cross-tenant 404 / anonymous 401 sentinel
# ============================================================
# Assert the lower-level invariants:
#   - anonymous /api/me => 401
#   - user B's /api/me returns user B; user A's email never appears in B's response
log "(5) anonymous /api/me must return 401"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$APP_PORT/api/me")
[[ "$STATUS" == "401" ]] || fail "(5) anonymous /api/me returned $STATUS (expected 401)"

log "(5) cross-tenant: user B's /api/me must NOT show A's data"
SESSION_COOKIE_B=$(pnpm -s tsx tests/smoke/lib/oauth-mock-driver.ts \
  --app-url "http://localhost:$APP_PORT" \
  --mock-port "$MOCK_PORT" \
  --sub "user-b-sub" \
  --email "bob@smoke.test" \
  --name "Bob")
[[ -n "$SESSION_COOKIE_B" ]] || fail "(5) no session cookie from OAuth dance for user B"

ME_B=$(curl -fsS -H "cookie: $SESSION_COOKIE_B" "http://localhost:$APP_PORT/api/me")
echo "$ME_B" | grep -q '"email":"bob@smoke.test"' \
  || fail "(5) user B /api/me wrong. Got: $ME_B"
if echo "$ME_B" | grep -q '"email":"alice@smoke.test"'; then
  fail "(5) CROSS-TENANT LEAK — user B saw user A!"
fi
log "(5) PASS — cross-tenant isolation"

# ============================================================
# 6. SaaS-leak invariant — runtime side
# ============================================================
# The CI workflow (.github/workflows/ci.yml) runs the source-side grep step
# before this script. Here we re-confirm at runtime: the running app
# container has NO CF_* / CLOUDFLARE_* / ANALYTICS_* env vars set —
# i.e., the minimal env from `common_env_args` is sufficient for boot.
log "(6) no SaaS-only env required"
APP_ENV=$(docker exec smoke-app printenv 2>/dev/null || echo "")
if echo "$APP_ENV" | grep -E '^(CF_|CLOUDFLARE_|ANALYTICS_)' > /dev/null; then
  echo "$APP_ENV" | grep -E '^(CF_|CLOUDFLARE_|ANALYTICS_)'
  fail "(6) container has SaaS-only env vars set; invariant violated"
fi
log "(6) PASS — no SaaS-only env vars present"

# ============================================================
# Games smoke — create + cross-tenant + sweep
# ============================================================
# Reuses SESSION_COOKIE_A (step 4) and SESSION_COOKIE_B (step 5) already
# captured above — no extra OAuth dance needed.
#
# Five assertions (additive — the six core assertions above remain intact):
#   P2.1 user A POST /api/games → 201 + DTO with id
#   P2.2 user A GET /api/games → list contains the new gameId
#   P2.3 cross-tenant: user B GET/PATCH/DELETE /api/games/<aId> → 404 (not 403)
#   P2.4 cross-tenant integrity: A's game still readable + title unchanged
#   P2.5 anon-401 sweep: every games /api/* probed with NO cookie → 401
log "=== games smoke extension ==="

# jq sanity — all P2 assertions parse JSON.
command -v jq >/dev/null 2>&1 || fail "(P2) jq required for games smoke extension"

# Pre-flight: cookies from steps 4 + 5 must be in scope.
[[ -n "${SESSION_COOKIE_A:-}" ]] || fail "(P2) SESSION_COOKIE_A missing — step 4 must run first"
[[ -n "${SESSION_COOKIE_B:-}" ]] || fail "(P2) SESSION_COOKIE_B missing — step 5 must run first"

# ---- P2.1 GAMES-01: user A creates a game ----
log "(P2.1) GAMES-01 — user A POST /api/games"
GAME_RESPONSE=$(curl -sS -X POST "http://localhost:$APP_PORT/api/games" \
  -H "cookie: $SESSION_COOKIE_A" \
  -H "content-type: application/json" \
  -d '{"title":"Smoke Test Game","notes":"created by P2 smoke"}' || true)
GAME_ID=$(echo "$GAME_RESPONSE" | jq -r '.id // empty' 2>/dev/null || true)
if [[ -z "$GAME_ID" ]]; then
  log "----- POST /api/games response body -----"
  echo "$GAME_RESPONSE"
  log "----- recent app logs -----"
  docker logs smoke-app 2>&1 | tail -50 || true
  log "---------------------------"
  fail "(P2.1) POST /api/games returned no id"
fi
log "(P2.1) created gameId=$GAME_ID"

# ---- P2.2 GAMES-03: user A lists games — must contain GAME_ID ----
log "(P2.2) GAMES-03 — user A GET /api/games"
LIST_BODY=$(curl -sS "http://localhost:$APP_PORT/api/games" -H "cookie: $SESSION_COOKIE_A" || true)
if ! echo "$LIST_BODY" | jq -e ".[] | select(.id == \"$GAME_ID\")" >/dev/null 2>&1; then
  log "----- GET /api/games response body -----"
  echo "$LIST_BODY"
  fail "(P2.2) list does not contain gameId=$GAME_ID"
fi
log "(P2.2) PASS — list contains the new gameId"

# ---- P2.3 cross-tenant: user B GET/PATCH/DELETE /api/games/<aId> → 404 ----
# Cross-tenant access surfaces as 404, NEVER 403; body must not say
# "forbidden" or "permission".
log "(P2.3) cross-tenant — user B probes /api/games/$GAME_ID"
for method in GET PATCH DELETE; do
  case "$method" in
    GET)
      RESP=$(curl -sS -o /tmp/p2-cross.txt -w '%{http_code}' \
        "http://localhost:$APP_PORT/api/games/$GAME_ID" \
        -H "cookie: $SESSION_COOKIE_B" || echo "curl-failed")
      ;;
    PATCH)
      RESP=$(curl -sS -o /tmp/p2-cross.txt -w '%{http_code}' \
        -X PATCH "http://localhost:$APP_PORT/api/games/$GAME_ID" \
        -H "cookie: $SESSION_COOKIE_B" \
        -H "content-type: application/json" \
        -d '{"title":"hacked"}' || echo "curl-failed")
      ;;
    DELETE)
      RESP=$(curl -sS -o /tmp/p2-cross.txt -w '%{http_code}' \
        -X DELETE "http://localhost:$APP_PORT/api/games/$GAME_ID" \
        -H "cookie: $SESSION_COOKIE_B" || echo "curl-failed")
      ;;
  esac
  if [[ "$RESP" != "404" ]]; then
    log "----- cross-tenant $method body -----"
    cat /tmp/p2-cross.txt 2>/dev/null
    fail "(P2.3) cross-tenant $method /api/games/$GAME_ID with B's cookie returned $RESP, expected 404"
  fi
  if grep -Eqi 'forbidden|permission' /tmp/p2-cross.txt 2>/dev/null; then
    log "----- cross-tenant $method body -----"
    cat /tmp/p2-cross.txt
    fail "(P2.3) cross-tenant $method body leaks 'forbidden' or 'permission'"
  fi
  log "(P2.3) cross-tenant $method → 404 (correct)"
done

# ---- P2.4 cross-tenant integrity: A's game intact ----
log "(P2.4) cross-tenant integrity — A's game unchanged"
A_TITLE_AFTER=$(curl -sS "http://localhost:$APP_PORT/api/games/$GAME_ID" \
  -H "cookie: $SESSION_COOKIE_A" | jq -r '.title // empty' 2>/dev/null || true)
if [[ "$A_TITLE_AFTER" != "Smoke Test Game" ]]; then
  fail "(P2.4) A's game title corrupted ('$A_TITLE_AFTER'); expected unchanged 'Smoke Test Game'"
fi
log "(P2.4) PASS — A's game intact after cross-tenant attempts"

# ---- P2.5 anon-401 sweep: every /api/* refuses anonymous access ----
# Mirrors tests/integration/anonymous-401.test.ts MUST_BE_PROTECTED — sample
# a representative subset (one per sub-router family). The integration test
# exercises all routes; this smoke check exercises 6 to keep CI fast while
# still catching middleware regressions at the production image boundary.
# The 6 routes span 5 service families: games, audit, api-keys/steam,
# items/youtube, events, youtube-channels.
log "(P2.5) anon-401 — sweeping 6 routes anonymously"
for path in /api/games /api/audit /api/api-keys/steam /api/items/youtube /api/events /api/youtube-channels; do
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$APP_PORT$path")
  if [[ "$STATUS" != "401" ]]; then
    fail "(P2.5) anonymous $path returned $STATUS, expected 401"
  fi
done
log "(P2.5) PASS — all 6 new routes return 401 anonymously"

log "=== games smoke extension PASSED ==="

# ============================================================
# Unified-flow extension
# ============================================================
# /api/sources, the unified events table, and the attach-to-game flow.
# The smoke test asserts the load-bearing user contract end-to-end
# against the production image: register YouTube data_source -> create
# youtube_video event (manual paste; sourceId=null) -> see in /feed ->
# PATCH .../attach with {gameId} -> see in /games/:gameId/events.
#
# Cross-tenant probes cover the new routes (/api/sources/:id GET +
# /api/events/:id/attach PATCH) so the AGENTS.md "404 never 403" invariant
# holds for the new tenant-owned resources too.
#
# Reuses SESSION_COOKIE_A (step 4) and SESSION_COOKIE_B (step 5) — no extra
# OAuth dance. The helper lives in tests/smoke/lib/unified-events-flow.sh
# for legibility (the function is sourced, not exec'd).
log "=== Unified-events smoke extension ==="
# shellcheck source=tests/smoke/lib/unified-events-flow.sh
source "$(dirname "$0")/lib/unified-events-flow.sh"
unified_events_smoke "http://localhost:$APP_PORT" "$SESSION_COOKIE_A" "$SESSION_COOKIE_B"
log "=== Unified-events smoke extension PASSED ==="

# ============================================================
# YouTube polling pipeline + admin parity
# ============================================================
# The full assertion chain lives in tests/smoke/lib/youtube-polling-flow.sh
# (sourced below). Summary of what it covers:
#
#   1. Boots tests/smoke/lib/youtube-mock.{mjs,sh} as a node http stub
#      on a free port; exports YOUTUBE_API_BASE_URL pointing at it.
#   2. Re-launches smoke-worker + smoke-scheduler with the polling-pipeline
#      env (SERVICE_YOUTUBE_API_KEYS=mock-key, ADMIN_EMAIL_ALLOWLIST="").
#   3. Asserts the 5 cron schedules registered in pgboss.schedule
#      (scheduler.tick.active / .cold, youtube.quota_reset, purge.daily,
#      youtube.rehab_unavailable).
#   4. Creates a kind=youtube_video event + drives /api/events/:id/refresh-poll
#      so the worker drains a real adapter_refresh_queue row through the mock;
#      asserts the youtube_video_snapshots row + youtube_videos.last_polled_at
#      land within 60s.
#   5. Asserts /api/admin/quota and /admin/quota HTML page both return
#      404 with empty ADMIN_EMAIL_ALLOWLIST (self-host parity gate).
#   6. SIGTERMs smoke-worker; asserts 60s graceful drain.
#
# All YouTube HTTP traffic is intercepted by youtube-mock — NO live
# YouTube API calls in CI.
log "=== YouTube polling smoke extension ==="
# shellcheck source=tests/smoke/lib/youtube-polling-flow.sh
source "$(dirname "$0")/lib/youtube-polling-flow.sh"
youtube_polling_smoke "http://localhost:$APP_PORT" "$SESSION_COOKIE_A"
log "=== YouTube polling smoke extension PASSED ==="

# ============================================================
# Reddit not-configured parity (Phase 12 — gated ScrapeCreators provider)
# ============================================================
# Phase 12 razed the old free-`.json` transport (the deleted per-role Reddit
# user-agent / base-URL-override / proxy envs, the round-robin batch worker, and
# its old cron schedules) and rebuilt Reddit as a PAID ScrapeCreators adapter
# behind a provider gate + the D-08 kill-switch. The baseline smoke
# image boots the production image with NO REDDIT_IMPORT_ENABLED in
# common_env_args, so isRedditConfigured() is false and Reddit reports
# not-configured. Mirrors the Instagram / TikTok not-configured parity blocks:
# a self-host operator who hasn't opted Reddit in gets a CLEANLY DISABLED
# Reddit — identical to SaaS — NOT a 500 and NOT an enabled import path.
#
# The full assertion chain lives in tests/smoke/lib/reddit-polling-flow.sh
# (sourced below):
#   - RDT.1 POST /api/sources {kind:"reddit_account", …} → 422
#     kind_not_configured (the createSource provider gate), never a 500.
#   - RDT.2 /sources/new HTML renders the Reddit chip disabled with the
#     "Set REDDIT_IMPORT_ENABLED to enable Reddit import" status.
#
# No live ScrapeCreators API is hit (mirrors the YouTube-mock / no-live-API
# discipline): createSource degrades BEFORE any provider call, so the 422 never
# touches the network. The paid import path is covered by the human UAT +
# integration tests, not the smoke gate.
log "=== Reddit not-configured parity ==="
# shellcheck source=tests/smoke/lib/reddit-polling-flow.sh
source "$(dirname "$0")/lib/reddit-polling-flow.sh"
reddit_not_configured_smoke "http://localhost:$APP_PORT" "$SESSION_COOKIE_A"
log "=== Reddit not-configured parity PASSED ==="

# ============================================================
# Instagram not-configured parity (Phase 08 — SOC-05 / SOC-03)
# ============================================================
# The baseline smoke run boots the production image with NO
# INSTAGRAM_PROVIDER / SCRAPECREATORS_API_KEY in common_env_args, so the
# Instagram adapter is registered+functional but reports
# isOperatorConfigured=false. This is the load-bearing self-host trust
# signal: a self-host operator who hasn't wired a provider gets a CLEANLY
# DISABLED Instagram — identical to SaaS — NOT a 500 and NOT an enabled
# import path. Mirrors the Reddit Half-A empty-env parity check.
#
# No live ScrapeCreators API is hit (mirrors the YouTube-mock / no-live-API
# discipline): createSource degrades BEFORE any provider call, so the 422
# never touches the network.
log "=== Instagram not-configured parity (SOC-05) ==="

# IG.1: POST /api/sources with an instagram_account handle and the provider
# env unset → 422 kind_not_configured (the createSource degrade gate), never
# a 500, never a created row. The chip is disabled in the UI; the API is the
# server-side guard the smoke gate pins.
IG_CREATE_BODY=$(curl -sS -o /tmp/ig-create.txt -w '%{http_code}' \
  -X POST "http://localhost:$APP_PORT/api/sources" \
  -H "cookie: $SESSION_COOKIE_A" \
  -H "content-type: application/json" \
  -d '{"kind":"instagram_account","handleUrl":"https://www.instagram.com/natgeo/","isOwnedByMe":false,"autoImport":true}' \
  || echo "curl-failed")
IG_CREATE_RESPONSE=$(cat /tmp/ig-create.txt 2>/dev/null || echo "")
if [[ "$IG_CREATE_BODY" != "422" ]]; then
  log "----- POST /api/sources (instagram_account) response -----"
  echo "$IG_CREATE_RESPONSE"
  log "----- recent app logs -----"
  docker logs smoke-app 2>&1 | tail -40 || true
  log "----------------------------------------------------------"
  fail "(IG.1) instagram_account create with empty provider env returned $IG_CREATE_BODY, expected 422 (clean not-configured degrade, never 500)"
fi
if ! echo "$IG_CREATE_RESPONSE" | grep -q 'kind_not_configured'; then
  log "----- POST /api/sources (instagram_account) response -----"
  echo "$IG_CREATE_RESPONSE"
  fail "(IG.1) instagram_account 422 body did not carry 'kind_not_configured'. Got: $IG_CREATE_RESPONSE"
fi
log "(IG.1) PASS — instagram_account create degrades to 422 kind_not_configured (no 500, no provider call)"

# IG.2: /sources/new HTML renders Instagram visible-but-disabled with the
# "not configured by operator" status — the user-facing affordance that
# tells a self-host operator Instagram is off + how to enable it (SOC-05).
# /sources/new is the full-page add-source form, so the disabled IG chip +
# its status render inline at SSR (the /sources modal is closed by default,
# so its chip markup isn't in that page's initial HTML).
IG_SOURCES_HTML=$(curl -sL -H "cookie: $SESSION_COOKIE_A" "http://localhost:$APP_PORT/sources/new" 2>/dev/null || true)
if ! echo "$IG_SOURCES_HTML" | grep -qi 'not configured by operator'; then
  log "----- /sources/new HTML (first 1500 chars) -----"
  echo "${IG_SOURCES_HTML:0:1500}"
  log "------------------------------------------------"
  fail "(IG.2) /sources/new HTML should render the Instagram 'not configured by operator' disabled status with empty provider env"
fi
log "(IG.2) PASS — /sources/new renders Instagram disabled ('not configured by operator')"
log "=== Instagram not-configured parity PASSED ==="

# ============================================================
# Reddit PROVIDER-ON smoke (Phase 12 — hermetic ScrapeCreators mock)
# ============================================================
# The OFF parity flows above prove Reddit degrades cleanly when unconfigured. This
# final block flips the D-08 kill-switch ON against a hermetic ScrapeCreators mock and
# drives the paid path the OFF flow can't reach: provider-ON bootstrap, worker
# registration of the reddit backfill queues + outbox forwarder, the create-source gate
# ACCEPTING, the author walk fetching through the mock, and the reserve-before-HTTP
# budget seam debiting the SHARED "scrapecreators" ledger (the P0 fix). No live
# ScrapeCreators traffic — every call hits the local stub. Runs LAST because it
# re-launches smoke-app/smoke-worker provider-ON (the earlier OFF flows must run first).
# reddit_provider_on_smoke is defined in reddit-polling-flow.sh (sourced above).
log "=== Reddit provider-ON smoke ==="
reddit_provider_on_smoke "http://localhost:$APP_PORT" "$SESSION_COOKIE_A"
log "=== Reddit provider-ON smoke PASSED ==="

log "ALL SMOKE ASSERTIONS PASSED"
