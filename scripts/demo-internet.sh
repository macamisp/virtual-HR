#!/usr/bin/env bash
# Internet demo: tunnels and teardown (docs/runbooks/demo-internet.md). Needs cloudflared.
#
#   scripts/demo-internet.sh tunnels-start named <tunnel-name>   # recommended: your own domain
#   scripts/demo-internet.sh tunnels-start quick                 # random *.trycloudflare.com URLs (caveats in the runbook)
#   scripts/demo-internet.sh status
#   scripts/demo-internet.sh tunnels-stop
#   scripts/demo-internet.sh teardown                            # stop the tunnels and delete the demo organisation
#
# Only web (3000), API (3001) and storage (9000, MinIO S3 API; never the 9001 console) are tunnelled. Postgres, Redis, ClamAV and the
# KMS emulator are never exposed. Shut the demo down whenever it is not in use.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$ROOT/.demo-internet" # process ids and logs; gitignored
WEB_PORT="${WEB_PORT:-3000}"
API_PORT="${API_PORT:-3001}"
S3_PORT="${S3_PORT:-9000}" # MinIO from docker-compose; 8333 for SeaweedFS
mkdir -p "$STATE"

need_cloudflared() {
  command -v cloudflared >/dev/null 2>&1 || { echo "cloudflared is not installed (see the runbook, "Before you start")." >&2; exit 1; }
}

# Background a cloudflared process and remember its id.
launch() { # name, args...
  local name="$1"; shift
  if [ -f "$STATE/$name.pid" ] && is_cloudflared "$(cat "$STATE/$name.pid")"; then
    echo "$name tunnel is already running (pid $(cat "$STATE/$name.pid"))."; return
  fi
  nohup cloudflared --no-autoupdate "$@" >"$STATE/$name.log" 2>&1 &
  echo $! >"$STATE/$name.pid"
  echo "started $name tunnel (pid $!, log $STATE/$name.log)"
}

# A recorded id is only killed when it still belongs to cloudflared (ids are reused).
is_cloudflared() { [ -n "${1:-}" ] && ps -p "$1" -o comm= 2>/dev/null | grep -q cloudflared; }

tunnels_start() {
  need_cloudflared
  case "${1:-}" in
    named)
      local tunnel="${2:-}" config="${3:-$ROOT/infra/demo/cloudflared.yml}"
      [ -n "$tunnel" ] || { echo "Usage: $0 tunnels-start named <tunnel-name> [config.yml]" >&2; exit 2; }
      [ -f "$config" ] || { echo "Missing $config: copy infra/demo/cloudflared.example.yml and fill in your hostnames." >&2; exit 2; }
      launch named tunnel --config "$config" run "$tunnel"
      echo "Hostnames are the ones in $config."
      ;;
    quick)
      launch web tunnel --url "http://localhost:$WEB_PORT"
      launch api tunnel --url "http://localhost:$API_PORT"
      launch storage tunnel --url "http://localhost:$S3_PORT"
      echo "Waiting for the public URLs..."
      sleep 10
      for name in web api storage; do
        printf '  %-8s %s\n' "$name" "$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$STATE/$name.log" | head -1 || true)"
      done
      echo "Quick-tunnel URLs change on every start: update .env.demo-internet and rebuild the web app (runbook step 4)."
      ;;
    *) echo "Usage: $0 tunnels-start named <tunnel-name> | quick" >&2; exit 2 ;;
  esac
}

tunnels_stop() {
  local any=0
  for pidfile in "$STATE"/*.pid; do
    [ -e "$pidfile" ] || continue
    local pid name
    pid="$(cat "$pidfile")"; name="$(basename "$pidfile" .pid)"
    if is_cloudflared "$pid"; then kill "$pid" && echo "stopped $name tunnel (pid $pid)"; any=1; fi
    rm -f "$pidfile"
  done
  [ "$any" = 1 ] || echo "No demo tunnels were running."
}

status() {
  local any=0
  for pidfile in "$STATE"/*.pid; do
    [ -e "$pidfile" ] || continue
    local pid; pid="$(cat "$pidfile")"
    if is_cloudflared "$pid"; then echo "RUNNING  $(basename "$pidfile" .pid) tunnel (pid $pid)"; any=1; fi
  done
  [ "$any" = 1 ] || echo "No demo tunnels are running."
}

teardown() {
  tunnels_stop
  (cd "$ROOT" && node --env-file-if-exists=.env --experimental-strip-types apps/api/test/teardown-internet-demo.ts)
  cat <<'EOF'
Still to do by hand (runbook, "Shut down"):
  - stop the demo API and web processes (Ctrl+C in their terminals);
  - in LiveKit Cloud, delete the webhook and revoke the API key used for the demo;
  - if you used a named tunnel, remove its public hostnames in Cloudflare (or delete the tunnel).
EOF
}

case "${1:-}" in
  tunnels-start) shift; tunnels_start "$@" ;;
  tunnels-stop) tunnels_stop ;;
  status) status ;;
  teardown) teardown ;;
  *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
