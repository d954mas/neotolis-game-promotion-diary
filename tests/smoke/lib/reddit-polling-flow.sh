#!/usr/bin/env bash
# Reddit not-configured parity smoke flow (Phase 12 — gated-provider model).
#
# Sourced (not exec'd) by tests/smoke/self-host.sh after the YouTube polling
# flow completes. Mirrors the Instagram / TikTok not-configured parity block:
# the baseline smoke image boots the production image with the Reddit provider
# UNCONFIGURED (REDDIT_IMPORT_ENABLED is NOT in common_env_args, so the D-08
# kill-switch keeps Reddit OFF even though the shared SCRAPECREATORS_API_KEY is
# also absent). This is the load-bearing self-host trust signal: an operator who
# hasn't explicitly opted Reddit in gets a CLEANLY DISABLED Reddit — identical to
# SaaS — NOT a 500 and NOT an enabled import path.
#
# Phase 12 razed the old free-`.json` transport (the deleted per-role Reddit
# user-agent / base-URL-override / proxy envs, the round-robin batch worker, and
# its old cron schedules). Reddit is now a PAID ScrapeCreators adapter behind a
# provider gate. There is NO live-import smoke: the paid path has no key in CI
# (mirrors the YouTube-mock / no-live-API discipline) and is covered by the human
# UAT + integration tests. The smoke gate's job here is the not-configured
# degrade + isolation, exactly like Instagram / TikTok.
#
# Two assertions (both against the unconfigured baseline app):
#   RDT.1  POST /api/sources {kind:"reddit_account", …} → 422 kind_not_configured
#          (the createSource provider gate — SOURCE_KINDS_NEEDING_PROVIDER →
#          isRedditConfigured() false because REDDIT_IMPORT_ENABLED != "true").
#          Never a 500, never a created row. createSource degrades BEFORE any
#          provider call, so the 422 never touches the network.
#   RDT.2  /sources/new HTML renders the Reddit chip disabled with the Reddit-
#          specific "Set REDDIT_IMPORT_ENABLED to enable Reddit import" status
#          (source_kind_status_reddit_account). That status only renders when the
#          chip's kindMatrix entry is disabled+not-configured, so its presence is
#          the user-facing proof Reddit is off + how to enable it.
#
# Helpers (log, fail) are inherited from the caller (tests/smoke/self-host.sh).

# shellcheck disable=SC2154   # log, fail are inherited.

reddit_not_configured_smoke() {
  local app_url="$1"
  local session_cookie="$2"

  log "=== Reddit not-configured parity (Phase 12) ==="

  # RDT.1: POST /api/sources with a reddit_account handle and the provider env
  # unset → 422 kind_not_configured (the createSource degrade gate), never a 500,
  # never a created row. The chip is disabled in the UI; the API is the
  # server-side guard the smoke gate pins.
  local rdt_create_code rdt_create_body
  rdt_create_code=$(curl -sS -o /tmp/rdt-create.txt -w '%{http_code}' \
    -X POST "$app_url/api/sources" \
    -H "cookie: $session_cookie" \
    -H "content-type: application/json" \
    -d '{"kind":"reddit_account","handleUrl":"https://www.reddit.com/user/spez","isOwnedByMe":false,"autoImport":true}' \
    || echo "curl-failed")
  rdt_create_body=$(cat /tmp/rdt-create.txt 2>/dev/null || echo "")
  if [[ "$rdt_create_code" != "422" ]]; then
    log "----- POST /api/sources (reddit_account) response -----"
    echo "$rdt_create_body"
    log "----- recent app logs -----"
    docker logs smoke-app 2>&1 | tail -40 || true
    log "-------------------------------------------------------"
    fail "(RDT.1) reddit_account create with Reddit provider unset returned $rdt_create_code, expected 422 (clean not-configured degrade, never 500)"
  fi
  if ! echo "$rdt_create_body" | grep -q 'kind_not_configured'; then
    log "----- POST /api/sources (reddit_account) response -----"
    echo "$rdt_create_body"
    fail "(RDT.1) reddit_account 422 body did not carry 'kind_not_configured'. Got: $rdt_create_body"
  fi
  log "(RDT.1) PASS — reddit_account create degrades to 422 kind_not_configured (no 500, no provider call)"

  # RDT.2: /sources/new HTML renders the Reddit chip visible-but-disabled with the
  # Reddit-specific "Set REDDIT_IMPORT_ENABLED to enable Reddit import" status —
  # the user-facing affordance that tells a self-host operator Reddit is off + how
  # to enable it. /sources/new is the full-page add-source form, so the disabled
  # Reddit chip + its status render inline at SSR (the /sources modal is closed by
  # default, so its chip markup isn't in that page's initial HTML). The status
  # small only renders when the chip's kindMatrix entry is disabled, and Reddit is
  # in FUNCTIONAL_KINDS, so a disabled Reddit chip is definitionally not-configured.
  local rdt_sources_html
  rdt_sources_html=$(curl -sL -H "cookie: $session_cookie" "$app_url/sources/new" 2>/dev/null || true)
  if ! echo "$rdt_sources_html" | grep -q 'Set REDDIT_IMPORT_ENABLED to enable Reddit import'; then
    log "----- /sources/new HTML (first 1500 chars) -----"
    echo "${rdt_sources_html:0:1500}"
    log "------------------------------------------------"
    fail "(RDT.2) /sources/new HTML should render the Reddit 'Set REDDIT_IMPORT_ENABLED to enable Reddit import' disabled status with the Reddit provider unset"
  fi
  log "(RDT.2) PASS — /sources/new renders Reddit disabled ('Set REDDIT_IMPORT_ENABLED to enable Reddit import')"

  log "=== Reddit not-configured parity PASSED ==="
}

