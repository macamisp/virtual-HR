#!/usr/bin/env bash
# Functional test of infra/staging-ec2/imds-guard.sh (ADR 047), without root and without touching
# this computer's firewall: everything runs in a new user + network namespace that plays the EC2
# host. Inside it:
#   imds   a fake metadata service at 169.254.169.254 and fd00:ec2::254, reached through "eth0"
#   api    on bridge hrvo-api (its default route) and on hrvo-edge, like the compose API container
#   web    on hrvo-edge only, like web, proxy, storage and ClamAV
#   spoof  on hrvo-edge, forging the API's addresses (a container with NET_ADMIN)
#   build  on docker0, like `docker run` and `docker build` steps
#   pg     on an internal bridge without a default route, like PostgreSQL and Redis
# Needs nft, unshare (util-linux), nsenter, setpriv, python3 and curl. Prints only pass/fail lines.
#
#   bash infra/staging-ec2/test/imds-guard-netns.sh      (npm run test:imds-guard)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
guard="$here/../imds-guard.sh"

if [[ "${HRVO_IN_NS:-}" != 1 ]]; then
  for tool in nft unshare nsenter setpriv python3 curl; do
    command -v "$tool" >/dev/null || { echo "SKIP: $tool is not installed"; exit 0; }
  done
  # --map-auto also maps this user's subordinate IDs, so the tester-group rule can be tested.
  map=(--map-root-user --map-auto)
  unshare "${map[@]}" true 2>/dev/null || map=(--map-root-user)
  exec unshare "${map[@]}" --net --mount --propagation private env HRVO_IN_NS=1 bash "$0" "$@"
fi

# `ip netns` keeps namespaces under /run/netns, so /run gets a private tmpfs. That hides anything
# below /run (a checkout under /run/media, for instance), so copy what the test runs first.
work="$(mktemp -d)"
cp "$guard" "$here/fake-imds.py" "$work/"
guard="$work/imds-guard.sh"
mount -t tmpfs tmpfs /run && mkdir -p /run/netns
cleanup() { kill "${imds_pid:-}" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT

fails=0
pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; fails=$((fails + 1)); }
in_ns() { local ns=$1; shift; nsenter --net="/run/netns/$ns" "$@"; }
# HTTP status from a namespace, or 000 when nothing answers within 2 s. Never prints a body.
http() { local ns=$1; shift; in_ns "$ns" curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$@" || true; }
host_http() { curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$@" || true; }
expect() { # expect <code> <description> <actual>
  if [[ "$3" == "$1" ]]; then pass "$2"; else fail "$2 (expected $1, got $3)"; fi
}
reach() { [[ "$1" == 000 ]] && echo blocked || echo reachable; }

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

bridge() { ip link add "$1" type bridge && ip addr add "$2" dev "$1" && ip link set "$1" up; }
bridge hrvo-api 172.30.1.1/29
bridge hrvo-edge 172.30.0.1/24 && ip -6 addr add fd30::1/64 dev hrvo-edge nodad
bridge docker0 172.17.0.1/16
bridge hrvo-data 172.30.2.1/24

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
plug api hrvo-edge eth1 172.30.0.10/24
plug web hrvo-edge eth0 172.30.0.20/24 172.30.0.1
in_ns web ip -6 addr add fd30::20/64 dev eth0 nodad
in_ns web ip -6 route add default via fd30::1
plug spoof hrvo-edge eth0 172.30.0.30/24 172.30.0.1
plug build docker0 eth0 172.17.0.2/16 172.17.0.1
plug pg hrvo-data eth0 172.30.2.2/24

role_flag="$work/role-attached"
nsenter --net=/run/netns/imds python3 -I "$work/fake-imds.py" "$role_flag" &
imds_pid=$!
for _ in $(seq 50); do [[ "$(http imds http://10.99.0.2/)" == 200 ]] && break; sleep 0.1; done
# IPv6 is usable once the new links finish duplicate address detection (about a second).
for _ in $(seq 50); do [[ "$(http web 'http://[fd99::2]/')" == 200 ]] && break; sleep 0.1; done

IMDS=http://169.254.169.254/latest/meta-data/
IMDS6='http://[fd00:ec2::254]/latest/meta-data/'

# Group for the tester rule: a group whose ID is mapped into this namespace, if there is one.
tunnel_group=""
if setpriv --regid 10 --clear-groups true 2>/dev/null; then tunnel_group="$(getent group 10 | cut -d: -f1)"; fi
export TUNNEL_GROUP="$tunnel_group"

echo "# without the guard (proves the test can see a leak)"
expect 200 "web reaches IMDS without the guard" "$(http web "$IMDS")"
expect 200 "build (docker0) reaches IMDS without the guard" "$(http build "$IMDS")"
expect 200 "web reaches IMDS over IPv6 without the guard" "$(http web "$IMDS6")"

echo "# guard applied"
bash "$guard" apply >/dev/null
expect 200 "api (its own bridge) reaches IMDS" "$(http api "$IMDS")"
expect 200 "api gets an IMDSv2 token (PUT)" "$(http api -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)"
expect 000 "web (edge bridge) is blocked" "$(http web "$IMDS")"
expect 000 "web is blocked over IPv6 (fd00:ec2::254)" "$(http web "$IMDS6")"
expect 000 "build/docker run (docker0) is blocked" "$(http build "$IMDS")"
expect 000 "internal-network container has no way out" "$(http pg "$IMDS")"
expect 000 "api is blocked on any port but 80" "$(http api http://169.254.169.254:8080/)"

in_ns spoof ip addr flush dev eth0
in_ns spoof ip addr add 172.30.1.2/29 dev eth0
in_ns spoof ip route add 169.254.169.254/32 via 172.30.0.1 dev eth0 onlink
expect 000 "spoof with the API's address (172.30.1.2) on the edge bridge is blocked" "$(http spoof "$IMDS")"
in_ns spoof ip addr flush dev eth0
in_ns spoof ip addr add 172.30.0.10/24 dev eth0
in_ns spoof ip route replace default via 172.30.0.1
expect 000 "spoof with the API's edge address (172.30.0.10) is blocked" "$(http spoof "$IMDS")"

expect 200 "web's other egress is unaffected (IPv4)" "$(http web http://10.99.0.2/)"
expect 200 "web's other egress is unaffected (IPv6)" "$(http web 'http://[fd99::2]/')"
expect 200 "host root (SSM agent, cloud-init, admin) reaches IMDS" "$(host_http "$IMDS")"
if [[ -n "$tunnel_group" ]]; then
  gid="$(getent group "$tunnel_group" | cut -d: -f3)"
  expect 000 "host process in the tester group ($tunnel_group) is blocked" \
    "$(setpriv --regid "$gid" --clear-groups curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$IMDS" || true)"
  expect 200 "host process in another group is unaffected" \
    "$(setpriv --regid 0 --clear-groups curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$IMDS" || true)"
