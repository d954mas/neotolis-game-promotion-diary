#!/usr/bin/env bash
# Wraps youtube-mock.mjs lifecycle for the smoke gate.
#
# Pattern matches oauth-mock-driver: a tiny long-lived helper spawned by
# tests/smoke/self-host.sh, the wrapper exports YOUTUBE_MOCK_PORT +
# YOUTUBE_MOCK_PID into the parent shell so subsequent assertions can
# point YOUTUBE_API_BASE_URL at it and tear it down on EXIT.
#
# Usage:
#   source tests/smoke/lib/youtube-mock.sh
#   start_youtube_mock     # exports YOUTUBE_MOCK_PORT + YOUTUBE_MOCK_PID
#   ...assertions...       # YOUTUBE_API_BASE_URL=http://localhost:$YOUTUBE_MOCK_PORT
#   stop_youtube_mock      # SIGTERM the mock; wait for exit (auto on EXIT)

YOUTUBE_MOCK_PID=""
YOUTUBE_MOCK_PORT=""

start_youtube_mock() {
  # Pick a random free port via Node so the smoke gate never collides
  # with the SvelteKit app port (3000) or the OAuth mock (9090). Cross-
  # platform: works on the GitHub Actions Linux runner and on macOS.
  YOUTUBE_MOCK_PORT=$(node -e 'const s = require("net").createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => console.log(p)); });')
  if [[ -z "$YOUTUBE_MOCK_PORT" ]]; then
    echo "[youtube-mock] FAIL: could not allocate free port" >&2
    return 1
  fi
  export YOUTUBE_MOCK_PORT

  # Spawn the Node stub in the background. The mjs file reads PORT from
  # YOUTUBE_MOCK_PORT (already exported above).
  node "$(dirname "${BASH_SOURCE[0]}")/youtube-mock.mjs" >/tmp/youtube-mock.log 2>&1 &
  YOUTUBE_MOCK_PID=$!
  export YOUTUBE_MOCK_PID

  # Wait up to 5s for the mock to bind. We probe /videos because /healthz
  # isn't implemented (intentionally — the stub mirrors Google's surface,
  # which has no health endpoint).
  for _ in $(seq 1 50); do
    if curl -sf "http://localhost:$YOUTUBE_MOCK_PORT/videos" >/dev/null 2>&1; then
      echo "[youtube-mock] started on :$YOUTUBE_MOCK_PORT (pid $YOUTUBE_MOCK_PID)"
      return 0
    fi
    sleep 0.1
  done

  echo "[youtube-mock] FAIL: did not bind within 5s" >&2
  echo "----- youtube-mock log -----" >&2
  cat /tmp/youtube-mock.log >&2 || true
  echo "----------------------------" >&2
  return 1
}

stop_youtube_mock() {
  if [[ -n "$YOUTUBE_MOCK_PID" ]]; then
    kill -TERM "$YOUTUBE_MOCK_PID" 2>/dev/null || true
    # Give SIGTERM a moment, then force-kill if still alive.
    for _ in $(seq 1 20); do
      if ! kill -0 "$YOUTUBE_MOCK_PID" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
    kill -KILL "$YOUTUBE_MOCK_PID" 2>/dev/null || true
    wait "$YOUTUBE_MOCK_PID" 2>/dev/null || true
    echo "[youtube-mock] stopped (pid $YOUTUBE_MOCK_PID)"
    YOUTUBE_MOCK_PID=""
    YOUTUBE_MOCK_PORT=""
  fi
}

# Auto-cleanup on EXIT — the smoke harness's outer trap takes care of
# Docker containers; this trap takes care of the mock process so a
# half-failed assertion doesn't leak a zombie Node process.
trap 'stop_youtube_mock' EXIT
