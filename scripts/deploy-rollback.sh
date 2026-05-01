#!/usr/bin/env bash
# pnpm deploy:rollback <git-sha> (D-22 / D-24). Pins the production
# stack to a specific GHCR image tag (git sha) and restarts services.
#
# Uses an UNRESTRICTED SSH key (separate from the deploy-only `command=`
# key). This key edits /opt/diary/.env to set IMAGE_TAG=<sha>, then
# runs docker compose pull + up -d. The two-key model is documented
# in docs/deploy/install.md §1 (Plan 02.2-08).

set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
DEPLOY_HOST="${DEPLOY_HOST:?DEPLOY_HOST required}"
APP_DIR="${APP_DIR:-/opt/diary}"
GIT_SHA="${1:?usage: pnpm deploy:rollback <git-sha>}"

echo "==> Pinning image to sha ${GIT_SHA} on ${DEPLOY_HOST}"

# Rollback uses an unrestricted SSH key (separate from the deploy-only key)
# because we need to edit a file + run a different compose command.
ssh "${DEPLOY_USER}@${DEPLOY_HOST}" bash <<EOF
  set -euo pipefail
  cd "${APP_DIR}"
  sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${GIT_SHA}/" .env
  docker compose -f docker-compose.prod.yml pull
  docker compose -f docker-compose.prod.yml up -d
  echo "==> Rolled back to ${GIT_SHA}"
EOF

sleep 15
curl -fsS "https://${DEPLOY_HOST}/healthz" && echo "==> /healthz OK"
