#!/usr/bin/env bash
# ============================================================
# Phase 2.1 — unified-flow smoke (CONTEXT D-11)
# ============================================================
# Sourced by tests/smoke/self-host.sh after the Phase 2 sentinel block.
# Asserts the register-source -> paste -> see-in-feed -> attach -> see-in-games
# path end to end against the production Docker image, plus cross-tenant
# probes covering the new Phase 2.1 routes.
#
# Calling convention matches self-host.sh's existing harness:
#   phase21_unified_flow <base_url> <session_cookie_a> <session_cookie_b>
#
# where:
#   base_url            = "http://localhost:$APP_PORT"
#   session_cookie_a    = HEADER STRING (e.g. "neotolis.session_token=abc...")
#                         already captured from oauth-mock-driver in step 4.
#   session_cookie_b    = same shape, user B's cookie from step 5.
#
# Each step fails fast on non-2xx by relying on `curl -sf`; the cross-tenant
# probes use `curl -s -o /dev/null -w '%{http_code}'` so we can ASSERT the
# status (Pitfall 4 — must be 404, NEVER 500).
#
# `set -euo pipefail` is inherited from self-host.sh; the function below
# obeys those settings.

# Phase 2.1 unified-flow assertion. Returns 0 on full pass, exits non-zero
# (with a descriptive message) on any failure. Intentionally uses local
# variables so it can be invoked multiple times during development.
phase21_unified_flow() {
  local base="$1"
  local cookieA="$2"
  local cookieB="$3"

  command -v jq >/dev/null 2>&1 || { echo "FAIL: jq required for Phase 2.1 smoke flow"; exit 1; }
  [[ -n "$base"     ]] || { echo "FAIL: phase21_unified_flow needs base URL";   exit 1; }
  [[ -n "$cookieA"  ]] || { echo "FAIL: phase21_unified_flow needs cookieA";    exit 1; }
  [[ -n "$cookieB"  ]] || { echo "FAIL: phase21_unified_flow needs cookieB";    exit 1; }

  echo "== Phase 2.1: register YouTube data_source =="
  local sourceResp sourceId
  sourceResp=$(curl -sf -X POST "$base/api/sources" \
    -H "cookie: $cookieA" \
    -H "content-type: application/json" \
    -d '{"kind":"youtube_channel","handleUrl":"https://youtube.com/@smoke-21","displayName":"Smoke source","isOwnedByMe":true,"autoImport":true}') \
    || { echo "FAIL: POST /api/sources did not return 2xx"; exit 1; }
  sourceId=$(echo "$sourceResp" | jq -r '.id // empty')
  [[ -n "$sourceId" ]] || { echo "FAIL: source id missing in response: $sourceResp"; exit 1; }
  # AGENTS.md invariant 5 / Plan 02.1-04 P3 discipline: DTO MUST NOT carry userId.
  echo "$sourceResp" | jq -e 'has("userId") | not' >/dev/null \
    || { echo "FAIL: DataSourceDto leaked userId; body=$sourceResp"; exit 1; }
  echo "  source registered: id=$sourceId"

  echo "== Phase 2.1: create youtube_video event (Option A — manual paste path; CI determinism) =="
  # Option A per plan 02.1-10 <interfaces>: bypass oEmbed (which would need
  # network egress to youtube.com) and use the free-form POST /api/events with
  # an explicit kind. source_id is therefore NULL on this row, exercising the
  # D-05 unified PollingBadge contract on the manual-paste branch.
  local eventResp eventId
  eventResp=$(curl -sf -X POST "$base/api/events" \
    -H "cookie: $cookieA" \
    -H "content-type: application/json" \
    -d '{"kind":"youtube_video","title":"Smoke 2.1 video","occurredAt":"2026-04-28T12:00:00Z","url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}') \
    || { echo "FAIL: POST /api/events did not return 2xx"; exit 1; }
  eventId=$(echo "$eventResp" | jq -r '.id // empty')
  [[ -n "$eventId" ]] || { echo "FAIL: event id missing in response: $eventResp"; exit 1; }
  # Manual-paste flow MUST yield sourceId=null (no oEmbed match in CI).
  echo "$eventResp" | jq -e '.sourceId == null' >/dev/null \
    || { echo "FAIL: expected sourceId=null on manual paste; body=$eventResp"; exit 1; }
  echo "  event created: id=$eventId sourceId=null"

  echo "== Phase 2.1: GET /api/events (the /feed query) returns the new event =="
  local feedResp
  feedResp=$(curl -sf "$base/api/events" -H "cookie: $cookieA") \
    || { echo "FAIL: GET /api/events did not return 2xx"; exit 1; }
  echo "$feedResp" | jq -e --arg id "$eventId" '.rows | map(.id) | index($id) != null' >/dev/null \
    || { echo "FAIL: /api/events did not return the new event id=$eventId"; exit 1; }

  echo "== Phase 2.1: create a game so we can attach =="
  local gameResp gameId
  gameResp=$(curl -sf -X POST "$base/api/games" \
    -H "cookie: $cookieA" \
    -H "content-type: application/json" \
    -d '{"title":"Smoke 2.1 game"}') \
    || { echo "FAIL: POST /api/games did not return 2xx"; exit 1; }
  gameId=$(echo "$gameResp" | jq -r '.id // empty')
  [[ -n "$gameId" ]] || { echo "FAIL: game id missing in response: $gameResp"; exit 1; }
  echo "  game created: id=$gameId"

  echo "== Phase 2.1: PATCH /api/events/:id/attach =="
  # Plan 02.1-28 (round-4 closure §4.24.G): the canonical wire shape is
  # {gameIds: string[]}. The legacy {gameId: string | null} alias is still
  # accepted by the route's union schema for one round of UAT, but the
  # response DTO ALWAYS uses the new array shape. We send the canonical
  # shape and assert the canonical shape on the response.
  local attachResp
  attachResp=$(curl -sf -X PATCH "$base/api/events/$eventId/attach" \
    -H "cookie: $cookieA" \
    -H "content-type: application/json" \
    -d "{\"gameIds\":[\"$gameId\"]}") \
    || { echo "FAIL: PATCH /api/events/:id/attach did not return 2xx"; exit 1; }
  echo "$attachResp" | jq -e --arg gid "$gameId" '.gameIds | index($gid) != null' >/dev/null \
    || { echo "FAIL: attach did not include gameId in gameIds[]; body=$attachResp"; exit 1; }

  echo "== Phase 2.1: GET /api/games/:gameId/events returns the attached event =="
  local gameEventsResp
  gameEventsResp=$(curl -sf "$base/api/games/$gameId/events" -H "cookie: $cookieA") \
    || { echo "FAIL: GET /api/games/:gameId/events did not return 2xx"; exit 1; }
  echo "$gameEventsResp" | jq -e --arg id "$eventId" 'map(.id) | index($id) != null' >/dev/null \
    || { echo "FAIL: per-game events did not include the attached event id=$eventId"; exit 1; }

  echo "== Phase 2.1: cross-tenant — userB GET /api/sources/:id must 404 =="
  local statusSrc bodySrc
  bodySrc=$(curl -s -o /tmp/p21-cross-src.txt -w '%{http_code}' \
    -X GET "$base/api/sources/$sourceId" \
    -H "cookie: $cookieB")
  statusSrc="$bodySrc"
  if [[ "$statusSrc" != "404" ]]; then
    echo "FAIL: cross-tenant GET /api/sources/:id status=$statusSrc (expected 404; Pitfall 4 — must NOT be 500)"
    cat /tmp/p21-cross-src.txt 2>/dev/null
    exit 1
  fi
  # AGENTS.md invariant 2 — body must NOT leak forbidden|permission for tenant-owned 404s.
  if grep -Eqi 'forbidden|permission' /tmp/p21-cross-src.txt 2>/dev/null; then
    echo "FAIL: cross-tenant /api/sources body leaked 'forbidden|permission' (PRIV-01 violation)"
    cat /tmp/p21-cross-src.txt
    exit 1
  fi

  echo "== Phase 2.1: cross-tenant — userB PATCH /api/events/:id/attach must 404 =="
  # User B creates their own game, then tries to attach userA's eventId to it.
  # Event ownership wins (Pitfall 4): the service throws NotFoundError on the
  # event lookup before it ever reaches the gameId check, so the response is
  # 404 with no leaky body.
  local userbGameResp userbGameId
  userbGameResp=$(curl -sf -X POST "$base/api/games" \
    -H "cookie: $cookieB" \
    -H "content-type: application/json" \
    -d '{"title":"User B game"}') \
    || { echo "FAIL: userB POST /api/games did not return 2xx"; exit 1; }
  userbGameId=$(echo "$userbGameResp" | jq -r '.id // empty')
  [[ -n "$userbGameId" ]] || { echo "FAIL: userB game id missing"; exit 1; }

  local statusAttach
  statusAttach=$(curl -s -o /tmp/p21-cross-attach.txt -w '%{http_code}' \
    -X PATCH "$base/api/events/$eventId/attach" \
    -H "cookie: $cookieB" \
    -H "content-type: application/json" \
    -d "{\"gameIds\":[\"$userbGameId\"]}")
  if [[ "$statusAttach" != "404" ]]; then
    echo "FAIL: cross-tenant PATCH /api/events/:id/attach status=$statusAttach (expected 404; Pitfall 4 — must NOT be 500)"
    cat /tmp/p21-cross-attach.txt 2>/dev/null
    exit 1
  fi
  if grep -Eqi 'forbidden|permission' /tmp/p21-cross-attach.txt 2>/dev/null; then
    echo "FAIL: cross-tenant /api/events/:id/attach body leaked 'forbidden|permission' (PRIV-01 violation)"
    cat /tmp/p21-cross-attach.txt
    exit 1
  fi

  echo "== Phase 2.1 unified flow: PASS =="
}
