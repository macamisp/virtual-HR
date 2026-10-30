# ADR 047: Instance metadata isolation on the staging EC2 host

Date: 2026-10-30. Status: accepted (verified locally; not yet verified on the AWS host).
Requirements: NFR-SEC-001, SRS 10.1, 12. Related: ADR 046 (single-EC2 staging), ADR 021 (KMS).
Supersedes ADR 046 decision 5's firewall design (source address in `DOCKER-USER`).

## Problem

The API wraps document keys with AWS KMS using the instance role. Its temporary credentials come
from the EC2 instance metadata service (IMDS, 169.254.169.254). IMDSv2 with hop limit 2 lets any
container on a Docker bridge fetch them, so the host firewall must let only the API through.

ADR 046 allowed only source address 172.30.0.10 (the API's fixed address on the shared `edge`
network) in Docker's `DOCKER-USER` chain, from a systemd unit started *after* Docker. Review found:

1. **Address is not identity.** Every container on `edge` can send from 172.30.0.10:
   - Docker's default capabilities include NET_RAW (forged packets, ARP spoofing on the bridge);
   - another container can be given that address while the API is stopped.
2. **Start-up race.** Docker restarts containers with `restart: unless-stopped` before the unit
   ran, so after each boot they ran unguarded for a moment.
3. **No IPv6 rule** for fd00:ec2::254 (the Nitro IPv6 endpoint when it is enabled).
4. **Tied to Docker's iptables backend.** `DOCKER-USER` does not exist with Docker's nftables
   firewall backend (`firewall-backend: nftables`).
5. **The host was open.** Testers signed in as `ubuntu` (sudo) and could `ssh -L` to
   169.254.169.254.
6. **Too many privileges.** No container dropped capabilities or set no-new-privileges. Redis and
   SeaweedFS ran as root, because the compose entrypoints bypass the images' own user switch.

## Decision

1. **Identity by interface.** The API has its own network, `api_egress`, with a fixed bridge name
   (`hrvo-api`) and its default route (`gw_priority: 100`). Nothing else may join it. The kernel
   knows which bridge a packet arrived on, and a container cannot change that, whatever address
   it forges.
2. **Own nftables table** (`infra/staging-ec2/imds-guard.sh`), table `inet hrvo_imds`:
   - **forward hook, priority filter − 10:**
     - accept `iifname "hrvo-api" ip saddr 172.30.1.0/29 → 169.254.169.254 tcp/80`;
     - drop every other packet to 169.254.169.254;
     - drop every packet to fd00:ec2::254.
   - **output hook:** drop both addresses for sockets whose group is `hrvo-tunnel`.

   Docker never touches a table it did not create, with either backend. A drop in any base chain is
   final, so Docker's own accept rules cannot undo it. Applying is one transaction (declare,
   delete, add), so there is never a gap. `check` compares whole lines of the forward chain; an
   earlier draft matched substrings and missed a deleted drop rule, which the test caught.
3. **Boot order and fail-closed.**
   - `hrvo-imds-guard.service` runs before `network-pre.target` and docker.service.
   - A docker.service drop-in adds `Wants`/`After` the guard and `ExecStartPre=hrvo-imds-guard
     check`, so Docker does not start without the rules.
   - Stopping the unit does not remove them; `remove` is explicit, and refuses while an instance
     profile is attached.
4. **Unprivileged containers.**
   - Every service has `cap_drop: [ALL]` and `no-new-privileges:true`.
   - Capabilities added back:
     - postgres and ClamAV: CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID, for their root
       entrypoints. Each was shown to be needed: each smaller set fails at start.
     - proxy: NET_BIND_SERVICE.
     - everything else: none.
   - Redis and SeaweedFS now run as their image users (`redis`, `seaweed`).
   - `scripts/staging-compose-check.ts` checks the rendered project before each deployment:
     - no privileged or host-namespace containers, Docker socket or devices;
     - only allow-listed capabilities, never NET_RAW or NET_ADMIN;
     - only the API on `hrvo-api`, with the highest `gw_priority`;
     - databases only on internal networks, and no IPv6;
     - only the proxy publishes non-loopback ports, and nobody gets static AWS keys.
