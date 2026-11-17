#!/bin/sh
# HRVO self-hosted LiveKit: secrets and configuration (ADR 067; docs/runbooks/livekit-selfhost.md).
#
#   ./configure.sh init-secrets   create secrets.env (mode 600): a NEW production key pair, the Redis
#                                 password and the Egress config. Refuses to overwrite. Prints names only.
#   ./configure.sh render         generated/livekit.yaml, generated/caddy.yaml and .env (Compose
#                                 interpolation) from livekit.env. No secret is written to these.
#   ./configure.sh check          validate livekit.env and secrets.env without printing values.
#
# Settings: livekit.env (copy livekit.env.example). Secrets: secrets.env, never committed or printed.
set -eu
cd "$(dirname "$0")"

die() { echo "configure.sh: $*" >&2; exit 1; }

load_settings() {
  [ -f livekit.env ] || die "livekit.env missing (copy livekit.env.example)"
  # shellcheck disable=SC1091
  . ./livekit.env
  : "${LIVEKIT_DOMAIN:?set LIVEKIT_DOMAIN in livekit.env}"
  : "${TURN_DOMAIN:?set TURN_DOMAIN in livekit.env}"
  : "${WEBHOOK_URL:?set WEBHOOK_URL in livekit.env}"
  LIVEKIT_PORT=${LIVEKIT_PORT:-7880}
  REDIS_PORT=${REDIS_PORT:-6389}
  CADDY_TLS_PORT=${CADDY_TLS_PORT:-443}
  RTC_TCP_PORT=${RTC_TCP_PORT:-7881}
  RTC_PORT_RANGE_START=${RTC_PORT_RANGE_START:-50000}
  RTC_PORT_RANGE_END=${RTC_PORT_RANGE_END:-60000}
  TURN_TLS_PORT=${TURN_TLS_PORT:-5349}
  TURN_UDP_PORT=${TURN_UDP_PORT:-3478}
  TURN_EXTERNAL_TLS=${TURN_EXTERNAL_TLS:-true}
  TURN_CERT_FILE=${TURN_CERT_FILE:-}
  TURN_KEY_FILE=${TURN_KEY_FILE:-}
  NODE_IP=${NODE_IP:-}
  TLS_ISSUER=${TLS_ISSUER:-acme}
  ACME_EMAIL=${ACME_EMAIL:-}
  ROOM_MAX_PARTICIPANTS=${ROOM_MAX_PARTICIPANTS:-100}
  LIMIT_NUM_TRACKS=${LIMIT_NUM_TRACKS:--1}
  LIMIT_BYTES_PER_SEC=${LIMIT_BYTES_PER_SEC:-1000000000}
  case "$WEBHOOK_URL" in https://*|http://127.0.0.1:*|http://localhost:*) ;; *) die "WEBHOOK_URL must be https:// (or loopback for local tests)";; esac
  case "$TURN_EXTERNAL_TLS" in true|false) ;; *) die "TURN_EXTERNAL_TLS must be true or false";; esac
  if [ "$TURN_EXTERNAL_TLS" = false ] && { [ -z "$TURN_CERT_FILE" ] || [ -z "$TURN_KEY_FILE" ]; }; then
    die "TURN_EXTERNAL_TLS=false needs TURN_CERT_FILE and TURN_KEY_FILE"
  fi
  case "$TLS_ISSUER" in acme) [ -n "$ACME_EMAIL" ] || die "set ACME_EMAIL for Let's Encrypt";; internal) ;; *) die "TLS_ISSUER must be acme or internal";; esac
  for p in "$LIVEKIT_PORT" "$REDIS_PORT" "$CADDY_TLS_PORT" "$RTC_TCP_PORT" "$RTC_PORT_RANGE_START" "$RTC_PORT_RANGE_END" "$TURN_TLS_PORT" "$TURN_UDP_PORT"; do
    case "$p" in ''|*[!0-9]*) die "ports must be numbers";; esac
  done
}

# The key name (not the secret) from LIVEKIT_KEYS="<key>: <secret>".
key_name() {
  sed -n 's/^LIVEKIT_KEYS=\([A-Za-z0-9_-]*\): .*/\1/p' secrets.env | head -n1
}

check_secrets() {
  [ -f secrets.env ] || die "secrets.env missing (./configure.sh init-secrets)"
  mode=$(stat -c %a secrets.env)
  [ "$mode" = 600 ] || [ "$mode" = 400 ] || die "secrets.env must be mode 600 (is $mode)"
  for v in LIVEKIT_KEYS REDIS_PASSWORD EGRESS_CONFIG_BODY; do
    grep -qE "^$v=.+" secrets.env || die "secrets.env lacks $v"
  done
  [ -n "$(key_name)" ] || die "LIVEKIT_KEYS must look like '<key>: <secret>'"
  secret_len=$(sed -n 's/^LIVEKIT_KEYS=[A-Za-z0-9_-]*: \(.*\)$/\1/p' secrets.env | head -n1 | tr -d '\n' | wc -c)
  [ "$secret_len" -ge 32 ] || die "the LiveKit secret must be at least 32 characters"
}

