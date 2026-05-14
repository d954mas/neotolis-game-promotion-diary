#!/usr/bin/env bash
# Reddit adapter smoke flow (Phase 03.1, plan 10 — V3 + V24 + V25).
#
# Sourced (not exec'd) by tests/smoke/self-host.sh after the YouTube
# polling flow completes. Covers the two halves of the Reddit parity
# contract:
#
#   Half A — empty REDDIT_USER_AGENT (V3 + V24):
#     1. /readyz still 200 (smoke-app booted in baseline step proves this
#        already — the assertion re-confirms it for the Reddit context).
#     2. /sources HTML page renders "Reddit not configured" (the empty
#        state on QuotaStatusBanner's Reddit tab — D-RDT-AUTH-EMPTY).
#     3. POST /api/events with a Reddit URL → 422 reddit_not_configured.
#
#   Half B — configured + mock-Reddit (V25):
#     4. Re-launch smoke-worker + smoke-scheduler with REDDIT_USER_AGENT
#        set and REDDIT_BASE_URL_OVERRIDE pointing at the mock.
#     5. Worker stdout includes the grep contract:
#        "reddit batch-worker ready: 8-tick round-robin loop".
#     6. 4 Reddit cron schedules registered in pgboss.schedule
#        (reddit.cron.enqueue-service-sources, .enqueue-service-posts,
#         .baselines, .deletion-propagation).
#     7. Paste a Reddit post URL → 201 + reddit_post_snapshots row written
#        (handlePostSingle UPSERT + snapshot path exercised end-to-end
#        through the mock).
#
# All Reddit HTTP traffic is intercepted by tests/smoke/lib/reddit-mock.mjs —
# NO live Reddit calls in CI. Helpers (log, fail, common_env_args,
# APP_PORT) are inherited from the caller (tests/smoke/self-host.sh).

# shellcheck disable=SC2154   # APP_PORT, log, fail, common_env_args are inherited.

