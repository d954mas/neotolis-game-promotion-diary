#!/usr/bin/env bash
# Phase 3.0 Plan 14 — smoke gate extension for the polling pipeline.
#
# Sourced (not exec'd) by tests/smoke/self-host.sh after the Phase 2.1
# unified-flow assertions complete and the Phase 1 smoke-worker / smoke-
# scheduler containers have been stopped. The function takes the smoke
# context (app URL, the user-A session cookie captured in step 4) and:
#
#   1. Boots the YouTube mock reverse-proxy on a free local port
#      (sourced from tests/smoke/lib/youtube-mock.sh).
#   2. Re-launches smoke-worker + smoke-scheduler with the Phase 3.0 env
#      surface: SERVICE_YOUTUBE_API_KEYS=mock-key, ADMIN_EMAIL_ALLOWLIST=""
#      (empty by construction → /admin/quota returns 404), and
#      YOUTUBE_API_BASE_URL pointing at the mock so worker traffic is
#      intercepted (Pitfall G — no live YouTube calls in CI).
#   3. Waits for both ready signals (`worker ready` / `scheduler ready`).
#   4. Asserts the four Phase 3.0 cron schedules registered in
#      pgboss.schedule (queried via `docker exec smoke-app node -e ...`
#      so we don't depend on the runner having psql installed).
#   5. Creates a kind=youtube_video event via POST /api/events (Plan
#      02.1-17 auto-derives the external_id from the URL); calls POST
#      /api/events/:id/refresh-poll so the worker drains a real
#      poll.user job through the mock; waits up to 60s for the
#      youtube_video_snapshots row + youtube_videos.last_polled_at to land.
#   6. Asserts /api/admin/quota and /admin/quota return 404 with the
#      empty allowlist (D-16 self-host parity gate by construction).
#   7. SIGTERMs smoke-worker and asserts it drains within 60s
#      (Phase 1 D-22 graceful drain inherited).
#
# Cleanup: youtube-mock.sh's EXIT trap stops the mock; the smoke harness's
# outer trap stops smoke-worker / smoke-scheduler containers.

# shellcheck disable=SC2154   # APP_PORT, log, fail are inherited from caller.