rand() { openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | cut -c1-"$1"; }

cmd=${1:-}
case "$cmd" in
  init-secrets)
    load_settings
    [ ! -e secrets.env ] || die "secrets.env exists; refusing to overwrite (move it away first to rotate)"
    command -v openssl >/dev/null || die "openssl is required"
    umask 077
    key="API$(rand 12)"; secret=$(rand 48); redis=$(rand 40)
    {
      echo "# HRVO self-hosted LiveKit secrets (ADR 067). Mode 600. Never commit, print or paste."
      echo "LIVEKIT_KEYS=$key: $secret"
      echo "REDIS_PASSWORD=$redis"
      printf 'EGRESS_CONFIG_BODY={"api_key":"%s","api_secret":"%s","ws_url":"ws://127.0.0.1:%s","redis":{"address":"127.0.0.1:%s","password":"%s"},"health_port":9091,"log_level":"info"}\n' \
        "$key" "$secret" "$LIVEKIT_PORT" "$REDIS_PORT" "$redis"
    } > secrets.env
    chmod 600 secrets.env
    unset secret redis
    echo "secrets.env written (mode 600): LIVEKIT_KEYS, REDIS_PASSWORD, EGRESS_CONFIG_BODY. Key name: $key"
    ;;
  render)
    load_settings
    check_secrets
    mkdir -p generated
    if [ -n "$NODE_IP" ]; then node_ip_line="node_ip: $NODE_IP"; use_ext=false; else node_ip_line="# node_ip: discovered with STUN"; use_ext=true; fi
    if [ "$TURN_EXTERNAL_TLS" = false ]; then
      turn_cert="cert_file: $TURN_CERT_FILE
  key_file: $TURN_KEY_FILE"
    else
      turn_cert="# TLS terminated by Caddy"
    fi
    if [ "$TLS_ISSUER" = acme ]; then issuers="[{module: acme, email: \"$ACME_EMAIL\"}]"; else issuers="[{module: internal}]"; fi
    keyname=$(key_name)
    # awk, not sed: values are inserted literally (no regex or delimiter surprises).
    TURN_CERT_LINES=$turn_cert NODE_IP_LINE=$node_ip_line USE_EXTERNAL_IP=$use_ext TLS_ISSUERS=$issuers LIVEKIT_API_KEY_NAME=$keyname
    export LIVEKIT_DOMAIN TURN_DOMAIN WEBHOOK_URL LIVEKIT_PORT REDIS_PORT CADDY_TLS_PORT RTC_TCP_PORT RTC_PORT_RANGE_START \
      RTC_PORT_RANGE_END TURN_TLS_PORT TURN_UDP_PORT TURN_EXTERNAL_TLS TURN_CERT_LINES NODE_IP_LINE USE_EXTERNAL_IP TLS_ISSUERS \
      LIVEKIT_API_KEY_NAME ROOM_MAX_PARTICIPANTS LIMIT_NUM_TRACKS LIMIT_BYTES_PER_SEC
    render() {
      awk '
        {
          line = $0; out = ""
          while (match(line, /@[A-Z_]+@/)) {
            name = substr(line, RSTART + 1, RLENGTH - 2)
            if (!(name in ENVIRON)) { print "unknown placeholder @" name "@" > "/dev/stderr"; bad = 1 }
            out = out substr(line, 1, RSTART - 1) ENVIRON[name]
            line = substr(line, RSTART + RLENGTH)
          }
          print out line
        }
        END { if (bad) exit 1 }' "$1"
    }
    render livekit.yaml.tmpl > generated/livekit.yaml
    render caddy.yaml.tmpl > generated/caddy.yaml
    chmod 644 generated/livekit.yaml generated/caddy.yaml
    printf 'LIVEKIT_PORT=%s\nREDIS_PORT=%s\nCADDY_TLS_PORT=%s\n' "$LIVEKIT_PORT" "$REDIS_PORT" "$CADDY_TLS_PORT" > .env
    echo "rendered generated/livekit.yaml, generated/caddy.yaml and .env for $LIVEKIT_DOMAIN / $TURN_DOMAIN (webhook key $keyname)"
    ;;
  check)
    load_settings
    check_secrets
    echo "livekit.env and secrets.env look complete (key $(key_name))"
    ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
