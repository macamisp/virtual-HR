#!/usr/bin/env bash
# Only the API container may reach the EC2 instance metadata service, which hands out the instance
# role's credentials (KMS). Every other container (web, proxy, storage, ClamAV) is dropped
# (ADR 046). Idempotent; run as root after Docker starts (the systemd unit in the runbook does).
#
#   sudo API_EDGE_IP=172.30.0.10 bash infra/staging-ec2/imds-guard.sh
set -euo pipefail
api_ip="${API_EDGE_IP:-172.30.0.10}"
imds=169.254.169.254
iptables -N DOCKER-USER 2>/dev/null || true
# Remove earlier copies of our rules, then insert them at the top in order.
while iptables -C DOCKER-USER -d "$imds/32" -j DROP 2>/dev/null; do iptables -D DOCKER-USER -d "$imds/32" -j DROP; done
while iptables -C DOCKER-USER -s "$api_ip/32" -d "$imds/32" -j RETURN 2>/dev/null; do iptables -D DOCKER-USER -s "$api_ip/32" -d "$imds/32" -j RETURN; done
iptables -I DOCKER-USER 1 -d "$imds/32" -j DROP
iptables -I DOCKER-USER 1 -s "$api_ip/32" -d "$imds/32" -j RETURN
iptables -S DOCKER-USER | grep -F "$imds"
