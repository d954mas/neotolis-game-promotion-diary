#!/usr/bin/env bash
# pnpm deploy (D-22). Triggers a deploy on the production VPS via the
# `command="..."` restricted SSH key. The remote sshd's authorized_keys
# entry restricts this key to running:
#
#   cd /opt/diary && docker compose -f docker-compose.prod.yml pull \
#                 && docker compose -f docker-compose.prod.yml up -d
#
# So the SSH login itself runs the deploy. This script is therefore
# minimal: open the SSH session, capture output, then verify /healthz.
#
# Setup is documented in docs/deploy/install.md (Plan 02.2-08).

set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
DEPLOY_HOST="${DEPLOY_HOST:?DEPLOY_HOST required (e.g. diary.example.app)}"
APP_DIR="${APP_DIR:-/opt/diary}"

echo "==> Triggering deploy on ${DEPLOY_USER}@${DEPLOY_HOST}"

# The remote SSH key is `command=...` restricted (see VPS hardening
# in docs/deploy/install.md §1). The SSH login itself runs the
# restricted command (cd /opt/diary && docker compose pull && up -d).
ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    "${DEPLOY_USER}@${DEPLOY_HOST}" 2>&1 | tee deploy.log

echo "==> Deploy triggered. Verifying health..."
sleep 15
if curl -fsS "https://${DEPLOY_HOST}/healthz" >/dev/null; then
  echo "==> /healthz returned 200. Deploy successful."
else
  echo "==> /healthz did NOT return 200. Investigate."
  exit 1
fi