else
  echo "skip host tester-group rule (no subordinate group IDs mapped)"
fi

echo "# Docker's own firewall cannot override it"
nft -f - <<'NFT'
table ip dockerlike {
	chain forward { type filter hook forward priority -100; policy accept; accept; }
}
NFT
expect 000 "an earlier accept in another table does not let web through" "$(http web "$IMDS")"
nft delete table ip dockerlike

echo "# idempotent, checked, atomic"
before="$(nft -a list table inet hrvo_imds | grep -c 'handle')"
bash "$guard" apply >/dev/null && bash "$guard" apply >/dev/null
after="$(nft -a list table inet hrvo_imds | grep -c 'handle')"
expect "$before" "applying again leaves the same number of rules" "$after"
bash "$guard" check >/dev/null && pass "check passes when loaded" || fail "check passes when loaded"
drop_handle="$(nft -a list chain inet hrvo_imds forward | grep -F 'ip daddr 169.254.169.254 counter' | grep -o 'handle [0-9]*' | cut -d' ' -f2)"
nft delete rule inet hrvo_imds forward handle "$drop_handle"
bash "$guard" check >/dev/null 2>&1 && fail "check fails when the drop rule is missing" || pass "check fails when the drop rule is missing"
bash "$guard" apply >/dev/null && pass "apply repairs a tampered table" || fail "apply repairs a tampered table"
API_BRIDGE='x"; flush ruleset' bash "$guard" render >/dev/null 2>&1 && fail "rejects an unsafe API_BRIDGE" || pass "rejects an unsafe API_BRIDGE"
API_SUBNET='0.0.0.0/0 accept' bash "$guard" render >/dev/null 2>&1 && fail "rejects an unsafe API_SUBNET" || pass "rejects an unsafe API_SUBNET"

echo "# rollback"
touch "$role_flag"
bash "$guard" remove >/dev/null 2>&1 && fail "remove is refused while a role is attached" || pass "remove is refused while a role is attached"
expect 000 "after the refused remove web is still blocked" "$(http web "$IMDS")"
rm -f "$role_flag"
bash "$guard" remove >/dev/null && pass "remove succeeds once the role is detached" || fail "remove succeeds once the role is detached"
bash "$guard" check >/dev/null 2>&1 && fail "check fails after remove" || pass "check fails after remove"
expect 200 "after rollback web reaches IMDS again (rollback is complete)" "$(http web "$IMDS")"

echo
if (( fails )); then echo "imds-guard: $fails check(s) FAILED"; exit 1; fi
echo "imds-guard: all checks passed"
