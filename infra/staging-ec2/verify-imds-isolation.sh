#!/usr/bin/env bash
# Verifies on the EC2 host that only the HRVO API container can reach the instance metadata service
# (ADR 047; docs/runbooks/staging-ec2.md, section 4). Read-only except for short-lived probe
# containers and one build that leaves no tagged image. Prints statuses only: never a token, a role
# name, a credential or a metadata body. Run after `up -d`, after `systemctl restart docker` and
# after a reboot:
#
#   sudo bash infra/staging-ec2/verify-imds-isolation.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
project="${COMPOSE_PROJECT:-hrvo-staging}"
image="${PROBE_IMAGE:-hrvo-api:staging}"
fails=0
row() { printf '%-64s %s\n' "$1" "$2"; }
ok() { row "$1" "ok    $2"; }
bad() { row "$1" "FAIL  $2"; fails=$((fails + 1)); }
expect() { # expect <reachable|blocked> <label> <probe output>
  if [[ "$3" == "$1"* ]]; then ok "$2" "$3"; else bad "$2" "$3 (expected $1)"; fi
}
probe_in() { # [PROBE_URL=...] probe_in <docker network argument>...
  docker run --rm -i --cap-drop ALL --security-opt no-new-privileges:true --entrypoint node "$@" "$image" \
    --input-type=module - ${PROBE_URL:+"$PROBE_URL"} < "$here/imds-probe.mjs" 2>/dev/null || echo "error (probe did not run)"
}
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 2; }

echo "== guard and boot order"
if /usr/local/sbin/hrvo-imds-guard check >/dev/null 2>&1; then ok "nftables table inet hrvo_imds" "loaded as configured"; else bad "nftables table inet hrvo_imds" "missing or changed"; fi
[[ "$(systemctl is-enabled hrvo-imds-guard 2>/dev/null)" == enabled ]] && ok "hrvo-imds-guard.service enabled" "" || bad "hrvo-imds-guard.service enabled" "not enabled"
systemctl show docker -p ExecStartPre | grep -q 'hrvo-imds-guard check' && ok "docker.service checks the guard before starting" "" || bad "docker.service checks the guard before starting" "drop-in missing"
systemctl show docker -p After | grep -q 'hrvo-imds-guard.service' && ok "docker.service starts after the guard" "" || bad "docker.service starts after the guard" "drop-in missing"

echo "== containers of project $project"
api_id=""
mapfile -t ids < <(docker ps -q --filter "label=com.docker.compose.project=$project")
(( ${#ids[@]} > 0 )) || bad "running containers" "none found"
for id in "${ids[@]}"; do
  svc="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id")"
  if [[ "$svc" == api ]]; then
    api_id="$id"
    expect reachable "api -> IMDS (needs it for KMS)" "$(probe_in --network "container:$id")"
  else
    expect blocked "$svc -> IMDS" "$(probe_in --network "container:$id")"
  fi
  pid="$(docker inspect -f '{{.State.Pid}}' "$id")"
  priv="$(docker inspect -f '{{.HostConfig.Privileged}} {{.HostConfig.NetworkMode}} drop={{.HostConfig.CapDrop}} add={{.HostConfig.CapAdd}} {{.HostConfig.SecurityOpt}}' "$id")"
  uid="$(awk '/^Uid:/ { print $2 }' "/proc/$pid/status")"
  capeff="$(awk '/^CapEff:/ { print $2 }' "/proc/$pid/status")"
  if [[ "$priv" == false* && "$priv" != *" host "* && "$priv" == *"drop=[ALL]"* && "$priv" == *no-new-privileges* ]]; then
    ok "$svc privileges" "uid=$uid CapEff=$capeff ${priv#false }"
  else
    bad "$svc privileges" "$priv"
  fi
done
if [[ -n "$api_id" ]]; then
  api_pid="$(docker inspect -f '{{.State.Pid}}' "$api_id")"
  gw="$(nsenter -t "$api_pid" -n ip -4 route show default | awk '{ print $3 }')"
  egress_gw="$(docker network inspect "${project}_api_egress" -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null)"
  [[ -n "$gw" && "$gw" == "$egress_gw" ]] && ok "api default route via api_egress" "$gw" || bad "api default route via api_egress" "default via ${gw:-none}, api_egress gateway ${egress_gw:-unknown}"
  expect blocked "api -> IMDS over IPv6 (fd00:ec2::254)" "$(PROBE_URL='http://[fd00:ec2::254]' probe_in --network "container:$api_id")"
fi
members="$(docker network inspect "${project}_api_egress" -f '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null)"
[[ "$members" == "${project}-api-1 " ]] && ok "only the API on bridge hrvo-api" "$members" || bad "only the API on bridge hrvo-api" "${members:-network missing}"
[[ "$(docker network inspect "${project}_api_egress" -f '{{index .Options "com.docker.network.bridge.name"}}' 2>/dev/null)" == hrvo-api ]] && ok "api_egress uses bridge hrvo-api" "" || bad "api_egress uses bridge hrvo-api" "different bridge name"
v6="$(docker network ls -q | xargs -r docker network inspect -f '{{.Name}} {{.EnableIPv6}}' | awk '$2 == "true" { print $1 }' | tr '\n' ' ')"
[[ -z "$v6" ]] && ok "no Docker network has IPv6" "" || bad "no Docker network has IPv6" "$v6"

echo "== other ways in"
expect blocked "docker run on the default bridge -> IMDS" "$(probe_in)"
expect blocked "new container on ${project}_edge -> IMDS" "$(probe_in --network "${project}_edge")"
ctx="$(mktemp -d)"
cp "$here/imds-probe.mjs" "$ctx/p.mjs"
printf 'FROM %s\nCOPY p.mjs /tmp/p.mjs\nRUN node /tmp/p.mjs\n' "$image" > "$ctx/Dockerfile"
build="$(docker build --no-cache --progress=plain --output type=cacheonly "$ctx" 2>&1 | grep -oE '(blocked|reachable) \([^)]*\)' | tail -1)"
rm -r -- "$ctx"
expect blocked "docker build RUN step -> IMDS" "${build:-error (build did not run)}"
host="$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://169.254.169.254/latest/meta-data/ || true)"
[[ "$host" != 000 ]] && ok "host root -> IMDS (SSM agent, cloud-init, EC2 Instance Connect)" "HTTP $host" || bad "host root -> IMDS" "no answer"
tgid="$(getent group "${TUNNEL_GROUP:-hrvo-tunnel}" | cut -d: -f3)"
if [[ -n "$tgid" ]]; then
  t="$(setpriv --reuid nobody --regid "$tgid" --clear-groups curl -s -o /dev/null -w '%{http_code}' -m 3 http://169.254.169.254/latest/meta-data/ || true)"
  [[ "$t" == 000 ]] && ok "tester group -> IMDS from the host" "blocked" || bad "tester group -> IMDS from the host" "HTTP $t"
else
  row "tester group -> IMDS from the host" "skip  (group ${TUNNEL_GROUP:-hrvo-tunnel} does not exist)"
fi

echo
if (( fails )); then echo "IMDS isolation: $fails check(s) FAILED"; exit 1; fi
echo "IMDS isolation: all checks passed on $(hostname) (boot $(cut -c1-8 /proc/sys/kernel/random/boot_id))"
