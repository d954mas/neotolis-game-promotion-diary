#!/usr/bin/env bash
set -euo pipefail

# Phase 1 Wave 0 skeleton. Plan 01-10 (self-host smoke) replaces the body with the full
# 5-step happy path described in CONTEXT.md D-15 (Phase 1 scope per <deviations> 2026-04-27).
#
# Why a stub today: the full assertions need build/server.js (Plan 01-06), oauth2-mock-server
# wired to Better Auth (Plan 01-05), the audit_log sentinel resource (Plan 01-07), and the
# Paraglide dashboard message (Plan 01-09). Wave 0 lands the script structure so Plans 03-10
# can fill in the body without inventing the lifecycle.

if [[ -z "${CI:-}" ]] && [[ -z "${ALLOW_LOCAL_SMOKE:-}" ]]; then
  echo "self-host smoke is CI-only by default. Set ALLOW_LOCAL_SMOKE=1 to run locally."
  exit 0
fi

echo "[smoke] image must already be built as neotolis:ci"
docker image inspect neotolis:ci > /dev/null

echo "[smoke] WAVE-0 STUB — full assertions land in Plan 01-10"
# The full script (Plan 01-10) — BLOCKER 7 fix: every docker run exercises the image
# ENTRYPOINT, no `sh -c` wrapper, no --entrypoint override. This guarantees what CI
# verifies is what self-host operators actually run.
#
#   1. Boot oauth2-mock-server on :9090 (host network).
#   2. docker run -d -e APP_ROLE=app neotolis:ci ; wait /readyz returns 200.
#   3. docker run --rm -e APP_ROLE=worker neotolis:ci (timeout 5s, grep "worker ready").
#   4. docker run --rm -e APP_ROLE=scheduler neotolis:ci (timeout 5s, grep "scheduler ready").
#   5. OAuth dance against mock; create user A; create user B; cross-tenant 404; anon 401;
#      assert dashboard renders English message text.

exit 0
