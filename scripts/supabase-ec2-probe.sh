#!/usr/bin/env bash
# Run scripts/supabase-ec2-probe.mjs on the EC2 host in a throw-away, resource-limited container from the
# existing API image (ADR 052). Touches no live container, volume, network or database. Needs approval.
#
#   bash scripts/supabase-ec2-probe.sh            # from /opt/virtual-hr/app, as ubuntu (uses sudo -n docker)
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=${ENV_FILE:-/opt/virtual-hr/app/.env.staging.supabase}
CA=${CA:-/opt/virtual-hr/secrets/supabase/prod-ca-2021.crt}
IMAGE=${IMAGE:-hrvo-api:staging}
NET=hrvo-sbprobe
D="sudo -n docker"

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; exit 2; }
[ "$(stat -c %a "$ENV_FILE")" = 600 ] || { echo "$ENV_FILE must be mode 600"; exit 2; }
grep -qE '^SUPABASE_ADMIN_PASSWORD=.+' "$ENV_FILE" && { echo "refusing: $ENV_FILE holds the Supabase admin password"; exit 2; }
sudo -n test -f "$CA" || { echo "missing $CA"; exit 2; }

# Readable copy of the env file for the container's non-root user, removed on exit.
TMP=$(mktemp -d); chmod 700 "$TMP"
sudo -n install -m 644 "$ENV_FILE" "$TMP/sb.env"
cleanup() { $D network rm "$NET" >/dev/null 2>&1 || true; sudo -n rm -rf "$TMP"; }
trap cleanup EXIT

echo "live containers before:"; $D ps --format '{{.Names}} {{.Status}}' | sort
$D network create --driver bridge "$NET" >/dev/null   # own network: not attached to data/edge/api_egress
rc=0
probe() { # $1 = script in scripts/; the rest are its arguments
  local s=$1; shift
  $D run --rm --name hrvo-sbprobe --network "$NET" \
    --read-only --tmpfs /tmp:size=16m --memory 256m --memory-swap 256m --cpus 0.5 --pids-limit 64 \
    --cap-drop ALL --security-opt no-new-privileges \
    -v "$TMP/sb.env:/run/sb.env:ro" -v "$CA:/run/supabase-tls/ca.crt:ro" \
    -v "$PWD/scripts/$s:/app/$s:ro" \
    --entrypoint node "$IMAGE" "/app/$s" "$@"
}
echo "== connectivity, TLS, RLS, round-trip budget, pool, LISTEN/NOTIFY"
probe supabase-ec2-probe.mjs /run/sb.env /run/supabase-tls/ca.crt || rc=$?
echo "== synthetic tenants: cross-tenant RLS and FR-ATT-002 logout timing (image's own code)"
probe supabase-ec2-logout.mjs /run/sb.env /run/supabase-tls/ca.crt /app/dist || rc=$?
echo "live containers after:"; $D ps --format '{{.Names}} {{.Status}}' | sort
exit $rc