reddit_polling_smoke() {
  local app_url="$1"
  local session_cookie="$2"

  log "=== Reddit adapter smoke extension ==="

  # ----- Half A: empty REDDIT_USER_AGENT (V3 + V24) -----
  # The baseline smoke run has REDDIT_USER_AGENT unset in common_env_args,
  # so smoke-app is already in the empty-env state. Just assert it.
  log "Half A (V3+V24) — empty REDDIT_USER_AGENT preserves parity"

  # Assertion A.1: /readyz still 200. Re-confirms the env-empty boot path
  # (already covered by baseline step 1 but kept here for explicit
  # Reddit-context phrasing in the smoke log).
  local readyz_status
  readyz_status=$(curl -s -o /dev/null -w '%{http_code}' "$app_url/readyz")
  if [[ "$readyz_status" != "200" ]]; then
    fail "V3: /readyz returned $readyz_status with empty REDDIT_USER_AGENT (expected 200)"
  fi
  log "V3 PASS — /readyz 200 with empty REDDIT_USER_AGENT"

  # Assertion A.2: /sources HTML renders the "Reddit not configured" empty
  # state. /sources is the user-facing surface that hosts QuotaStatusBanner
  # (D-RDT-QUOTA-UI / D-RDT-AUTH-EMPTY). The plan referenced
  # /api/admin/quota.reddit.isOperatorConfigured but admin-quota-read.ts
  # only returns YouTube data — the actual Reddit "not configured" surface
  # is /sources via QuotaStatusBanner.redditQuota.isOperatorConfigured=false.
  local sources_html
  sources_html=$(curl -sL -b <(printf "%s\n" "$session_cookie") -H "cookie: $session_cookie" "$app_url/sources" 2>/dev/null || true)
  if ! echo "$sources_html" | grep -q "Reddit not configured"; then
    log "----- /sources HTML (first 1200 chars) -----"
    echo "${sources_html:0:1200}"
    log "--------------------------------------------"
    fail "V24: /sources HTML should render 'Reddit not configured' with empty REDDIT_USER_AGENT"
  fi
  log "V24 PASS — /sources renders 'Reddit not configured'"

  # Assertion A.3: Reddit URL paste → 422 reddit_not_configured.
  # POST /api/events with a Reddit post URL triggers ingest.ts pre-flight
  # isRedditConfigured() check, which throws AppError(reddit_not_configured)
  # → mapErr → 422.
  local paste_resp
  paste_resp=$(curl -sS -X POST "$app_url/api/events" \
    -H "cookie: $session_cookie" \
    -H "content-type: application/json" \
    -d '{"kind":"reddit_post","url":"https://www.reddit.com/r/IndieDev/comments/abc/test/"}' || true)
  if ! echo "$paste_resp" | jq -e '.error == "reddit_not_configured"' >/dev/null 2>&1; then
    log "----- POST /api/events response -----"
    echo "$paste_resp"
    log "-------------------------------------"
    fail "V24: paste should return reddit_not_configured 422 when REDDIT_USER_AGENT empty"
  fi
  log "V24 PASS — paste returns reddit_not_configured 422"

  # ----- Half B: configured + mock-Reddit (V25) -----
  log "Half B (V25) — configured + mock-Reddit pipeline"

  # Boot the mock reverse-proxy.
  # shellcheck source=tests/smoke/lib/reddit-mock.sh
  source "$(dirname "${BASH_SOURCE[0]}")/reddit-mock.sh"
  start_reddit_mock || fail "reddit-mock failed to start"

  # The YouTube polling flow stops smoke-worker (SIGTERM) at the end of
  # its assertions; smoke-scheduler may also have been stopped. Remove
  # any leftover containers idempotently before re-creating with Reddit env.
  # Also need to restart smoke-app with REDDIT_USER_AGENT + override so
  # the paste flow (server-side) sees the configured state.
  docker rm -f smoke-app smoke-worker smoke-scheduler 2>/dev/null || true

  # Compliant operator UA per Reddit ToS regex
  # (`<platform>:<id>:<version> (by /u/<handle>)`).
  local reddit_ua="node:com.neotolis.gpd-smoke:0.1.0 (by /u/smoke)"
  local reddit_base="http://localhost:$REDDIT_MOCK_PORT"

  log "booting smoke-app (Reddit configured + mock base URL)"
  # shellcheck disable=SC2046
  docker run -d --name smoke-app --network host \
    -e APP_ROLE=app \
    -e PORT=$APP_PORT \
    -e REDDIT_USER_AGENT="$reddit_ua" \
    -e REDDIT_BASE_URL_OVERRIDE="$reddit_base" \
    $(common_env_args) \
    neotolis:ci > /dev/null

  # Wait up to 30s for /readyz to come back.
  local ready=false
  for _ in $(seq 1 30); do
    if curl -fsS "$app_url/readyz" > /dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done
  [[ "$ready" == "true" ]] || fail "V25: smoke-app did not return to /readyz within 30s (Reddit-configured boot)"
  log "smoke-app booted with REDDIT_USER_AGENT + mock base URL"

  log "booting smoke-worker (Reddit configured)"
  # shellcheck disable=SC2046
  docker run -d --name smoke-worker --network host \
    -e APP_ROLE=worker \
    -e REDDIT_USER_AGENT="$reddit_ua" \
    -e REDDIT_BASE_URL_OVERRIDE="$reddit_base" \
    $(common_env_args) \
    neotolis:ci > /dev/null

  log "booting smoke-scheduler (Reddit configured)"
  # shellcheck disable=SC2046
  docker run -d --name smoke-scheduler --network host \
    -e APP_ROLE=scheduler \
    -e REDDIT_USER_AGENT="$reddit_ua" \
    -e REDDIT_BASE_URL_OVERRIDE="$reddit_base" \
    $(common_env_args) \
    neotolis:ci > /dev/null

  # Wait for the worker grep contract — V25 assertion 5.
  # `reddit batch-worker ready: 8-tick round-robin loop` is the exact line
  # emitted by src/worker/index.ts when REDDIT_USER_AGENT is non-empty.
  log "waiting for 'reddit batch-worker ready' grep contract"
  set +o pipefail
  timeout 30 docker logs -f smoke-worker 2>&1 | grep -q -m1 "reddit batch-worker ready: 8-tick round-robin loop"
  local reddit_ready=$?
  set -o pipefail
  if [ $reddit_ready -ne 0 ]; then
    log "----- smoke-worker logs (last 80) -----"
    docker logs smoke-worker 2>&1 | tail -80 || true
    fail "V25: worker did not print 'reddit batch-worker ready: 8-tick round-robin loop' within 30s"
  fi
  log "V25 PASS — worker grep contract"

  # Wait for scheduler ready so cron schedules are registered.
  set +o pipefail
  timeout 30 docker logs -f smoke-scheduler 2>&1 | grep -q -m1 "scheduler ready"
  local scheduler_ready=$?
  set -o pipefail
  if [ $scheduler_ready -ne 0 ]; then
    log "----- smoke-scheduler logs (last 80) -----"
    docker logs smoke-scheduler 2>&1 | tail -80 || true
    fail "V25: scheduler did not print 'scheduler ready' within 30s"
  fi

  # V25 assertion 6: 4 Reddit cron schedules registered in pgboss.schedule.
  # Mirrors the YouTube polling flow's pgboss.schedule readback pattern —
  # via `docker exec smoke-app node -e` so the runner doesn't need psql.
  log "asserting 4 reddit.cron.* schedules in pgboss.schedule"
  local schedules schedules_rc
  set +e
  schedules=$(docker exec smoke-app node -e '
    import("./node_modules/pg/lib/index.js").then(async (pgMod) => {
      const Client = (pgMod.default && pgMod.default.Client) || pgMod.Client;
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      try {
        const r = await c.query("SELECT name FROM pgboss.schedule WHERE name LIKE $1 ORDER BY name", ["reddit.cron.%"]);
        console.log(r.rows.map((row) => row.name).join("\n"));
      } finally { await c.end(); }
    }).catch((e) => { console.error(e); process.exit(1); });
  ' 2>&1)
  schedules_rc=$?
  set -e
  log "----- pgboss.schedule reddit.cron.* names (exit=$schedules_rc) -----"
  echo "$schedules"
  log "-------------------------------------------------------------------"
  if [ "$schedules_rc" -ne 0 ]; then
    log "----- smoke-scheduler logs (last 80) -----"
    docker logs smoke-scheduler 2>&1 | tail -80 || true
    fail "V25: docker exec smoke-app pgboss.schedule readback exited $schedules_rc"
  fi
  for expected in \
    "reddit.cron.enqueue-service-sources" \
    "reddit.cron.enqueue-service-posts" \
    "reddit.cron.baselines" \
    "reddit.cron.deletion-propagation"; do
    if ! echo "$schedules" | grep -qx "$expected"; then
      fail "V25: pgboss.schedule missing entry for '$expected'"
    fi
  done
  log "V25 PASS — 4 reddit.cron.* schedules registered"

  # V25 assertion 7: paste a Reddit post URL → 201 + reddit_post_snapshots row.
  # handlePostSingle calls redditFetch('/comments/abc.json') which hits the
  # mock and returns canned t3 (id=abc, subreddit=IndieDev). The synchronous
  # ingest path UPSERTs reddit_posts + writes one reddit_post_snapshots row.
  #
  # We re-use the existing session_cookie (cookie A from baseline OAuth).
  # The paste route does NOT require admin allowlist — any authenticated
  # user can paste.
  log "POST /api/events with Reddit URL → expect 201 event_created"
  local paste_b
  paste_b=$(curl -sS -X POST "$app_url/api/events" \
    -H "cookie: $session_cookie" \
    -H "content-type: application/json" \
    -d '{"kind":"reddit_post","url":"https://www.reddit.com/r/IndieDev/comments/abc/test/"}')
  local paste_event_id
  paste_event_id=$(echo "$paste_b" | jq -r '.id // empty' 2>/dev/null || true)
  if [[ -z "$paste_event_id" || "$paste_event_id" == "null" ]]; then
    log "----- POST /api/events response -----"
    echo "$paste_b"
    log "----- smoke-app logs (last 80) -----"
    docker logs smoke-app 2>&1 | tail -80 || true
    fail "V25: Reddit paste did not return event id (got: $paste_b)"
  fi
  log "V25 PASS — event $paste_event_id created"

  # Wait up to 10s for the reddit_post_snapshots row. handlePostSingle is
  # synchronous in the paste flow — by the time POST /api/events returns
  # 201, the snapshot row is already written. We still poll briefly for
  # eventual-consistency robustness.
  log "waiting up to 10s for reddit_post_snapshots row (post_id=t3_abc)"
  local snap_present="false"
  for _ in $(seq 1 20); do
    local found
    found=$(docker exec smoke-app node -e '
      import("./node_modules/pg/lib/index.js").then(async (pgMod) => {
        const Client = (pgMod.default && pgMod.default.Client) || pgMod.Client;
        const c = new Client({ connectionString: process.env.DATABASE_URL });
        await c.connect();
        try {
          const r = await c.query("SELECT 1 FROM reddit_post_snapshots WHERE post_id = $1 LIMIT 1", ["t3_abc"]);
          console.log(r.rowCount > 0 ? "yes" : "no");
        } finally { await c.end(); }
      }).catch((e) => { console.error(e); process.exit(1); });
    ' 2>/dev/null || echo "no")
    if [[ "$found" == "yes" ]]; then
      snap_present="true"
      break
    fi
    sleep 0.5
  done
  if [[ "$snap_present" != "true" ]]; then
    log "----- smoke-app logs (last 80) -----"
    docker logs smoke-app 2>&1 | tail -80 || true
    fail "V25: reddit_post_snapshots row never appeared for post_id=t3_abc"
  fi
  log "V25 PASS — reddit_post_snapshots row written for post_id=t3_abc"

  stop_reddit_mock
  log "=== Reddit adapter smoke extension PASSED ==="
}