phase30_polling_smoke() {
  local app_url="$1"
  local session_cookie="$2"

  log "=== Phase 3.0 smoke extension ==="

  # ----- 1. Boot the YouTube mock -----
  # shellcheck source=tests/smoke/lib/youtube-mock.sh
  source "$(dirname "${BASH_SOURCE[0]}")/youtube-mock.sh"
  start_youtube_mock || fail "Phase 3.0: youtube-mock failed to start"

  # ----- 2. Re-launch worker + scheduler with Phase 3.0 env -----
  # The Phase 1 step (2)+(3) stops smoke-worker/smoke-scheduler after the
  # ready-grep contract is asserted. Re-create them now with the polling
  # pipeline env additions.
  #
  # --network host means container localhost == host localhost, so the
  # worker reaches:
  #   - Postgres on :5432 via DATABASE_URL (inherited from common_env_args)
  #   - YouTube mock on :$YOUTUBE_MOCK_PORT via YOUTUBE_API_BASE_URL
  #
  # ADMIN_EMAIL_ALLOWLIST is intentionally empty — the smoke gate's job is
  # to assert /admin/quota returns 404 by construction with no allowlist
  # set (D-16 self-host parity invariant). Setting it to a real email
  # would defeat the assertion.
  # The Phase 1 step (2)+(3) stops the smoke-worker / smoke-scheduler
  # containers but does NOT `docker rm` them — the names remain reserved
  # by the stopped containers. `docker run --name <name>` on a reserved
  # name fails with a conflict. Remove the leftover stopped containers
  # before re-creating them with the Phase 3.0 env. `|| true` covers the
  # idempotent case where they were already removed.
  docker rm -f smoke-worker smoke-scheduler 2>/dev/null || true

  log "(P3.0) booting smoke-worker (Phase 3.0 env)"
  # shellcheck disable=SC2046
  docker run -d --name smoke-worker --network host \
    -e APP_ROLE=worker \
    -e SERVICE_YOUTUBE_API_KEYS=mock-key \
    -e ADMIN_EMAIL_ALLOWLIST="" \
    -e YOUTUBE_API_BASE_URL="http://localhost:$YOUTUBE_MOCK_PORT" \
    $(common_env_args) \
    neotolis:ci > /dev/null

  log "(P3.0) booting smoke-scheduler (Phase 3.0 env)"
  # shellcheck disable=SC2046
  docker run -d --name smoke-scheduler --network host \
    -e APP_ROLE=scheduler \
    -e SERVICE_YOUTUBE_API_KEYS=mock-key \
    -e ADMIN_EMAIL_ALLOWLIST="" \
    -e YOUTUBE_API_BASE_URL="http://localhost:$YOUTUBE_MOCK_PORT" \
    $(common_env_args) \
    neotolis:ci > /dev/null

  # Wait for the ready signals with the same pipefail-disabled grep
  # pattern as steps (2) + (3) in the parent harness.
  set +o pipefail
  timeout 30 docker logs -f smoke-worker 2>&1 | grep -q -m1 "worker ready"
  local worker_ready=$?
  timeout 30 docker logs -f smoke-scheduler 2>&1 | grep -q -m1 "scheduler ready"
  local scheduler_ready=$?
  set -o pipefail
  if [ $worker_ready -ne 0 ]; then
    log "----- smoke-worker logs -----"
    docker logs smoke-worker 2>&1 | tail -50 || true
    fail "(P3.0) smoke-worker did not print 'worker ready' within 30s"
  fi
  if [ $scheduler_ready -ne 0 ]; then
    log "----- smoke-scheduler logs -----"
    docker logs smoke-scheduler 2>&1 | tail -50 || true
    fail "(P3.0) smoke-scheduler did not print 'scheduler ready' within 30s"
  fi
  log "(P3.0) worker + scheduler ready"

  # ----- 3. Assert the Phase 03.0.1 Plan 07 cron schedules registered -----
  # pg-boss persists `boss.schedule(name, cronExpr, ...)` rows into
  # pgboss.schedule on each scheduler boot (idempotent). We query through
  # the smoke-app container's pg pool so this works on any runner that
  # has docker but not psql.
  #
  # Phase 03.0.1 Plan 07 — per-kind queue topology rename. Expected schedules:
  #   - youtube.poll.cron (key=active)  (cron 0 */6 * * *)        Active tier
  #   - youtube.poll.cron (key=cold)    (cron 0 5 * * *, tz=PT)   Cold tier
  #   - youtube.quota_reset             (cron 0 0 * * *, tz=PT)   daily quota reset
  #   - purge.daily                     (cron 0 4 * * *, tz=PT)   GDPR purge worker
  #   - youtube.rehab                   (cron 0 4 * * 0, tz=PT)   weekly rehab cron
  #
  # The two retired Phase 03.0 Plan 09 names (scheduler.tick.active /
  # scheduler.tick.cold) collapsed into youtube.poll.cron via pg-boss v11+
  # key-based multiple-schedule-per-queue. The retired youtube.rehab_unavailable
  # name was renamed to youtube.rehab (D-11 brevity). Migration
  # drizzle/0021_phase03_01_per_kind_queue_topology.sql cleans up the
  # orphan pgboss.schedule rows.
  #
  # Two key=active and key=cold schedules share the queue name 'youtube.poll.cron'
  # — the SELECT below returns one row per (name,key) so we use grep -c >=1
  # for the cron name (vs. an exact match) and check both keys appear in the
  # accompanying key column where present.
  log "(P3.0) asserting Plan 07 cron schedules in pgboss.schedule"
  # Avoid `local foo=$(cmd)` — `local` swallows the inner command's exit
  # code, but `set -e` then trips when the assignment expression itself
  # is evaluated as part of pipeline state, exiting the script silently
  # without running the diagnostic block. Capture under `set +e`, then
  # restore + log explicitly so any failure surfaces in the CI log.
  local schedules
  local schedules_rc
  set +e
  schedules=$(docker exec smoke-app node -e '
    import("./node_modules/pg/lib/index.js").then(async (pgMod) => {
      const Client = (pgMod.default && pgMod.default.Client) || pgMod.Client;
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      try {
        const r = await c.query("SELECT name FROM pgboss.schedule ORDER BY name");
        console.log(r.rows.map((row) => row.name).join("\n"));
      } finally { await c.end(); }
    }).catch((e) => { console.error(e); process.exit(1); });
  ' 2>&1)
  schedules_rc=$?
  set -e
  log "----- pgboss.schedule names (exit=$schedules_rc) -----"
  echo "$schedules"
  log "---------------------------------"
  if [ "$schedules_rc" -ne 0 ]; then
    log "----- smoke-scheduler logs (last 80 lines) -----"
    docker logs smoke-scheduler 2>&1 | tail -80 || true
    log "----- smoke-app logs (last 50 lines) -----"
    docker logs smoke-app 2>&1 | tail -50 || true
    fail "(P3.0) docker exec smoke-app node (pgboss.schedule readback) exited $schedules_rc"
  fi
  for expected in "youtube.poll.cron" "youtube.quota_reset" "purge.daily" "youtube.rehab"; do
    if ! echo "$schedules" | grep -qx "$expected"; then
      fail "(P3.0) pgboss.schedule missing entry for '$expected'"
    fi
  done
  # youtube.poll.cron carries TWO schedules (key=active + key=cold) per
  # pg-boss v11+ multiple-schedule-per-queue. Verify the second occurrence
  # exists by counting — exactly one queue should appear with name=
  # youtube.poll.cron AND there should be ≥ 2 rows for it.
  local poll_cron_count
  poll_cron_count=$(echo "$schedules" | grep -cx "youtube.poll.cron" || true)
  if [ "$poll_cron_count" -lt 2 ]; then
    fail "(P3.0) pgboss.schedule has $poll_cron_count youtube.poll.cron rows, expected >=2 (key=active + key=cold)"
  fi
  log "(P3.0) PASS — Plan 07 cron schedules registered (youtube.poll.cron x2 + 3 other)"

  # ----- 4. Create a youtube_video event + drive a refresh-now poll -----
  # POST /api/events with kind=youtube_video and a real-shaped YouTube URL
  # so the createEvent service auto-derives external_id="mockvideo00"
  # (Plan 02.1-17 enrichment path). The worker's videos.list call will
  # hit `http://localhost:$YOUTUBE_MOCK_PORT/videos` (intercepted by our
  # stub) and write a snapshot row.
  #
  # The refresh-poll route enqueues to QUEUES.YOUTUBE_POLL_USER which is one of
  # the worker subscriptions registered by Plan 03.0-09. We use the
  # refresh-now route instead of the scheduler tick because:
  #   - it's deterministic (no waiting for a 6-hour cron tick)
  #   - it bypasses the throttle gate (refresh-now is independent per D-13)
  #   - it exercises the same poll.user handler the UI button drives
  log "(P3.0) creating kind=youtube_video event for poll round-trip"
  local create_body
  create_body=$(curl -sS -X POST "$app_url/api/events" \
    -H "cookie: $session_cookie" \
    -H "content-type: application/json" \
    -d '{"kind":"youtube_video","url":"https://www.youtube.com/watch?v=mockvideo00","title":"Smoke gate mock video","occurredAt":"2026-05-05T12:00:00.000Z"}')
  local event_id
  event_id=$(echo "$create_body" | jq -r '.id // empty' 2>/dev/null || true)
  if [[ -z "$event_id" || "$event_id" == "null" ]]; then
    log "----- POST /api/events response -----"
    echo "$create_body"
    fail "(P3.0) POST /api/events did not return an event id"
  fi
  log "(P3.0) created eventId=$event_id"

  # Per-video refactor (2026-05-06): refresh-poll's pending-tier gate
  # rejects (422 'pending_backfill') any video whose youtube_videos row has
  # NULL publishedAt — channel-context-backfill normally fills that row
  # within seconds of paste, but the smoke flow uses a mocked YouTube API
  # that may not exercise the full channels.list + playlistItems.list
  # discovery path. Pre-seed the youtube_videos row directly so the
  # pending-tier gate sees a populated publishedAt and the smoke
  # round-trip exercises the actual poll-user → snapshot path.
  log "(P3.0) pre-seeding youtube_videos row for mockvideo00 (skip pending tier)"
  docker exec smoke-app node -e '
    import("./node_modules/pg/lib/index.js").then(async (pgMod) => {
      const Client = (pgMod.default && pgMod.default.Client) || pgMod.Client;
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      try {
        await c.query(
          "INSERT INTO youtube_videos (video_id, title, published_at, fetched_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (video_id) DO NOTHING",
          ["mockvideo00", "Smoke gate mock video", "2026-05-05T12:00:00.000Z"],
        );
      } finally { await c.end(); }
    }).catch((e) => { console.error(e); process.exit(1); });
  ' >/dev/null || fail "(P3.0) youtube_videos pre-seed failed"

  log "(P3.0) POST /api/events/$event_id/refresh-poll (enqueues poll.user)"
  local refresh_body
  refresh_body=$(curl -sS -X POST "$app_url/api/events/$event_id/refresh-poll" \
    -H "cookie: $session_cookie")
  local enqueued
  enqueued=$(echo "$refresh_body" | jq -r '.enqueued // empty' 2>/dev/null || true)
  if [[ "$enqueued" != "true" ]]; then
    log "----- refresh-poll response -----"
    echo "$refresh_body"
    fail "(P3.0) refresh-poll did not return enqueued:true"
  fi

  # Wait up to 60s for the worker to drain the job and write a snapshot.
  log "(P3.0) waiting up to 60s for youtube_video_snapshots row"
  local snapshot_present="false"
  for _ in $(seq 1 60); do
    local found
    found=$(docker exec smoke-app node -e '
      import("./node_modules/pg/lib/index.js").then(async (pgMod) => {
      const Client = (pgMod.default && pgMod.default.Client) || pgMod.Client;
        const c = new Client({ connectionString: process.env.DATABASE_URL });
        await c.connect();
        try {
          const r = await c.query("SELECT 1 FROM youtube_video_snapshots WHERE video_id = $1 LIMIT 1", ["mockvideo00"]);
          console.log(r.rowCount > 0 ? "yes" : "no");
        } finally { await c.end(); }
      }).catch((e) => { console.error(e); process.exit(1); });
    ' 2>/dev/null || echo "no")
    if [[ "$found" == "yes" ]]; then
      snapshot_present="true"
      break
    fi
    sleep 1
  done
  if [[ "$snapshot_present" != "true" ]]; then
    log "----- smoke-worker logs (last 80) -----"
    docker logs smoke-worker 2>&1 | tail -80 || true
    fail "(P3.0) youtube_video_snapshots row never appeared for video_id=mockvideo00"
  fi
  log "(P3.0) PASS — snapshot row written"

  # Confirm youtube_videos.last_polled_at populated AND last_poll_status='ok'.
  # Per-video refactor (2026-05-06): polling state moved off events to
  # youtube_videos (single source of truth per video). The refresh-poll
  # service updates the youtube_videos row keyed on external_id.
  local poll_state
  poll_state=$(docker exec smoke-app node -e '
    import("./node_modules/pg/lib/index.js").then(async (pgMod) => {
      const Client = (pgMod.default && pgMod.default.Client) || pgMod.Client;
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      try {
        const r = await c.query("SELECT last_polled_at IS NOT NULL AS polled, last_poll_status, poll_failure_count FROM youtube_videos WHERE video_id = $1", ["mockvideo00"]);
        if (r.rowCount === 0) { console.log("missing"); return; }
        console.log(JSON.stringify(r.rows[0]));
      } finally { await c.end(); }
    }).catch((e) => { console.error(e); process.exit(1); });
  ' 2>&1)
  log "(P3.0) youtube_videos row state: $poll_state"
  if ! echo "$poll_state" | grep -q '"polled":true'; then
    fail "(P3.0) youtube_videos.last_polled_at not populated for mockvideo00"
  fi
  if ! echo "$poll_state" | grep -q '"last_poll_status":"ok"'; then
    fail "(P3.0) youtube_videos.last_poll_status not 'ok' for mockvideo00 (got: $poll_state)"
  fi
  log "(P3.0) PASS — youtube_videos.last_polled_at + last_poll_status='ok'"

  # ----- 5. Admin parity — empty ADMIN_EMAIL_ALLOWLIST → 404 by construction -----
  # /api/admin/quota: Plan 03.0-07 ships adminAllowlist middleware that
  # returns 404 (NOT 403) when the caller's email isn't in the allowlist
  # OR when the allowlist is empty. Smoke harness doesn't set the env, so
  # default is empty → all admin routes 404 (D-16 + AGENTS.md invariant 8
  # "no APP_MODE branching"). With session_cookie injected this proves
  # the gate isn't accidentally bypassed for an authenticated user.
  log "(P3.0) /api/admin/quota with empty allowlist must 404"
  local admin_api_status
  admin_api_status=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "cookie: $session_cookie" "$app_url/api/admin/quota")
  if [[ "$admin_api_status" != "404" ]]; then
    fail "(P3.0) /api/admin/quota expected 404 with empty ADMIN_EMAIL_ALLOWLIST, got $admin_api_status"
  fi
  log "(P3.0) PASS — /api/admin/quota → 404 (parity preserved)"

  # /admin (SvelteKit page) must also resolve to 404 — the layout server
  # loader (post-build review 2026-05-08) explicitly checks
  # ADMIN_EMAIL_ALLOWLIST and throws error(404) so non-allowlisted users
  # do NOT see the admin breadcrumb chrome that +layout.svelte would
  # otherwise render around the child error page. Note: we test /admin
  # (the actual page route), not /admin/quota (a non-existent nested
  # path that would return 404 trivially regardless of any allowlist
  # gate — vacuous-pass).
  log "(P3.0) /admin HTML page with empty allowlist must 404"
  local admin_html_status
  admin_html_status=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "cookie: $session_cookie" "$app_url/admin")
  if [[ "$admin_html_status" != "404" ]]; then
    fail "(P3.0) /admin HTML expected 404, got $admin_html_status"
  fi
  log "(P3.0) PASS — /admin HTML → 404"

  # Anonymous /admin must also 404 — fourth-pass review noted that a
  # 303 redirect to /login leaks the area's existence (the redirect
  # shape "/admin → /login?next=/admin" tells an unauthenticated probe
  # that /admin is a real route). Both anonymous and authenticated-
  # non-allowlisted callers MUST get the same URL-not-found shape.
  log "(P3.0) /admin HTML anonymous must 404 (no cookie)"
  local admin_html_anon_status
  admin_html_anon_status=$(curl -s -o /dev/null -w '%{http_code}' "$app_url/admin")
  if [[ "$admin_html_anon_status" != "404" ]]; then
    fail "(P3.0) /admin HTML anonymous expected 404, got $admin_html_anon_status"
  fi
  log "(P3.0) PASS — /admin HTML anonymous → 404"

  # ----- 6. SIGTERM 60s graceful drain (Phase 1 D-22 inherited) -----
  # Phase 1 D-22 invariant: worker honors SIGTERM with up to 60s graceful
  # drain (boss.stop wait+graceful timeout). Phase 3.0 adds the new
  # poll.* handlers — re-assert the inherited drain holds with the new
  # subscriptions in place.
  log "(P3.0) SIGTERM smoke-worker; expect drain within 60s"
  docker kill --signal SIGTERM smoke-worker > /dev/null
  local drained="false"
  for _ in $(seq 1 65); do
    local running
    running=$(docker inspect -f '{{.State.Running}}' smoke-worker 2>/dev/null || echo "false")
    if [[ "$running" != "true" ]]; then
      drained="true"
      break
    fi
    sleep 1
  done
  if [[ "$drained" != "true" ]]; then
    log "----- smoke-worker logs (last 50) -----"
    docker logs smoke-worker 2>&1 | tail -50 || true
    fail "(P3.0) smoke-worker did not exit within 65s of SIGTERM (D-22 violation)"
  fi
  log "(P3.0) PASS — worker SIGTERM drain (D-22 inherited)"

  stop_youtube_mock
  log "=== Phase 3.0 smoke extension PASSED ==="
}
