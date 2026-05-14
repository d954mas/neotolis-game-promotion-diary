#!/usr/bin/env bash
# Wraps reddit-mock.mjs lifecycle for the smoke gate.
#
# Pattern mirrors youtube-mock.sh: a tiny long-lived helper sourced by
# tests/smoke/lib/reddit-polling-flow.sh (and reachable from
# tests/smoke/self-host.sh). Exports REDDIT_MOCK_PORT + REDDIT_MOCK_PID
# into the parent shell so subsequent assertions can point
# REDDIT_BASE_URL_OVERRIDE at it and tear it down on EXIT.
#
# Usage:
#   source tests/smoke/lib/reddit-mock.sh
#   start_reddit_mock     # exports REDDIT_MOCK_PORT + REDDIT_MOCK_PID
#   ...assertions...      # REDDIT_BASE_URL_OVERRIDE=http://localhost:$REDDIT_MOCK_PORT
#   stop_reddit_mock      # SIGTERM the mock; wait for exit (auto on EXIT)

REDDIT_MOCK_PID=""
REDDIT_MOCK_PORT=""

start_reddit_mock() {
  # Pick a random free port via Node so we never collide with the
  # SvelteKit app (3000), the OAuth mock (9090), or the YouTube mock.
  # Cross-platform: works on the GitHub Actions Linux runner and macOS.
  REDDIT_MOCK_PORT=$(node -e 'const s = require("net").createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => console.log(p)); });')
  if [[ -z "$REDDIT_MOCK_PORT" ]]; then
    echo "[reddit-mock] FAIL: could not allocate free port" >&2
    return 1
  fi
  export REDDIT_MOCK_PORT

  # Spawn the Node stub. The mjs file reads PORT from REDDIT_MOCK_PORT
  # (exported above).
  node "$(dirname "${BASH_SOURCE[0]}")/reddit-mock.mjs" >/tmp/reddit-mock.log 2>&1 &
  REDDIT_MOCK_PID=$!
  export REDDIT_MOCK_PID

  # Wait up to 5s for the mock to bind. We probe /r/test/new.json since
  # /healthz isn't implemented (the stub mirrors Reddit's surface, which
  # has no health endpoint).
  for _ in $(seq 1 50); do
    if curl -sf "http://localhost:$REDDIT_MOCK_PORT/r/test/new.json" >/dev/null 2>&1; then
      echo "[reddit-mock] started on :$REDDIT_MOCK_PORT (pid $REDDIT_MOCK_PID)"
      return 0
    fi
    sleep 0.1
  done

  echo "[reddit-mock] FAIL: did not bind within 5s" >&2
  echo "----- reddit-mock log -----" >&2
  cat /tmp/reddit-mock.log >&2 || true
  echo "---------------------------" >&2
  return 1
}

stop_reddit_mock() {
  if [[ -n "$REDDIT_MOCK_PID" ]]; then
    kill -TERM "$REDDIT_MOCK_PID" 2>/dev/null || true
    # Give SIGTERM a moment, then force-kill if still alive.
    for _ in $(seq 1 20); do
      if ! kill -0 "$REDDIT_MOCK_PID" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
    kill -KILL "$REDDIT_MOCK_PID" 2>/dev/null || true
    wait "$REDDIT_MOCK_PID" 2>/dev/null || true
    echo "[reddit-mock] stopped (pid $REDDIT_MOCK_PID)"
    REDDIT_MOCK_PID=""
    REDDIT_MOCK_PORT=""
  fi
}

# Auto-cleanup on EXIT — the smoke harness's outer trap takes care of
# Docker containers; this trap takes care of the mock process so a
# half-failed assertion doesn't leak a zombie Node process.
trap 'stop_reddit_mock' EXIT
