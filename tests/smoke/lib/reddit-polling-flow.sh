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