# ---------------------------------------------------------------------------
# Reddit PROVIDER-ON smoke — boots the production image with the D-08 kill-switch
# FLIPPED ON (REDDIT_IMPORT_ENABLED=true) pointed at a hermetic ScrapeCreators mock,
# and drives the full seam the OFF parity flow can't reach: provider-ON bootstrap,
# worker registration of the reddit backfill queues + outbox forwarder, the create-
# source gate flipping to ACCEPT, the author walk fetching through the mock, and the
# reserve-before-HTTP budget seam debiting the SHARED "scrapecreators" ledger (the P0
# fix — a reddit-private key would leave the shared balance untouched). No live
# ScrapeCreators traffic: every call hits the local stub. Runs LAST so its provider-ON
# re-launch of smoke-app/smoke-worker doesn't disturb the earlier OFF parity flows.
reddit_provider_on_smoke() {
  local app_url="$1"
  local session_cookie="$2"

  log "=== Reddit provider-ON smoke (hermetic ScrapeCreators mock) ==="

  # ----- 1. Boot the ScrapeCreators reddit mock on a free host port -----
  local mock_port mock_pid
  mock_port=$(node -e 'const s=require("net").createServer(); s.listen(0,()=>{const p=s.address().port; s.close(()=>console.log(p));});')
  [[ -n "$mock_port" ]] || fail "(RDT-ON) could not allocate a mock port"
  SCRAPECREATORS_MOCK_PORT="$mock_port" node "$(dirname "${BASH_SOURCE[0]}")/scrapecreators-mock.mjs" \
    >/tmp/scrapecreators-mock.log 2>&1 &
  mock_pid=$!
  local mock_up=false
  for _ in $(seq 1 50); do
    if grep -q "listening on" /tmp/scrapecreators-mock.log 2>/dev/null; then mock_up=true; break; fi
    sleep 0.1
  done
  if [[ "$mock_up" != "true" ]]; then
    cat /tmp/scrapecreators-mock.log 2>/dev/null || true
    kill -TERM "$mock_pid" 2>/dev/null || true
    fail "(RDT-ON) scrapecreators-mock did not bind within 5s"
  fi
  log "scrapecreators-mock up on :$mock_port"

  # ----- 2. Re-launch smoke-app + smoke-worker PROVIDER-ON, pointed at the mock -----
  # REDDIT_IMPORT_ENABLED=true flips the kill-switch; SCRAPECREATORS_BASE_URL routes every
  # provider request to the stub; a funded budget (cap + prepaid balance) lets the
  # reserve-before-HTTP gate pass. Same DB as the baseline, so the OAuth session persists.
  docker rm -f smoke-app smoke-worker 2>/dev/null || true
  local reddit_env=(
    -e REDDIT_IMPORT_ENABLED=true
    -e REDDIT_PROVIDER=scrapecreators
    -e SCRAPECREATORS_API_KEY=mock-key
    -e "SCRAPECREATORS_BASE_URL=http://localhost:$mock_port"
    -e SOCIAL_PROVIDER_DAILY_CAP_CREDITS=100
    -e SOCIAL_PROVIDER_PREPAID_BALANCE_CREDITS=1000
    -e LIMIT_SOCIAL_REQUESTS_PER_DAY=50
  )
  # shellcheck disable=SC2046
  docker run -d --name smoke-app --network host \
    -e APP_ROLE=app -e PORT="$APP_PORT" "${reddit_env[@]}" $(common_env_args) neotolis:ci >/dev/null
  # shellcheck disable=SC2046
  docker run -d --name smoke-worker --network host \
    -e APP_ROLE=worker "${reddit_env[@]}" $(common_env_args) neotolis:ci >/dev/null

  local ready=false
  for _ in $(seq 1 60); do
    if curl -fsS "http://localhost:$APP_PORT/readyz" >/dev/null 2>&1; then ready=true; break; fi
    sleep 1
  done
  if [[ "$ready" != "true" ]]; then
    docker logs smoke-app 2>&1 | tail -40 || true
    kill -TERM "$mock_pid" 2>/dev/null || true
    fail "(RDT-ON) provider-ON app /readyz never came up (bootstrap crashed with Reddit ON?)"
  fi
  set +o pipefail
  timeout 30 docker logs -f smoke-worker 2>&1 | grep -q -m1 "worker ready"
  local wr=$?
  set -o pipefail
  if [ $wr -ne 0 ]; then
    docker logs smoke-worker 2>&1 | tail -50 || true
    kill -TERM "$mock_pid" 2>/dev/null || true
    fail "(RDT-ON) provider-ON worker did not print 'worker ready' (queue registration crashed?)"
  fi
  log "(RDT-ON.0) PASS — provider-ON app + worker booted (bootstrap + queue/outbox registration OK with Reddit ON)"

  # ----- 3. create a reddit_account source — the gate must now ACCEPT it -----
  local create_code create_body
  create_code=$(curl -sS -o /tmp/rdt-on-create.txt -w '%{http_code}' -X POST "$app_url/api/sources" \
    -H "cookie: $session_cookie" -H "content-type: application/json" \
    -d '{"kind":"reddit_account","handleUrl":"https://www.reddit.com/user/smokeauthor","isOwnedByMe":true,"autoImport":true}' \
    || echo "curl-failed")
  create_body=$(cat /tmp/rdt-on-create.txt 2>/dev/null || echo "")
  if [[ "$create_code" != "200" && "$create_code" != "201" ]]; then
    echo "$create_body"
    docker logs smoke-app 2>&1 | tail -40 || true
    kill -TERM "$mock_pid" 2>/dev/null || true
    fail "(RDT-ON.1) reddit_account create with the provider ON returned $create_code, expected 200/201"
  fi
  log "(RDT-ON.1) PASS — reddit_account create ACCEPTED provider-ON (the kill-switch flips the gate)"

  # ----- 4. wait for the backfill walk to import via the mock (full HTTP seam) -----
  log "waiting up to 60s for the walk to import t3_smoke01 (event + snapshot via the mock)"
  local imported=false
  for _ in $(seq 1 60); do
    local found
    found=$(docker exec smoke-app node -e '
      import("./node_modules/pg/lib/index.js").then(async (pgMod) => {
        const Client = (pgMod.default && pgMod.default.Client) || pgMod.Client;
        const c = new Client({ connectionString: process.env.DATABASE_URL });
        await c.connect();
        try {
          const e = await c.query("SELECT 1 FROM events WHERE external_id=$1 AND kind=$2 LIMIT 1", ["t3_smoke01","reddit_post"]);
          const s = await c.query("SELECT 1 FROM reddit_post_snapshots WHERE post_id=$1 LIMIT 1", ["t3_smoke01"]);
          console.log(e.rowCount>0 && s.rowCount>0 ? "yes":"no");
        } finally { await c.end(); }
      }).catch((err)=>{console.error(err);process.exit(1);});
    ' 2>/dev/null || echo "no")
    if [[ "$found" == "yes" ]]; then imported=true; break; fi
    sleep 1
  done
  if [[ "$imported" != "true" ]]; then
    docker logs smoke-worker 2>&1 | tail -80 || true
    kill -TERM "$mock_pid" 2>/dev/null || true
    fail "(RDT-ON.2) the provider-ON walk never imported t3_smoke01 (event + snapshot) via the mock"
  fi
  log "(RDT-ON.2) PASS — walk imported the event + snapshot through the hermetic mock (real HTTP seam live)"

  # ----- 5. the reserve-before-HTTP budget seam charged the SHARED ledger (P0) -----
  local balance
  balance=$(docker exec smoke-app node -e '
    import("./node_modules/pg/lib/index.js").then(async (pgMod) => {
      const Client = (pgMod.default && pgMod.default.Client) || pgMod.Client;
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      try {
        const r = await c.query("SELECT prepaid_balance_credits FROM social_provider_balance WHERE provider=$1", ["scrapecreators"]);
        console.log(r.rowCount>0 ? String(r.rows[0].prepaid_balance_credits) : "missing");
      } finally { await c.end(); }
    }).catch((err)=>{console.error(err);process.exit(1);});
  ')
  log "shared scrapecreators balance after the walk: $balance (seeded 1000)"
  # POSITIVE assertion, not a denylist. The probe used to merge stderr into $balance
  # (2>&1) and only reject the literals "missing"/"1000" — so a probe that CRASHED
  # produced a stack trace, matched neither, and read as "the ledger was debited".
  # The strongest P0 assertion in this gate was the one that could silently stop
  # asserting. Require a real integer strictly between 0 and the seeded 1000.
  if ! [[ "$balance" =~ ^[0-9]+$ ]]; then
    kill -TERM "$mock_pid" 2>/dev/null || true
    fail "(RDT-ON.3) the balance probe did not return a number (got: '${balance}') — cannot verify the shared-ledger debit"
  fi
  if (( balance >= 1000 )); then
    kill -TERM "$mock_pid" 2>/dev/null || true
    fail "(RDT-ON.3) the shared 'scrapecreators' balance was not debited ($balance of 1000) — reddit spend did not charge the shared ledger (P0 budget-key regression)"
  fi
  log "(RDT-ON.3) PASS — reddit spend debited the SHARED 'scrapecreators' balance (P0 seam live in the image)"

  kill -TERM "$mock_pid" 2>/dev/null || true
  log "=== Reddit provider-ON smoke PASSED ==="
}
