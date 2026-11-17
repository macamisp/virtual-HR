#!/usr/bin/env bash
# Host firewall for the self-hosted LiveKit stack on the application's EC2 host (ADR 067).
#
# LiveKit, Caddy and their Redis use host networking (LiveKit's VM guidance), so their packets leave
# through the host's own output path, not a Docker bridge. ADR 047's guard (`inet hrvo_imds`) only
# filters bridged containers and the tester group, so without this table those containers could
# reach the EC2 instance metadata service and the instance role's KMS credentials.
#
# Everything lives in a table of its own, `inet hrvo_livekit`, replaced atomically; no other table
# is read, changed or flushed (never `flush ruleset`). Two chains:
#   output  drop every packet to the metadata service (169.254.169.254, fd00:ec2::254) from sockets
#           whose group is LIVEKIT_GID. docker-compose.yml runs every LiveKit container with that
#           group, and cap_drop ALL + no-new-privileges mean no process inside can change it.
#   input   the internal ports (plain TURN behind Caddy, signalling/Twirp, Redis) answer on the
#           loopback interface only, whatever address the process bound.
#
#   sudo hrvo-livekit-guard apply    install or replace the rules atomically (idempotent)
#   sudo hrvo-livekit-guard check    exit 0 only if the rules are loaded as configured
#   sudo hrvo-livekit-guard remove   rollback (stop the LiveKit stack first: docker compose down)
#        hrvo-livekit-guard render   print the ruleset (no root needed; used by the tests)
#
# Settings (environment, or /etc/default/hrvo-livekit-guard through the systemd unit):
#   LIVEKIT_GID=64900                       the group every LiveKit container runs with
#   LIVEKIT_PRIVATE_TCP_PORTS="5349 7880 6389"  TURN_TLS_PORT, LIVEKIT_PORT, REDIS_PORT of livekit.env
set -euo pipefail
TABLE='inet hrvo_livekit'
IMDS4=169.254.169.254
IMDS6=fd00:ec2::254
gid="${LIVEKIT_GID:-64900}"
ports="${LIVEKIT_PRIVATE_TCP_PORTS:-5349 7880 6389}"

die() { echo "hrvo-livekit-guard: $*" >&2; exit 1; }
# Both values end up inside nft syntax, so accept only their plain forms.
[[ "$gid" =~ ^[1-9][0-9]{2,5}$ ]] && (( gid >= 1000 && gid <= 65533 )) || die "LIVEKIT_GID must be a number from 1000 to 65533"
read -r -a port_list <<<"$ports"
(( ${#port_list[@]} > 0 )) || die "LIVEKIT_PRIVATE_TCP_PORTS is empty"
for p in "${port_list[@]}"; do
  [[ "$p" =~ ^[1-9][0-9]{0,4}$ ]] && (( p <= 65535 )) || die "LIVEKIT_PRIVATE_TCP_PORTS must be port numbers separated by spaces"
done
# Sorted and unique, as nft prints an anonymous set, so `check` can compare lines exactly.
port_set="$(printf '%s\n' "${port_list[@]}" | sort -n -u | paste -sd, - | sed 's/,/, /g')"

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

apply() {
  # One transaction (create if missing, delete, add), so there is no moment without the rules.
  { echo "table $TABLE"; echo "delete table $TABLE"; render; } | nft -f -
  check
}

check() {
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
    grep -qxF -- "$want" <<<"$chain" || die "table $TABLE is not as configured (output, missing: $want); run: hrvo-livekit-guard apply"
  done
  # ADR 047's guard must stay loaded too: this table adds to it, it never replaces it.
  if ! nft list table inet hrvo_imds >/dev/null 2>&1; then
    echo "hrvo-livekit-guard: warning: table inet hrvo_imds (ADR 047) is not loaded" >&2
  fi
  echo "hrvo-livekit-guard: ok (group $gid cannot reach $IMDS4/$IMDS6; tcp $port_set loopback only)"
}

remove() {
  nft list table $TABLE >/dev/null 2>&1 || { echo "hrvo-livekit-guard: table $TABLE is not loaded (nothing to remove)"; return 0; }
  nft delete table $TABLE
  echo "hrvo-livekit-guard: removed table $TABLE (other tables untouched)"
}

case "${1:-}" in
  render) render ;;
  apply) apply ;;
  check) check ;;
  remove) remove ;;
  *) echo "usage: hrvo-livekit-guard apply|check|remove|render" >&2; exit 2 ;;
esac
