#!/usr/bin/env bash
# Host firewall for the self-hosted LiveKit stack on the application's EC2 host (ADR 067).
#
# LiveKit, Caddy and their Redis use host networking (LiveKit's VM guidance), so their packets leave
# through the host's own output path, not a Docker bridge. ADR 047's guard (`inet hrvo_imds`) only
# filters bridged containers and the tester group, so without this table those containers could
# reach the EC2 instance metadata service and the instance role's KMS credentials.
#
# Everything lives in a table of its own, `inet hrvo_livekit`, replaced atomically; no other table
# is changed or flushed (never `flush ruleset`). Two chains:
#   output  drop every packet to the metadata service (169.254.169.254, fd00:ec2::254) from sockets
#           whose group is LIVEKIT_GID. docker-compose.yml runs every LiveKit container with that
#           group, and cap_drop ALL + no-new-privileges mean no process inside can change it.
#   input   the internal ports (plain TURN behind Caddy, signalling/Twirp, Redis) answer on the
#           loopback interface only, whatever address the process bound.
#
#   sudo hrvo-livekit-guard apply    validate the settings, install or replace the rules atomically
#   sudo hrvo-livekit-guard check    exit 0 only if settings and loaded rules agree (no Docker calls:
#                                    safe in docker.service's ExecStartPre)
#   sudo hrvo-livekit-guard verify   check, plus: every LiveKit container (running or stopped) is
#                                    configured with LIVEKIT_GID (asks Docker; run it after `up`)
#   sudo hrvo-livekit-guard remove   rollback; refused while a LiveKit container runs or the Docker
#                                    drop-in is still installed
#        hrvo-livekit-guard render   print the ruleset (validates the settings; no root needed)
#
# Settings: one mandatory file, /etc/default/hrvo-livekit-guard (HRVO_LIVEKIT_GUARD_SETTINGS), written
# by configure.sh as generated/hrvo-livekit-guard.default; the systemd unit and the Docker drop-in
# point at the same file. Exactly these lines (comments and blank lines allowed):
#   LIVEKIT_GID=64900
#   LIVEKIT_PRIVATE_TCP_PORTS="5349 7880 6389"
#   LIVEKIT_COMPOSE_ENV=/opt/hrvo-livekit/.env
# The group and ports must equal those of the rendered Compose project (LIVEKIT_COMPOSE_ENV), so a
# changed LIVEKIT_GID fails closed until the guard is re-applied with it. Environment variables of
# the same names are ignored. A missing, malformed, foreign-owned or writable-by-others file fails.
set -euo pipefail
TABLE='inet hrvo_livekit'
IMDS4=169.254.169.254
IMDS6=fd00:ec2::254
PROJECT=hrvo-livekit
SETTINGS="${HRVO_LIVEKIT_GUARD_SETTINGS:-/etc/default/hrvo-livekit-guard}"
DROPIN="${HRVO_LIVEKIT_GUARD_DROPIN:-/etc/systemd/system/docker.service.d/hrvo-livekit-guard.conf}"
DOCKER="${HRVO_LIVEKIT_GUARD_DOCKER:-docker}"

die() { echo "hrvo-livekit-guard: $*" >&2; exit 1; }

valid_gid() { [[ "$1" =~ ^[1-9][0-9]{3,4}$ ]] && (( $1 >= 1000 && $1 <= 65533 )); }
# Sorted, unique, ", "-separated (as nft prints an anonymous set, so `check` compares lines exactly).
port_set_of() {
  local p
  for p in $1; do [[ "$p" =~ ^[1-9][0-9]{0,4}$ ]] && (( p <= 65535 )) || return 1; done
  printf '%s\n' $1 | sort -n -u | paste -sd, - | sed 's/,/, /g'
}

