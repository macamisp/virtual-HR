#!/usr/bin/env bash
# Keeps the EC2 instance metadata service (IMDS), which hands out the instance role's temporary
# credentials (KMS), away from every container except the HRVO API (ADR 047).
#
# The rules live in their own nftables table, `inet hrvo_imds`, which Docker never creates, flushes
# or rewrites (with either of its firewall backends), so they survive Docker restarts. systemd loads
# them before docker.service at boot, and docker.service refuses to start without them
# (hrvo-imds-guard.service, docker-hrvo-imds-guard.conf).
#
# Identity is the network interface, not the source address: only packets the kernel received on
# the API's own bridge (`hrvo-api`, a network nothing else joins) from its subnet may reach
# 169.254.169.254:80. A container on another bridge cannot pass, even if it forges that address.
# The IPv6 endpoint (fd00:ec2::254) is closed to all containers. Members of the SSH tunnel group
# (testers) cannot reach IMDS from the host either.
#
#   sudo hrvo-imds-guard apply    install or replace the rules atomically (idempotent)
#   sudo hrvo-imds-guard check    exit 0 only if the rules are loaded as configured
#   sudo hrvo-imds-guard remove   rollback; refused while an instance profile is attached
#        hrvo-imds-guard render   print the ruleset (no root needed; used by the tests)
#
# Settings (environment, or /etc/default/hrvo-imds-guard through the systemd unit):
#   API_BRIDGE=hrvo-api           bridge name set by docker-compose.staging.yml (api_egress)
#   API_SUBNET=172.30.1.0/29      that network's subnet
#   TUNNEL_GROUP=hrvo-tunnel      primary group of the tester accounts; empty = no host rule
set -euo pipefail

TABLE='inet hrvo_imds'
IMDS4=169.254.169.254
IMDS6=fd00:ec2::254
api_bridge="${API_BRIDGE:-hrvo-api}"
api_subnet="${API_SUBNET:-172.30.1.0/29}"
tunnel_group="${TUNNEL_GROUP-hrvo-tunnel}"

die() { echo "hrvo-imds-guard: $*" >&2; exit 1; }

# Both values end up inside nft syntax, so accept only their plain forms.
[[ "$api_bridge" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || die "API_BRIDGE must be an interface name (1-15 of A-Z a-z 0-9 _ . -)"
[[ "$api_subnet" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]] || die "API_SUBNET must be an IPv4 CIDR such as 172.30.1.0/29"
[[ -z "$tunnel_group" || "$tunnel_group" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "TUNNEL_GROUP must be a group name"

tunnel_gid() {
  [[ -n "$tunnel_group" ]] || return 0
  getent group "$tunnel_group" | cut -d: -f3 || true
}

render() {
  local gid
  gid="$(tunnel_gid)"
  cat <<NFT
table $TABLE {
	chain forward {
		type filter hook forward priority filter - 10; policy accept;
		iifname "$api_bridge" ip saddr $api_subnet ip daddr $IMDS4 tcp dport 80 accept
		ip daddr $IMDS4 counter drop
		ip6 daddr $IMDS6 counter drop
	}
	chain output {
		type filter hook output priority filter - 10; policy accept;
NFT
  if [[ -n "$gid" ]]; then
    printf '\t\tmeta skgid %s ip daddr %s counter drop\n' "$gid" "$IMDS4"
    printf '\t\tmeta skgid %s ip6 daddr %s counter drop\n' "$gid" "$IMDS6"
  fi
  printf '\t}\n}\n'
}

apply() {
  # One transaction (create if missing, delete, add), so there is no moment without the rules.
  { echo "table $TABLE"; echo "delete table $TABLE"; render; } | nft -f -
  if [[ -n "$tunnel_group" && -z "$(tunnel_gid)" ]]; then
    echo "hrvo-imds-guard: group $tunnel_group does not exist yet; no host rule for testers" >&2
  fi
  check
}

check() {
  local live forward want allow drop
  live="$(nft -s list table $TABLE 2>/dev/null)" || die "table $TABLE is not loaded: containers could reach the instance metadata service"
  # Whole lines of the forward chain only (the output chain's rules contain the same words).
  forward="$(awk '/chain forward \{/ { f = 1; next } f && /^[[:space:]]*\}/ { f = 0 } f' <<<"$live" | sed 's/^[[:space:]]*//')"
  for want in \
    "type filter hook forward priority filter - 10; policy accept;" \
    "iifname \"$api_bridge\" ip saddr $api_subnet ip daddr $IMDS4 tcp dport 80 accept" \
    "ip daddr $IMDS4 counter drop" \
    "ip6 daddr $IMDS6 counter drop"; do
    grep -qxF -- "$want" <<<"$forward" || die "table $TABLE is not as configured (missing: $want); run: hrvo-imds-guard apply"
  done
  allow="$(grep -nxF "iifname \"$api_bridge\" ip saddr $api_subnet ip daddr $IMDS4 tcp dport 80 accept" <<<"$forward" | head -1 | cut -d: -f1)"
  drop="$(grep -nxF "ip daddr $IMDS4 counter drop" <<<"$forward" | head -1 | cut -d: -f1)"
  (( allow < drop )) || die "table $TABLE drops before the API's allow rule; run: hrvo-imds-guard apply"
  echo "hrvo-imds-guard: ok (only $api_bridge $api_subnet may reach $IMDS4:80; $IMDS6 closed)"
}

role_attached() {
  # Asks IMDS whether an instance profile is attached. Prints nothing from IMDS: no token, no body.
  local token code
  token="$(curl -fsS -m 3 -X PUT "http://$IMDS4/latest/api/token" -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null)" || return 1
  code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' -H "X-aws-ec2-metadata-token: $token" "http://$IMDS4/latest/meta-data/iam/info")"
  [[ "$code" == 200 ]]
}

remove() {
  if [[ "${HRVO_IMDS_GUARD_FORCE:-}" != 1 ]] && role_attached; then
    die "an IAM instance profile is attached; detach it first (docs/runbooks/staging-ec2.md, rollback), or set HRVO_IMDS_GUARD_FORCE=1"
  fi
  nft delete table $TABLE 2>/dev/null || true
  echo "hrvo-imds-guard: table $TABLE removed; containers can reach the instance metadata service again"
}

case "${1:-apply}" in
  apply) apply ;;
  check) check ;;
  remove) remove ;;
  render) render ;;
  *) die "usage: hrvo-imds-guard [apply|check|remove|render]" ;;
esac
