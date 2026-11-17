#!/usr/bin/env bash
# Functional test of infra/livekit-selfhost/livekit-guard.sh (ADR 067) together with ADR 047's
# imds-guard.sh, without root, containers or this computer's firewall: everything runs in a new user
# + network namespace that plays the EC2 host. Inside it:
#   imds   a fake metadata service at 169.254.169.254 and fd00:ec2::254, reached through "eth0"
#   inet   an Internet client on "ext0" (the security group is not modelled: the host firewall is)
#   api    the HRVO API container on its own bridge hrvo-api (ADR 047 lets only it reach IMDS)
#   web    an ordinary container on bridge hrvo-edge
#   host processes run as LiveKit's containers do with host networking: uid 0 (caddy, livekit) or
#   999 (redis), group LIVEKIT_GID, via setpriv
# plus listeners on every LiveKit port and two unrelated nftables tables that must stay untouched.
#
#   bash infra/livekit-selfhost/test/livekit-guard-netns.sh      (npm run test:livekit-guard)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"

if [[ "${HRVO_IN_NS:-}" != 1 ]]; then
  for tool in nft unshare nsenter setpriv python3 curl; do
    command -v "$tool" >/dev/null || { echo "SKIP: $tool is not installed"; exit 0; }
  done
  # The LiveKit group (64900) and redis' uid (999) must exist inside the namespace: map this user's
  # subordinate IDs too (--map-auto), or skip.
  unshare --map-root-user --map-auto true 2>/dev/null || { echo "SKIP: no subordinate IDs for this user (/etc/subuid, /etc/subgid)"; exit 0; }
  exec unshare --map-root-user --map-auto --net --mount --propagation private env HRVO_IN_NS=1 bash "$0" "$@"
fi