# --- settings: mandatory, strict, and the same as the rendered Compose project -------------------
load_settings() {
  [[ -e "$SETTINGS" ]] || die "settings file $SETTINGS is missing (install generated/hrvo-livekit-guard.default there): refusing to guess"
  [[ -f "$SETTINGS" && ! -L "$SETTINGS" ]] || die "$SETTINGS must be a regular file (not a link)"
  local owner mode
  read -r owner mode < <(stat -c '%u %a' "$SETTINGS")
  if (( EUID == 0 )); then
    [[ "$owner" == 0 ]] || die "$SETTINGS must be owned by root"
  fi
  (( (8#$mode & 8#022) == 0 )) || die "$SETTINGS must not be writable by group or others (mode $mode)"

  gid="" ports="" compose_env=""
  local line n=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
    if [[ "$line" =~ ^LIVEKIT_GID=([0-9]+)$ ]]; then
      [[ -z "$gid" ]] || die "$SETTINGS:$n: LIVEKIT_GID set twice"; gid="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ ^LIVEKIT_PRIVATE_TCP_PORTS=\"([0-9\ ]+)\"$ ]]; then
      [[ -z "$ports" ]] || die "$SETTINGS:$n: LIVEKIT_PRIVATE_TCP_PORTS set twice"; ports="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ ^LIVEKIT_COMPOSE_ENV=(/[A-Za-z0-9._/-]+)$ ]]; then
      [[ -z "$compose_env" ]] || die "$SETTINGS:$n: LIVEKIT_COMPOSE_ENV set twice"; compose_env="${BASH_REMATCH[1]}"
    else
      die "$SETTINGS:$n: not an allowed setting line (only LIVEKIT_GID, LIVEKIT_PRIVATE_TCP_PORTS, LIVEKIT_COMPOSE_ENV)"
    fi
  done < "$SETTINGS"
  [[ -n "$gid" ]] || die "$SETTINGS: LIVEKIT_GID is missing"
  [[ -n "$ports" ]] || die "$SETTINGS: LIVEKIT_PRIVATE_TCP_PORTS is missing"
  [[ -n "$compose_env" ]] || die "$SETTINGS: LIVEKIT_COMPOSE_ENV is missing"
  valid_gid "$gid" || die "$SETTINGS: LIVEKIT_GID must be a number from 1000 to 65533"
  port_set="$(port_set_of "$ports")" && [[ -n "$port_set" ]] || die "$SETTINGS: LIVEKIT_PRIVATE_TCP_PORTS must be port numbers separated by spaces"

  # The Compose project the containers are created from must use the same group and ports.
  [[ -f "$compose_env" ]] || die "$compose_env (LIVEKIT_COMPOSE_ENV) is missing: run ./configure.sh render"
  env_value() { sed -n "s/^$1=\\([0-9]*\\)\$/\\1/p" "$compose_env" | tail -n1; }
  local c_gid c_ports
  c_gid="$(env_value LIVEKIT_GID)"
  [[ -n "$c_gid" ]] || die "$compose_env has no LIVEKIT_GID: run ./configure.sh render"
  [[ "$c_gid" == "$gid" ]] || die "LIVEKIT_GID differs: $SETTINGS has $gid, the Compose project ($compose_env) has $c_gid. Install the newly rendered settings, apply, then recreate the LiveKit containers"
  c_ports="$(port_set_of "$(env_value TURN_TLS_PORT) $(env_value LIVEKIT_PORT) $(env_value REDIS_PORT)")" \
    || die "$compose_env lacks TURN_TLS_PORT/LIVEKIT_PORT/REDIS_PORT: run ./configure.sh render"
  [[ "$c_ports" == "$port_set" ]] || die "private ports differ: $SETTINGS has { $port_set }, the Compose project has { $c_ports }"
}

render() {
  cat <<NFT
table $TABLE {
	chain input {
		type filter hook input priority filter - 10; policy accept;
		iifname != "lo" tcp dport { $port_set } counter drop
	}
	chain output {
		type filter hook output priority filter - 10; policy accept;
		meta skgid $gid ip daddr $IMDS4 counter drop
		meta skgid $gid ip6 daddr $IMDS6 counter drop
	}
}
NFT
}

check_table() {
  local live chain want
  live="$(nft -s list table $TABLE 2>/dev/null)" || die "table $TABLE is not loaded: LiveKit containers could reach the instance metadata service"
  chain_lines() { awk -v c="chain $1 {" '$0 ~ c { f = 1; next } f && /^[[:space:]]*\}/ { f = 0 } f' <<<"$live" | sed 's/^[[:space:]]*//'; }
  chain="$(chain_lines input)"
  for want in \
    "type filter hook input priority filter - 10; policy accept;" \
    "iifname != \"lo\" tcp dport { $port_set } counter drop"; do
    grep -qxF -- "$want" <<<"$chain" || die "table $TABLE is not as configured (input, missing: $want); run: hrvo-livekit-guard apply"
  done
  chain="$(chain_lines output)"
  for want in \
    "type filter hook output priority filter - 10; policy accept;" \
    "meta skgid $gid ip daddr $IMDS4 counter drop" \
    "meta skgid $gid ip6 daddr $IMDS6 counter drop"; do
    grep -qxF -- "$want" <<<"$chain" || die "table $TABLE is not as configured (output, missing: $want; a table for another group?); run: hrvo-livekit-guard apply"
  done
  # ADR 047's guard must stay loaded too: this table adds to it, it never replaces it.
  if ! nft list table inet hrvo_imds >/dev/null 2>&1; then
    echo "hrvo-livekit-guard: warning: table inet hrvo_imds (ADR 047) is not loaded" >&2
  fi
}

# Docker is asked only by `verify` and `remove`, never by `check`/`apply`: those run while
# docker.service is starting, where a CLI call could wait on socket activation.
docker_up() { command -v "$DOCKER" >/dev/null 2>&1 && timeout 15 "$DOCKER" info >/dev/null 2>&1; }

verify_containers() {
  docker_up || die "Docker is not reachable: cannot verify the LiveKit containers"
  local list id name user found=0
  list="$(timeout 15 "$DOCKER" ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.ID}} {{.Names}}')" \
    || die "cannot list the LiveKit containers"
  while read -r id name; do
    [[ -n "$id" ]] || continue
    found=1
    user="$(timeout 15 "$DOCKER" inspect --format '{{.Config.User}}' "$id")" || die "cannot inspect container $name"
    [[ "$user" =~ :([0-9]+)$ ]] || die "container $name runs without an explicit group (user '$user'): it is not covered by the guard"
    [[ "${BASH_REMATCH[1]}" == "$gid" ]] || die "container $name runs with group ${BASH_REMATCH[1]}, the guard protects group $gid: recreate it (docker compose up -d --force-recreate)"
  done <<<"$list"
  (( found )) || echo "hrvo-livekit-guard: note: no LiveKit containers exist yet"
}

remove() {
  [[ ! -e "$DROPIN" ]] || die "the Docker drop-in $DROPIN is still installed (Docker would refuse to start without this table): remove it and run systemctl daemon-reload first"
  if docker_up; then
    local running
    running="$(timeout 15 "$DOCKER" ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}')" \
      || die "cannot list the running LiveKit containers"
    [[ -z "$running" ]] || die "LiveKit containers are running ($(echo $running)): stop them first (docker compose down in /opt/hrvo-livekit)"
  elif command -v "$DOCKER" >/dev/null 2>&1 && systemctl is-active --quiet docker 2>/dev/null; then
    die "Docker is active but not answering: cannot confirm that no LiveKit container runs"
  fi
  nft list table $TABLE >/dev/null 2>&1 || { echo "hrvo-livekit-guard: table $TABLE is not loaded (nothing to remove)"; return 0; }
  nft delete table $TABLE
  echo "hrvo-livekit-guard: removed table $TABLE (other tables untouched)"
}

cmd="${1:-}"
case "$cmd" in
  render) load_settings; render ;;
  apply)
    load_settings
    # One transaction (create if missing, delete, add), so there is no moment without the rules.
    { echo "table $TABLE"; echo "delete table $TABLE"; render; } | nft -f -
    check_table
    echo "hrvo-livekit-guard: ok (group $gid cannot reach $IMDS4/$IMDS6; tcp $port_set loopback only)" ;;
  check)
    load_settings; check_table
    echo "hrvo-livekit-guard: ok (group $gid cannot reach $IMDS4/$IMDS6; tcp $port_set loopback only)" ;;
  verify)
    load_settings; check_table; verify_containers
    echo "hrvo-livekit-guard: ok (rules loaded; every LiveKit container runs with group $gid)" ;;
  remove) remove ;;
  *) echo "usage: hrvo-livekit-guard apply|check|verify|remove|render" >&2; exit 2 ;;
esac