5. **Testers get restricted accounts.**
   - Accounts in group `hrvo-tunnel` are limited by an sshd `Match Group` block: `PermitOpen` the
     three loopback app ports only, no shell, TTY, agent, X11, listening or socket forwarding.
   - The guard's output rule blocks that group from IMDS.
   - Other logins are unchanged.
6. **IMDS options:** `http-tokens required`, hop limit 2, `http-protocol-ipv6 disabled`,
   `instance-metadata-tags disabled`.
7. **The role stays KMS-only.** Session Manager credentials of any kind would be readable by the
   API too, so SSH is the preferred way in. The profile is attached only after the guard is
   verified on the host (runbook 4b).

## Verification

- **`infra/staging-ec2/test/imds-guard-netns.sh`** (`npm run test:imds-guard`, no root):
  - **Setup:** a user and network namespace stands in for the EC2 host. It has a fake IMDS
    (IPv4 and IPv6) behind a routed hop, the `hrvo-api`, edge, `docker0` and internal bridges,
    and a forging container.
  - **Result:** 29 checks pass. The forging case uses the API's address on the edge bridge.
- **`apps/api/test/staging-compose-policy.test.ts`:** 14 tests of the policy. The rendered
  configurations of both modes (Compose v5.6.1 from Docker 29.9.2) pass. The previous
  configuration fails 13 checks.
- **Real Docker 29.9.2** (docker:29.9.2-dind in rootless podman), with the iptables and the
  nftables firewall backends:
  - **Topology:** the rendered staging networks and hardening, with alpine stand-ins for the images.
  - **Blocked:** every other service, `docker run` on the default bridge, a new container on
    edge, a NET_ADMIN container forging the API's address, and a `docker build` step.
  - **Still working:** the API reaches IMDS, its default route goes via `hrvo-api`, loopback
    publishing works, and normal egress is unaffected.
  - **Restart:** the same after restarting dockerd.
  - **Controls:** without the guard, the same probes see the leak.
  - **`verify-imds-isolation.sh`** gives the same results. Only its systemd rows could not run in
    that container.
- **The hardened images under podman:**
  - web, Redis, SeaweedFS and PostgreSQL run as non-root with no effective capabilities.
  - Caddy runs as root with NET_BIND_SERVICE only.
  - `clamd` and `freshclam` run as `clamav` with none.

## Consequences and limits

- **Not verified on AWS yet.** These have only been simulated:
  - the real hop limit;
  - systemd ordering at boot;
  - Ubuntu's sshd;
  - Docker's actual backend on the instance.

  The runbook's sections 4 and 4a run `verify-imds-isolation.sh` after `up`, after a Docker restart,
  after a reboot and in a fail-closed test, before the profile is attached.
- **A compromised API holds the role's credentials** and can read all instance metadata, including
  user data. The role can only Encrypt/Decrypt the two keys with an `org_id` and `document_id`
  context, so put no secrets in user data.
- **Root on the host bypasses the guard.** So does anyone in the `docker` group, and anyone able to
  edit the compose file (by attaching a container to `api_egress`). The compose check and the
  verify script detect the latter, but do not prevent it.
- **ClamAV's init process** (`tini`, `tail`) keeps five capabilities as root. Caddy runs as root
  with NET_BIND_SERVICE.
- **Host processes outside `hrvo-tunnel`** can still reach IMDS. This keeps the SSM agent,
  cloud-init and EC2 Instance Connect working.
- **The output rule depends on group membership:** it matches the socket's primary group, so tester
  accounts must have `hrvo-tunnel` as their primary group.
- **Changing the subnet** means changing both `API_SUBNET` in compose and
  `/etc/default/hrvo-imds-guard`. The compose check compares them.
