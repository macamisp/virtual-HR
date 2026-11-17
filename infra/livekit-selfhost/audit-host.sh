#!/bin/sh
# Read-only readiness audit of an HRVO host for self-hosted LiveKit (ADR 067; runbook §2).
# Changes nothing. Prints no secret: env files are read for variable NAMES (and the LiveKit host
# suffix) only. Copy to the host and run as a file:  sh audit-host.sh </dev/null
set -u
APP=${APP_DIR:-/opt/virtual-hr/app}
D="sudo -n docker"
section() { printf '\n== %s\n' "$1"; }

section "host"
date -u +%Y-%m-%dT%H:%M:%SZ
uname -sr
. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"
echo "cpus: $(nproc)  model: $(sed -n 's/^model name\s*: //p' /proc/cpuinfo | head -n1)"
uptime
free -m | sed -n '1,2p'
df -h / | tail -n1
# Instance metadata (IMDSv2, host only): type and public IP, to size and to tell an Elastic IP.
tok=$(curl -s -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)
if [ -n "$tok" ]; then
  for k in instance-type placement/availability-zone public-ipv4; do
    printf '%s: %s\n' "$k" "$(curl -s -m 2 -H "X-aws-ec2-metadata-token: $tok" "http://169.254.169.254/latest/meta-data/$k")"
  done
  # An Elastic IP shows up as an association on the primary interface's public IP.
  mac=$(curl -s -m 2 -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/mac)
  printf 'ipv4-associations: %s\n' "$(curl -s -m 2 -H "X-aws-ec2-metadata-token: $tok" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/$mac/ipv4-associations/" | tr '\n' ' ')"
fi

section "load (CPU credits matter on t-class instances)"
cat /proc/loadavg
vmstat 1 3 | tail -n2

section "containers"
$D ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>&1
$D stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' 2>&1

section "listening ports (who holds 80, 443, 3478, 5349, 6389, 7880, 7881)"
sudo -n ss -ltnup 2>/dev/null | awk 'NR==1 || /:(80|443|3478|5349|6389|7880|7881) /'
echo "UDP 50000-60000 in use: $(sudo -n ss -lunp 2>/dev/null | awk '{split($5,a,":"); p=a[length(a)]; if (p>=50000 && p<=60000) n++} END {print n+0}')"

section "host firewall"
sudo -n ufw status 2>/dev/null | head -n 20 || true
sudo -n iptables -S INPUT 2>/dev/null | head -n 20
sudo -n nft list ruleset 2>/dev/null | grep -c . | sed 's/^/nft rule lines: /'

section "cloudflared"
systemctl is-active hrvo-cloudflared 2>/dev/null || systemctl list-units --no-pager 'cloudflared*' 2>/dev/null | head -n 5

section "LiveKit and recording settings (names only)"
for f in "$APP/.env.staging" "$APP/.env.staging.supabase"; do
  [ -r "$f" ] || { sudo -n test -r "$f" 2>/dev/null || continue; }
  echo "$f:"
  sudo -n grep -oE '^(LIVEKIT|RECORDING|NEXT_PUBLIC_LIVEKIT)[A-Z_]*=.' "$f" 2>/dev/null | sed 's/=.$/ (set)/'
  host=$(sudo -n sed -n 's#^LIVEKIT_URL=wss\?://\([^/:]*\).*#\1#p' "$f" 2>/dev/null | head -n1)
  case "$host" in *.livekit.cloud) echo "LIVEKIT_URL host: <project>.livekit.cloud (LiveKit Cloud)";; '') ;; *) echo "LIVEKIT_URL host suffix: ${host#*.}";; esac
done

section "API webhook and recording activity, last 7 days (counts only)"
api=$($D ps --format '{{.Names}}' 2>/dev/null | grep -E 'api-1$|_api_1$' | head -n1)
if [ -n "$api" ]; then
  logs=$($D logs --since 168h "$api" 2>&1)
  echo "webhook accepted: $(printf '%s\n' "$logs" | grep -c 'webhook accepted')"
  echo "webhook rejected: $(printf '%s\n' "$logs" | grep -c 'webhook rejected')"
  echo "egress events:    $(printf '%s\n' "$logs" | grep -c 'webhook accepted: egress_')"
  echo "rooms seen:       $(printf '%s\n' "$logs" | sed -n 's/.*webhook accepted: room_started room=\([a-z]*\)-.*/\1/p' | sort | uniq -c | tr '\n' ' ')"
fi

section "network since boot (rough monthly egress basis)"
awk 'NR>2 && $1 !~ /lo:|docker|veth|br-|hrvo/ {gsub(":","",$1); printf "%s rx %.1f GB tx %.1f GB\n", $1, $2/1e9, $10/1e9}' /proc/net/dev
echo "boot: $(uptime -s)"
