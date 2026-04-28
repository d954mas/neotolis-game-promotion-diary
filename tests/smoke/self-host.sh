#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Phase 1 — Self-host smoke test (DEPLOY-05)
# ============================================================
# Phase 1 scope per user decision 2026-04-27 (CONTEXT.md <deviations>):
#   covers boot + auth happy path + tenant scope hold + all three roles
#   dispatch correctly + i18n message resolution + no SaaS-only assumption
#   leaked. The literal "create a game" clause from D-15's earliest
#   formulation is Phase 2 smoke; "run a poll stub" is Phase 3 smoke.
#
# Asserts D-15 invariants (Phase 1 scope):
#   1. APP_ROLE=app boots (image ENTRYPOINT); /healthz 200; /readyz 200 after migrations
#   2. APP_ROLE=worker boots (image ENTRYPOINT); stdout contains "worker ready"
#   3. APP_ROLE=scheduler boots (image ENTRYPOINT); stdout contains "scheduler ready"
#   4. OAuth login (mocked via oauth2-mock-server per D-13 deviation 2026-04-27)
#      lands on /api/me with the seeded user; dashboard renders Paraglide English text
#   5. Cross-tenant: user B's /api/me returns user B (NOT user A's email);
#      anonymous /api/me returns 401
#   6. D-14 — minimal env (no CF_*, no ANALYTICS_*) is sufficient for boot
# Time budget: <5 min on GitHub-hosted runners.
#
# BLOCKER 7 mitigation: ALL `docker run` commands below use the image's
# actual ENTRYPOINT (defined in Dockerfile as ["node", "build/server.js"]).
# NO `sh -c` wrapper. NO entrypoint override. This is the production
# startup path under test — the whole point of the smoke gate is to
# exercise the same code path a self-host operator runs.

# CI-only by default (Wave 0 contract from Plan 02). ALLOW_LOCAL_SMOKE=1
# is the documented opt-in for local testing.
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
# Stream logs and wait up to 30s for the ready signal. Plan 08 guarantees
# the literal `worker ready` appears on stdout (dual-emit: console.log +
# logger.info).
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
# D-13 mechanism per CONTEXT.md `<deviations>` 2026-04-27:
#   `oauth2-mock-server` (sidecar) replaces the original "Better Auth test
#   provider" mechanism that does not exist in Better Auth 1.6.x. The
#   driver script `tests/smoke/lib/oauth-mock-driver.ts` boots the mock,
#   configures claims, and replays the redirect dance manually with cookie
#   jar accumulation. INFO I2 Path 3 is inherited from Plan 05.
log "(4) running OAuth dance via oauth-mock-driver (D-13 = oauth2-mock-server)"
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

# Hit /api/me with the cookie — proves Plan 07's tenantScope + getMe pipeline.
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

# P3 invariant (Plan 05 / Plan 07 DTO discipline): /api/me MUST NOT carry
# OAuth provider id or any token. Plan 05's `dto.ts` strips these even when
# the underlying row carries them; the smoke test is the runtime tripwire.
for forbidden in googleSub refreshToken accessToken idToken; do
  if echo "$ME_RESPONSE" | grep -q "$forbidden"; then
    fail "(4) /api/me leaked $forbidden! response: $ME_RESPONSE"
  fi
done

# Render the dashboard — must contain English text from Paraglide (UX-04 +
# Plan 09's `Promotion diary` literal in messages/en.json). This is the
# load-bearing parity assertion for DEPLOY-05 SC#1: a self-host operator who
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

DASH_HTTP=$(curl -s -o /tmp/dash.html -w '%{http_code}' -H "cookie: $SESSION_COOKIE_A" "http://localhost:$APP_PORT/" || echo "curl-failed")
DASH_HTML=$(cat /tmp/dash.html 2>/dev/null || echo "")
log "(4) dashboard HTTP=$DASH_HTTP body-bytes=${#DASH_HTML}"
log "----- dashboard response (first 600 chars) -----"
echo "${DASH_HTML:0:600}"
log "------------------------------------------------"
log "----- recent app logs (last 80 lines) -----"
docker logs smoke-app 2>&1 | tail -80 || true
log "-------------------------------------------"

if [[ "$DASH_HTTP" != "200" ]] || ! echo "$DASH_HTML" | grep -q "Promotion diary"; then
  fail "(4) dashboard did not render 'Promotion diary' (Paraglide). HTTP=$DASH_HTTP"
fi
log "(4) PASS — OAuth login + /api/me + dashboard renders English"

