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
GOOGLE_CLIENT_ID_VAL="${GOOGLE_CLIENT_ID:-mock-client-id}"
GOOGLE_CLIENT_SECRET_VAL="${GOOGLE_CLIENT_SECRET:-mock-client-secret}"
# genericOAuth plugin (review blocker P0-2 fix) reads OIDC discovery from
# this URL at boot. Smoke runs the mock IdP on localhost:$MOCK_PORT, so the
# discovery document is at http://localhost:$MOCK_PORT/.well-known/openid-configuration.
# Production self-host points at https://accounts.google.com/.well-known/openid-configuration
# (the env.ts default).
GOOGLE_DISCOVERY_URL_VAL="${GOOGLE_DISCOVERY_URL:-http://localhost:$MOCK_PORT/.well-known/openid-configuration}"

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
-e GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID_VAL
-e GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET_VAL
-e GOOGLE_DISCOVERY_URL=$GOOGLE_DISCOVERY_URL_VAL
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
SESSION_COOKIE_A=$(pnpm -s tsx tests/smoke/lib/oauth-mock-driver.ts \
  --app-url "http://localhost:$APP_PORT" \
  --mock-port "$MOCK_PORT" \
  --sub "user-a-sub" \
  --email "alice@smoke.test" \
  --name "Alice")
[[ -n "$SESSION_COOKIE_A" ]] || fail "(4) no session cookie from OAuth dance"

# Hit /api/me with the cookie — proves Plan 07's tenantScope + getMe pipeline.
ME_RESPONSE=$(curl -fsS -H "cookie: $SESSION_COOKIE_A" "http://localhost:$APP_PORT/api/me")
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
# Plan 09's `Promotion diary` literal in messages/en.json under both
# app_title and dashboard_title).
DASH_HTML=$(curl -fsS -H "cookie: $SESSION_COOKIE_A" "http://localhost:$APP_PORT/")
echo "$DASH_HTML" | grep -q "Promotion diary" \
  || fail "(4) dashboard did not render 'Promotion diary' (Paraglide). HTML: $DASH_HTML"
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

log "ALL SMOKE ASSERTIONS PASSED (Phase 1 scope)"
