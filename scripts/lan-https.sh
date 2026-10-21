#!/usr/bin/env bash
# HRVO over HTTPS for phones and other computers on your network (docs/runbooks/lan-https.md).
#
#   npm run lan:up      # = bash scripts/lan-https.sh start
#   npm run lan:down    # = bash scripts/lan-https.sh stop
#   npm run lan:check
#
# start: writes .env.lan from LAN_HOST (default: this computer's address), issues the certificate
# (mkcert if installed, otherwise OpenSSL with a local CA), starts the TLS proxy
# (scripts/lan-proxy.ts; LAN_PROXY=caddy uses the docker-compose profile instead), then the API
# and the web app, all listening on 0.0.0.0 (LAN_BIND / HOST), and runs the check.
# LAN_WEB_MODE=production builds the web app first (NEXT_PUBLIC_* values are baked into a build).
# Logs: .lan-https/logs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.lan-https"
LOGS="$STATE/logs"
NODE_TS=(node --experimental-strip-types --no-warnings=ExperimentalWarning)
LAN=("${NODE_TS[@]}" "$ROOT/scripts/lan.ts")

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  elif command -v podman >/dev/null 2>&1; then podman compose "$@"
  else echo "Docker or Podman with Compose is needed for LAN_PROXY=caddy." >&2; exit 1; fi
}

pid_on_port() {
  { ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; } || true
}

stop_servers() {
  for f in "$STATE"/*.pid; do
    [[ -e "$f" ]] || continue
    pid="$(cat "$f")"
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    rm -f "$f"
  done
  # Our own node processes still holding the ports (an earlier manual start).
  for p in "${LAN_WEB_UPSTREAM:-3000}" "${LAN_API_UPSTREAM:-3001}" "${LAN_WEB_PORT:-3443}" "${LAN_API_PORT:-3444}" "${LAN_LIVEKIT_PORT:-7443}" "${LAN_STORAGE_PORT:-8443}"; do
    pid="$(pid_on_port "$p")"
    if [[ -n "$pid" ]] && [[ "$(ps -o comm= -p "$pid" 2>/dev/null)" =~ ^(node|next-server|npm) ]]; then
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
    fi
  done
  sleep 2
}

load_lan_env() {
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env.lan"
  set +a
}

start() {
  (cd "$ROOT" && npm run -s verify -- --preflight) || { echo "Start the containers first: docker compose up -d (or podman compose up -d)" >&2; exit 1; }

  "${LAN[@]}" env
  "${LAN[@]}" certs
  load_lan_env
  mkdir -p "$LOGS"

  stop_servers
  cd "$ROOT"
  if [[ "${LAN_PROXY:-node}" == "caddy" ]]; then
    compose --profile lan-https up -d --force-recreate lan-proxy > "$LOGS/proxy-up.log" 2>&1 || { cat "$LOGS/proxy-up.log" >&2; exit 1; }
  else
    nohup "${NODE_TS[@]}" "$ROOT/scripts/lan-proxy.ts" < /dev/null > "$LOGS/proxy.log" 2>&1 &
    echo $! > "$STATE/proxy.pid"
  fi

  nohup npm run -s api < /dev/null > "$LOGS/api.log" 2>&1 &
  echo $! > "$STATE/api.pid"
  # Next.js runs from apps/web, or Tailwind does not find its config.
  cd "$ROOT/apps/web"
  if [[ "${LAN_WEB_MODE:-dev}" == "production" ]]; then
    echo "Building the web app with the .env.lan values (NEXT_PUBLIC_* are baked into the build) ..."
    npx --no-install next build > "$LOGS/web-build.log" 2>&1 || { tail -30 "$LOGS/web-build.log" >&2; exit 1; }
    nohup npx --no-install next start -p "$LAN_WEB_UPSTREAM" -H "${LAN_BIND:-0.0.0.0}" < /dev/null > "$LOGS/web.log" 2>&1 &
  else
    nohup npx --no-install next dev -p "$LAN_WEB_UPSTREAM" -H "${LAN_BIND:-0.0.0.0}" < /dev/null > "$LOGS/web.log" 2>&1 &
  fi
  echo $! > "$STATE/web.pid"
  cd "$ROOT"

  echo "Waiting for the proxy, the API and the web app (the first page compiles for up to a minute) ..."
  for _ in $(seq 1 30); do [[ -n "$(pid_on_port "$LAN_API_PORT")" ]] && break; sleep 1; done
  for _ in $(seq 1 120); do curl -s -m 2 -o /dev/null "http://127.0.0.1:$LAN_API_UPSTREAM/health" && break; sleep 1; done
  for _ in $(seq 1 120); do curl -s -m 30 -o /dev/null "http://127.0.0.1:$LAN_WEB_UPSTREAM/login" && break; sleep 1; done

  "${LAN[@]}" check || true
  cat <<MSG

Open on any device that trusts the root certificate:  $APP_WEB_URL
On this computer also:                                 https://localhost:$LAN_WEB_PORT  (or http://localhost:$LAN_WEB_UPSTREAM)
Phones and other computers: npm run lan:share-ca, then follow docs/runbooks/lan-https.md.
Stop: npm run lan:down
MSG
}

stop() {
  if [[ -f "$ROOT/.env.lan" ]]; then load_lan_env; fi
  stop_servers
  if command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1; then
    (cd "$ROOT" && LAN_HOST="${LAN_HOST:-stopped}" compose --profile lan-https stop lan-proxy) >/dev/null 2>&1 || true
  fi
  echo "Stopped the LAN proxy, the API and the web app."
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