# ============================================================
# 5. Cross-tenant 404 / anonymous 401 — Phase 1 sentinel
# ============================================================
# Phase 1 has only /api/me. The cross-tenant 404 matrix on /api/games is
# Phase 2's smoke extension (per the 2026-04-27 DEPLOY-05 scope deferral).
# Here we assert the lower-level invariants:
#   - anonymous /api/me => 401 (PRIV-01)
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
# 6. SaaS-leak invariant — runtime side of D-14
# ============================================================
# The CI workflow (.github/workflows/ci.yml) runs the source-side grep step
# before this script. Here we re-confirm at runtime: the running app
# container has NO CF_* / CLOUDFLARE_* / ANALYTICS_* env vars set —
# i.e., the minimal env from `common_env_args` is sufficient for boot.
log "(6) D-14 — no SaaS-only env required"
APP_ENV=$(docker exec smoke-app printenv 2>/dev/null || echo "")
if echo "$APP_ENV" | grep -E '^(CF_|CLOUDFLARE_|ANALYTICS_)' > /dev/null; then
  echo "$APP_ENV" | grep -E '^(CF_|CLOUDFLARE_|ANALYTICS_)'
  fail "(6) container has SaaS-only env vars set; D-14 invariant violated"
fi
log "(6) PASS — no SaaS-only env vars present"

# ============================================================
# Phase 2 — GAMES-01 + cross-tenant + sweep (per ROADMAP Phase 2 SC #7)
# ============================================================
# Per the 2026-04-27 DEPLOY-05 scope deferral, the "user A creates a game"
# clause from D-15's earliest formulation lands here as the Phase 2 smoke
# extension. Reuses SESSION_COOKIE_A (step 4) and SESSION_COOKIE_B (step 5)
# already captured above — no extra OAuth dance needed.
#
# Five assertions (additive — Phase 1's six remain intact):
#   P2.1 GAMES-01: user A POST /api/games → 201 + DTO with id
#   P2.2 GAMES-03: user A GET /api/games → list contains the new gameId
#   P2.3 cross-tenant: user B GET/PATCH/DELETE /api/games/<aId> → 404 (not 403)
#   P2.4 cross-tenant integrity: A's game still readable + title unchanged
#   P2.5 anon-401 sweep: every Phase 2 /api/* probed with NO cookie → 401
log "=== Phase 2 smoke extension ==="

# jq sanity — all P2 assertions parse JSON.
command -v jq >/dev/null 2>&1 || fail "(P2) jq required for Phase 2 smoke extension"

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
# PRIV-01 invariant: cross-tenant access surfaces as 404, NEVER 403; body must
# not say "forbidden" or "permission" (Phase 2 plan 02-08 contract).
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
    fail "(P2.3) cross-tenant $method body leaks 'forbidden' or 'permission' (PRIV-01 violation)"
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

# ---- P2.5 anon-401 sweep: every new /api/* refuses anonymous access ----
# Mirrors tests/integration/anonymous-401.test.ts MUST_BE_PROTECTED — sample a
# representative subset of Phase 2 routes (one per sub-router family). The
# integration test exercises all 24 routes; this smoke check exercises 6 to
# keep CI fast while still catching middleware regressions at the production
# image boundary. The 6 routes span all 5 service families: games, audit,
# api-keys/steam, items/youtube, events, youtube-channels.
log "(P2.5) anon-401 — sweeping 6 new Phase 2 routes anonymously"
for path in /api/games /api/audit /api/api-keys/steam /api/items/youtube /api/events /api/youtube-channels; do
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$APP_PORT$path")
  if [[ "$STATUS" != "401" ]]; then
    fail "(P2.5) anonymous $path returned $STATUS, expected 401"
  fi
done
log "(P2.5) PASS — all 6 new routes return 401 anonymously"

log "=== Phase 2 smoke extension PASSED ==="

# ============================================================
# Phase 2.1 — unified-flow extension (per CONTEXT D-11)
# ============================================================
# Phase 2.1 introduces /api/sources, the unified events table, and the
# attach-to-game flow. The smoke test asserts the load-bearing user contract
# end-to-end against the production image: register YouTube data_source ->
# create youtube_video event (manual paste; sourceId=null) -> see in /feed
# -> PATCH .../attach with {gameId} -> see in /games/:gameId/events.
#
# Cross-tenant probes cover the new routes (/api/sources/:id GET +
# /api/events/:id/attach PATCH) so the AGENTS.md "404 never 403" invariant
# holds for the new tenant-owned resources too.
#
# Reuses SESSION_COOKIE_A (step 4) and SESSION_COOKIE_B (step 5) — no extra
# OAuth dance. The helper lives in tests/smoke/lib/phase21-flow.sh for
# legibility (the function is sourced, not exec'd).
log "=== Phase 2.1 smoke extension ==="
# shellcheck source=tests/smoke/lib/phase21-flow.sh
source "$(dirname "$0")/lib/phase21-flow.sh"
phase21_unified_flow "http://localhost:$APP_PORT" "$SESSION_COOKIE_A" "$SESSION_COOKIE_B"
log "=== Phase 2.1 smoke extension PASSED ==="

log "ALL SMOKE ASSERTIONS PASSED (Phase 1 + Phase 2 + Phase 2.1 scope)"