work="$(mktemp -d)"
cp "$repo/infra/livekit-selfhost/livekit-guard.sh" "$repo/infra/staging-ec2/imds-guard.sh" "$repo/infra/staging-ec2/test/fake-imds.py" "$work/"
guard="$work/livekit-guard.sh"
imds_guard="$work/imds-guard.sh"
mount -t tmpfs tmpfs /run && mkdir -p /run/netns
cleanup() { kill "${imds_pid:-}" "${listen_pid:-}" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT

GID=64900
export LIVEKIT_GID=$GID LIVEKIT_PRIVATE_TCP_PORTS="5349 7880 6389" TUNNEL_GROUP=""
fails=0
pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; fails=$((fails + 1)); }
in_ns() { local ns=$1; shift; nsenter --net="/run/netns/$ns" "$@"; }
http() { local ns=$1; shift; in_ns "$ns" curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$@" || true; }
as() { # as <uid> <gid> <command...>: a host process with that identity (like a host-network container)
  local uid=$1 gid=$2; shift 2
  setpriv --reuid "$uid" --regid "$gid" --clear-groups "$@"
}
as_http() { local uid=$1 gid=$2; shift 2; as "$uid" "$gid" curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$@" || true; }
expect() { if [[ "$3" == "$1" ]]; then pass "$2"; else fail "$2 (expected $1, got $3)"; fi; }
tcp_from_inet() { in_ns inet python3 -I -c 'import socket,sys
try:
    socket.create_connection(("198.51.100.1", int(sys.argv[1])), 2).close(); print("open")
except OSError: print("blocked")' "$1"; }
tcp_local() { python3 -I -c 'import socket,sys
try:
    socket.create_connection(("127.0.0.1", int(sys.argv[1])), 2).close(); print("open")
except OSError: print("blocked")' "$1"; }
udp_from_inet() { in_ns inet python3 -I -c 'import socket,sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2)
s.sendto(b"ping", ("198.51.100.1", int(sys.argv[1])))
try:
    s.recvfrom(64); print("answered")
except OSError: print("blocked")' "$1"; }

# --- the fake EC2 host -------------------------------------------------------------------------
ip link set lo up
echo 1 > /proc/sys/net/ipv4/ip_forward
echo 1 > /proc/sys/net/ipv6/conf/all/forwarding

ip netns add imds
ip link add eth0 type veth peer name eth0 netns imds
ip addr add 10.99.0.1/24 dev eth0 && ip -6 addr add fd99::1/64 dev eth0 nodad && ip link set eth0 up
in_ns imds ip link set lo up
in_ns imds ip addr add 169.254.169.254/32 dev lo
in_ns imds ip -6 addr add fd00:ec2::254/128 dev lo
in_ns imds ip addr add 10.99.0.2/24 dev eth0
in_ns imds ip -6 addr add fd99::2/64 dev eth0 nodad
in_ns imds ip link set eth0 up
in_ns imds ip route add default via 10.99.0.1
in_ns imds ip -6 route add default via fd99::1
ip route add 169.254.169.254/32 via 10.99.0.2
ip -6 route add fd00:ec2::254/128 via fd99::2

ip netns add inet
ip link add ext0 type veth peer name ext0 netns inet
ip addr add 198.51.100.1/24 dev ext0 && ip link set ext0 up
in_ns inet ip link set lo up
in_ns inet ip addr add 198.51.100.2/24 dev ext0 && in_ns inet ip link set ext0 up

bridge() { ip link add "$1" type bridge && ip addr add "$2" dev "$1" && ip link set "$1" up; }
bridge hrvo-api 172.30.1.1/29
bridge hrvo-edge 172.30.0.1/24
n=0
plug() { # plug <ns> <bridge> <ifname> <cidr> [gateway]
  local ns=$1 br=$2 ifname=$3 cidr=$4 gw=${5:-}
  [[ -e "/run/netns/$ns" ]] || { ip netns add "$ns"; in_ns "$ns" ip link set lo up; }
  n=$((n + 1))
  ip link add "vh$n" type veth peer name "$ifname" netns "$ns"
  ip link set "vh$n" master "$br" up
  in_ns "$ns" ip addr add "$cidr" dev "$ifname"
  in_ns "$ns" ip link set "$ifname" up
  [[ -z "$gw" ]] || in_ns "$ns" ip route add default via "$gw"
}
plug api hrvo-api eth0 172.30.1.2/29 172.30.1.1
plug web hrvo-edge eth0 172.30.0.20/24 172.30.0.1

nsenter --net=/run/netns/imds python3 -I "$work/fake-imds.py" "$work/role-attached" &
imds_pid=$!
# LiveKit's ports on the host, bound to every address (as the plain TURN listener is): TCP accept,
# UDP echo.
python3 -I - <<'PY' &
import selectors, socket
sel = selectors.DefaultSelector()
for port in (443, 80, 7881, 5349, 7880, 6389):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("0.0.0.0", port)); s.listen(); sel.register(s, selectors.EVENT_READ, "tcp")
u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); u.bind(("0.0.0.0", 3478)); sel.register(u, selectors.EVENT_READ, "udp")
while True:
    for key, _ in sel.select():
        if key.data == "tcp":
            c, _ = key.fileobj.accept(); c.close()
        else:
            data, addr = key.fileobj.recvfrom(64); key.fileobj.sendto(data, addr)
PY
listen_pid=$!
for _ in $(seq 50); do [[ "$(http imds http://10.99.0.2/)" == 200 ]] && break; sleep 0.1; done
for _ in $(seq 50); do [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 'http://[fd99::2]/' || true)" == 200 ]] && break; sleep 0.1; done
for _ in $(seq 50); do [[ "$(tcp_local 7881)" == open ]] && break; sleep 0.1; done

IMDS=http://169.254.169.254/latest/meta-data/
IMDS6='http://[fd00:ec2::254]/latest/meta-data/'
TOKEN=(-X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)

# Unrelated rules that must survive: something like Docker's, and an operator's own table.
nft -f - <<'NFT'
table ip dockerlike {
	chain forward { type filter hook forward priority -100; policy accept; counter accept; }
}
table inet operator {
	chain input { type filter hook input priority 0; policy accept; tcp dport 22 counter accept; }
}
NFT
snapshot() { nft -s list table ip dockerlike; nft -s list table inet operator; nft -s list table inet hrvo_imds 2>/dev/null || true; }

echo "# without the guards (proves the test can see both problems)"
expect 200 "a LiveKit-group host process (caddy/livekit: uid 0) reaches IMDS" "$(as_http 0 $GID "$IMDS")"
expect open "the Internet reaches plain TURN 5349" "$(tcp_from_inet 5349)"

echo "# ADR 047 guard applied first (as on the host), then the LiveKit guard"
bash "$imds_guard" apply >/dev/null
expect 200 "with only ADR 047's guard, a host-network LiveKit process still reaches IMDS (the gap P1 closes)" "$(as_http 0 $GID "$IMDS")"
before="$(snapshot)"
bash "$guard" apply >/dev/null

echo "# P1: every LiveKit container identity is cut off from the metadata service"
expect 000 "caddy/livekit (uid 0, group $GID): IMDS IPv4 blocked" "$(as_http 0 $GID "$IMDS")"
expect 000 "caddy/livekit (uid 0, group $GID): IMDSv2 token request blocked" "$(as_http 0 $GID "${TOKEN[@]}")"
expect 000 "caddy/livekit (uid 0, group $GID): IMDS IPv6 blocked" "$(as_http 0 $GID "$IMDS6")"
expect 000 "redis (uid 999, group $GID): IMDS IPv4 blocked" "$(as_http 999 $GID "$IMDS")"
expect 000 "redis (uid 999, group $GID): IMDS IPv6 blocked" "$(as_http 999 $GID "$IMDS6")"
expect 000 "a LiveKit-group process on another port of IMDS is blocked" "$(as_http 0 $GID http://169.254.169.254:8080/)"
expect 200 "LiveKit-group egress elsewhere is unaffected (webhooks, ACME)" "$(as_http 0 $GID http://10.99.0.2/)"

echo "# ADR 047 protections unchanged"
expect 200 "api (its own bridge) still reaches IMDS" "$(http api "$IMDS")"
expect 200 "api still gets an IMDSv2 token" "$(http api "${TOKEN[@]}")"
expect 000 "web (edge bridge) still blocked" "$(http web "$IMDS")"
expect 200 "host root in another group (SSM agent, admin) still reaches IMDS" "$(as_http 0 0 "$IMDS")"
expect 200 "host process in group 1000 is unaffected" "$(as_http 1000 1000 "$IMDS")"
bash "$imds_guard" check >/dev/null && pass "hrvo-imds-guard check still passes" || fail "hrvo-imds-guard check still passes"

echo "# P3: inbound"
expect blocked "Internet -> plain TURN 5349 blocked" "$(tcp_from_inet 5349)"
expect blocked "Internet -> signalling/Twirp 7880 blocked" "$(tcp_from_inet 7880)"
expect blocked "Internet -> Redis 6389 blocked" "$(tcp_from_inet 6389)"
expect open "loopback -> 5349 open (Caddy's TURN/TLS route)" "$(tcp_local 5349)"
expect open "loopback -> 7880 open (Caddy's signalling route)" "$(tcp_local 7880)"
expect open "Internet -> 443 open (signalling + TURN/TLS via Caddy)" "$(tcp_from_inet 443)"
expect open "Internet -> 80 open (ACME HTTP-01)" "$(tcp_from_inet 80)"
expect open "Internet -> ICE/TCP 7881 open" "$(tcp_from_inet 7881)"
expect answered "Internet -> TURN/UDP 3478 answered" "$(udp_from_inet 3478)"

echo "# existing nftables rules preserved"
expect "$before" "other tables are byte-identical after apply" "$(snapshot)"
bash "$guard" apply >/dev/null
expect "$before" "other tables are byte-identical after a second apply" "$(snapshot)"
rules() { nft -a list table inet hrvo_livekit | grep -c 'handle'; }
r1="$(rules)"; bash "$guard" apply >/dev/null
expect "$r1" "applying again leaves the same number of rules (idempotent)" "$(rules)"
# (The copy in $work: /run, and so the checkout under /run/media, is hidden in this namespace.)
if [[ ! -s "$guard" ]]; then fail "the guard script is readable"
elif grep -vE '^[[:space:]]*#' "$guard" | grep -qE 'flush[[:space:]]+(ruleset|table)'; then fail "the guard never flushes the ruleset or a table"
else pass "the guard never flushes the ruleset or a table"; fi

echo "# checked and repairable"
bash "$guard" check >/dev/null && pass "check passes when loaded" || fail "check passes when loaded"
h="$(nft -a list chain inet hrvo_livekit output | grep -F 'ip daddr 169.254.169.254' | grep -o 'handle [0-9]*' | cut -d' ' -f2)"
nft delete rule inet hrvo_livekit output handle "$h"
bash "$guard" check >/dev/null 2>&1 && fail "check fails when the IMDS rule is missing" || pass "check fails when the IMDS rule is missing"
bash "$guard" apply >/dev/null && pass "apply repairs a tampered table" || fail "apply repairs a tampered table"
expect 000 "after repair the LiveKit group is blocked again" "$(as_http 0 $GID "$IMDS")"
h="$(nft -a list chain inet hrvo_livekit input | grep -F 'dport' | grep -o 'handle [0-9]*' | cut -d' ' -f2)"
nft delete rule inet hrvo_livekit input handle "$h"
bash "$guard" check >/dev/null 2>&1 && fail "check fails when the inbound rule is missing" || pass "check fails when the inbound rule is missing"
bash "$guard" apply >/dev/null
LIVEKIT_GID='0; flush ruleset' bash "$guard" render >/dev/null 2>&1 && fail "rejects an unsafe LIVEKIT_GID" || pass "rejects an unsafe LIVEKIT_GID"
LIVEKIT_GID=0 bash "$guard" render >/dev/null 2>&1 && fail "rejects group 0 (would cut root off IMDS)" || pass "rejects group 0 (would cut root off IMDS)"
LIVEKIT_PRIVATE_TCP_PORTS='5349 } accept; {' bash "$guard" render >/dev/null 2>&1 && fail "rejects unsafe port lists" || pass "rejects unsafe port lists"

echo "# rollback"
bash "$guard" remove >/dev/null && pass "remove succeeds" || fail "remove succeeds"
bash "$guard" check >/dev/null 2>&1 && fail "check fails after remove" || pass "check fails after remove"
expect "$before" "other tables are byte-identical after remove" "$(snapshot)"
expect 200 "after remove the LiveKit group reaches IMDS again (the table was the cause)" "$(as_http 0 $GID "$IMDS")"
expect open "after remove the Internet reaches 5349 again (the table was the cause)" "$(tcp_from_inet 5349)"
expect 000 "after remove ADR 047's guard still blocks web" "$(http web "$IMDS")"

echo
if (( fails )); then echo "livekit-guard: $fails check(s) FAILED"; exit 1; fi
echo "livekit-guard: all checks passed"
