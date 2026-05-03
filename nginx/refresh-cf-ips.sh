#!/usr/bin/env bash
set -euo pipefail
OUT="$(dirname "$0")/cf-ips.conf"
{
  echo "# Cloudflare IPv4 ranges (refreshed $(date -u +%Y-%m-%d))"
  curl -fsSL https://www.cloudflare.com/ips-v4/ | sed 's|^|set_real_ip_from |; s|$|;|'
  echo "# Cloudflare IPv6 ranges"
  curl -fsSL https://www.cloudflare.com/ips-v6/ | sed 's|^|set_real_ip_from |; s|$|;|'
} > "$OUT"
echo "wrote $OUT"
