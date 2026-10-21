#!/usr/bin/env bash
# Run HRVO for other devices on your network over HTTPS (camera, microphone and the attendance
# heartbeat need a secure origin). See docs/runbooks/web-lan.md.
#
#   bash scripts/lan-https.sh start     # detect this computer's IP, issue a certificate, start everything
#   bash scripts/lan-https.sh stop      # stop what start started
#   bash scripts/lan-https.sh status
#
# Set HRVO_IP=1.2.3.4 to choose the address yourself. State, keys and logs live in .lan-https/
# (gitignored). The certificate authority is created once; import .lan-https/ca.pem into each
# browser one time and every later certificate (new IP, renewal) is trusted without warnings.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.lan-https"
LOGS="$STATE/logs"
PORTS=(3000 3001 3443 3444 7443 8443)

detect_ip() {
  if [[ -n "${HRVO_IP:-}" ]]; then echo "$HRVO_IP"; return; fi
  # The address of the interface that carries the default route.
  ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}'
}

pid_on_port() {
  { ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; } || true
}

stop_all() {
  for f in "$STATE"/*.pid; do
    [[ -e "$f" ]] || continue
    pid="$(cat "$f")"
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    rm -f "$f"
  done
  # Anything else still holding the ports (an earlier manual start) is a node process of ours.
  for p in "${PORTS[@]}"; do
    pid="$(pid_on_port "$p")"
    if [[ -n "$pid" ]] && [[ "$(ps -o comm= -p "$pid" 2>/dev/null)" =~ ^(node|next-server|npm) ]]; then
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
    fi
  done
  sleep 2
}

issue_certificates() {
  local ip="$1"
  mkdir -p "$STATE"
  chmod 700 "$STATE"
  if [[ ! -f "$STATE/ca.pem" ]]; then
    echo "Creating the local certificate authority (once) ..."
    openssl req -x509 -newkey rsa:3072 -nodes -days 825 -keyout "$STATE/ca-key.pem" -out "$STATE/ca.pem" \
      -subj "/CN=HRVO local development CA" \
      -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
    chmod 600 "$STATE/ca-key.pem"
  fi
  openssl req -newkey rsa:2048 -nodes -keyout "$STATE/key.pem" -out "$STATE/server.csr" -subj "/CN=$ip" 2>/dev/null
  printf 'subjectAltName=IP:%s,IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$ip" > "$STATE/server.ext"
  openssl x509 -req -in "$STATE/server.csr" -CA "$STATE/ca.pem" -CAkey "$STATE/ca-key.pem" -CAcreateserial \
    -days 90 -out "$STATE/cert.pem" -extfile "$STATE/server.ext" 2>/dev/null
  chmod 600 "$STATE/key.pem"
  rm -f "$STATE/server.csr" "$STATE/server.ext"
}

wait_for() {
  local url="$1" name="$2"
  for _ in $(seq 1 90); do
    if curl -sk -m 3 -o /dev/null "$url"; then echo "  $name is up"; return 0; fi
    sleep 1
  done
  echo "  $name did not start; see $LOGS" >&2
  return 1
}

start_all() {
  local ip
  ip="$(detect_ip)"
  if [[ -z "$ip" ]]; then echo "Could not find this computer's IP address; set HRVO_IP." >&2; exit 1; fi
  echo "This computer's address: $ip"

  (cd "$ROOT" && npm run -s verify -- --preflight) || { echo "Start the containers first (docker compose up -d / podman compose up -d)." >&2; exit 1; }

  stop_all
  issue_certificates "$ip"
  mkdir -p "$LOGS"
  echo "$ip" > "$STATE/ip"

  export CORS_ORIGINS="https://$ip:3443,https://localhost:3443"
  export APP_WEB_URL="https://$ip:3443"
  export NEXT_PUBLIC_API_URL="https://$ip:3444"
  export NEXT_PUBLIC_STORAGE_URL="https://$ip:8443"
  export NEXT_PUBLIC_LIVEKIT_URL="wss://$ip:7443"

  # Each server is started directly in the background (not "cd && cmd &", which would leave a
  # waiting subshell holding this script's output open), and its own pid is recorded.
  nohup node "$ROOT/scripts/lan-tls-proxy.mjs" "$STATE" < /dev/null > "$LOGS/proxy.log" 2>&1 &
  echo $! > "$STATE/proxy.pid"
  cd "$ROOT"
  nohup npm run -s api < /dev/null > "$LOGS/api.log" 2>&1 &
  echo $! > "$STATE/api.pid"
  # Next.js must run from apps/web, or Tailwind does not find its config.
  cd "$ROOT/apps/web"
  nohup npx --no-install next dev -p 3000 -H 0.0.0.0 < /dev/null > "$LOGS/web.log" 2>&1 &
  echo $! > "$STATE/web.pid"
  cd "$ROOT"

  echo "Starting (the first page load compiles for a minute) ..."
  wait_for "http://127.0.0.1:3001/health" "API"
  wait_for "http://127.0.0.1:3000/login" "Web app"
  curl -sk -m 60 -o /dev/null "https://127.0.0.1:3443/login" || true

  cat <<EOF

HRVO is running:   https://$ip:3443
                   (on this computer also https://localhost:3443)

One-time step per browser: import $STATE/ca.pem as a certificate AUTHORITY
  Brave / Chrome:  Settings > Privacy and security > Security > Manage certificates
                   > Authorities > Import > ca.pem > tick "Trust this certificate for identifying websites"
  Firefox:         Settings > Privacy & Security > Certificates > View Certificates
                   > Authorities > Import > ca.pem > tick "Trust this CA to identify websites"
  Phone / other computer: copy ca.pem there and install it as a CA certificate.
Then restart the browser. No warnings on any port afterwards, also after the IP changes.

Logs: $LOGS     Stop: bash scripts/lan-https.sh stop
EOF
}

status() {
  local ip
  ip="$(cat "$STATE/ip" 2>/dev/null || echo '?')"
  echo "Started for: $ip    Current address: $(detect_ip)"
  for pair in "3443 web" "3444 API" "7443 LiveKit" "8443 storage"; do
    set -- $pair
    printf '  %-8s https://%s:%s  ' "$2" "$ip" "$1"
    curl -sk -m 5 -o /dev/null -w '%{http_code}\n' "https://127.0.0.1:$1/$([[ $1 == 3444 ]] && echo health)" || echo down
  done
}

case "${1:-start}" in
  start) start_all ;;
  stop) stop_all; echo "Stopped." ;;
  status) status ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
