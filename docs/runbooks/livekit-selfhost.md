# Runbook: self-hosted LiveKit on the application's EC2 host (ADR 067)

Replaces LiveKit Cloud with the open-source LiveKit server at `wss://livekit.virtual-hr.site`,
running in Docker next to the application on its existing EC2 host (i-084a36f551ca3a72c,
m7i-flex.large: 2 vCPU, 7.6 GB), keeping LiveKit Cloud as the rollback. No new instance. Every step
that touches production (security group, DNS, host firewall, files under /opt, containers,
`.env.staging`) needs the operator's explicit approval first.

Files: `infra/livekit-selfhost/` — `docker-compose.yml`, `livekit.yaml.tmpl`, `caddy.yaml.tmpl`,
`livekit.env.example`, `configure.sh`, `livekit-guard.sh` (+ `hrvo-livekit-guard.service`,
`docker-hrvo-livekit-guard.conf`), `prod-compose.sh`, `switch-api-env.py`, `check.py`,
`audit-host.sh`; `scripts/livekit-compose-policy.ts` + `livekit-compose-check.ts`.

**Two rules that apply to every command below:**

1. **The application stack is only ever driven through `/opt/hrvo-livekit/prod-compose.sh`.**
   Production runs on Supabase (ADR 052): a compose command without the Supabase overlay and
   `.env.staging.supabase` recreates the API against the old local PostgreSQL. The wrapper always
   adds them, refuses to run when any is missing, and runs only an allow-list: `ps`, `images`,
   `logs`, `version`, `build api|web`, `config -q`, and recreating api/web detached without their
   dependencies (`prod-compose.sh up -d --no-deps api`). Everything else is
   refused: options before the subcommand (`-f`, `-p`, `--profile`, `--ansi`, ...), `config`/`convert`
   with output (they print every secret), `down`, `stop`, `rm`, `restart`, `exec`, `run`, unknown
   flags and services. It clears inherited `COMPOSE_*`/`DOCKER_HOST` variables. It lives outside the
   app checkout, so it is still there after a rollback. Anything outside the allow-list needs a
   reviewed change to the wrapper, not a workaround.
2. **The LiveKit project (`/opt/hrvo-livekit`, plain `docker compose`) never starts unless
   `hrvo-livekit-guard check` and `hrvo-imds-guard check` both pass, and `hrvo-livekit-guard verify`
   passes after every start.**
3. **Rollback order: `switch-api-env.py to-cloud` first, application images second.** The previous
   web image's Content Security Policy does not allow the self-hosted server.

## 1. What runs where

| Service | Image (pinned by digest) | Listens on | Public? |
|---|---|---|---|
| Caddy (layer4, TLS, SNI routing) | `livekit/caddyl4:v2.11.3` | TCP 443, TCP 80 (ACME) | yes |
| LiveKit signalling + Twirp API | `livekit/livekit-server:v1.13.11` | 127.0.0.1:7880 | no (via Caddy) |
| LiveKit ICE/UDP (media) | same | UDP 50000-60000 | yes |
| LiveKit ICE/TCP (media fallback) | same | TCP 7881 | yes |
| TURN/UDP (also STUN) | same | UDP 3478 | yes |
| TURN/TLS (media fallback) | Caddy 443 (name `livekit-turn.`) → LiveKit 5349 (plain) | 5349 binds on all interfaces | **no**: host guard + security group |
| Redis (LiveKit state) | `redis:7.4.6-alpine` | 127.0.0.1:6389 | no |

No Egress: recording needs at least 4 CPUs per LiveKit's guidance, more than this host has (§2, P6).

Limits (scripts/livekit-compose-policy.ts enforces upper bounds): LiveKit 1 GiB / 1 CPU / 512 PIDs,
Caddy 128 MiB / 0.5 CPU, Redis 64 MiB / 0.25 CPU, no swap, `oom_score_adj: 500` (under memory
pressure the kernel kills these before the application's containers). Rehearsal: 40 participants
used 0.13 cores and ~200 MB.

**Isolation (ADR 067 §6).** Host networking means these containers' packets leave through the host's
own output path, which ADR 047's `inet hrvo_imds` table does not filter. So every LiveKit container
runs with group `LIVEKIT_GID` (64900), and `livekit-guard.sh` loads a table of its own,
`inet hrvo_livekit`: its output chain drops that group's packets to 169.254.169.254 and
fd00:ec2::254 (instance metadata, the role's KMS credentials); its input chain answers 5349, 7880 and
6389 on loopback only. `cap_drop: ALL` + `no-new-privileges` mean nothing inside a container can
change its group. The guard never flushes the ruleset or touches another table.

DNS (Cloudflare zone virtual-hr.site): `livekit` and `livekit-turn`, type A, **DNS only (grey
cloud)**, to the instance's public IP. Proxied (orange) records break WebRTC: Cloudflare's proxy
carries only HTTP(S)/WebSocket, not UDP media or TURN. Both names need port 80 reachable for Let's
Encrypt (HTTP-01). The Cloudflare tunnel for app/api is unchanged.

Security group (inbound, added): TCP 80, 443, 7881 and UDP 3478, 50000-60000 from 0.0.0.0/0. SSH
stays restricted to the operator's /32. Nothing else.

## 2. Open prerequisites (read-only checks and decisions; none done yet)

- **P4 ports 80/443 free on the host** and the content of the root-only
  `docker-compose.staging.https.yml` (does it publish the app proxy on 80/443?):
  `sudo ss -ltnp '( sport = :80 or sport = :443 )'`, and the override's service/port names.
- **P5 public IP**: Elastic IP or auto-assigned (`audit-host.sh` prints the association). An
  auto-assigned IP changes on stop/start, which breaks DNS and `NODE_IP`. Replacing it with an
  Elastic IP costs nothing extra while attached but changes the address (SSH allowlist, any Supabase
  network restriction).
- **P6 recording**: with self-hosted LiveKit, LiveKit Cloud's Egress no longer records. Decide:
  keep recording switched off for every organisation (the admin setting is off by default), or
  approve an Egress host later (it would also need `RECORDING_S3_ENDPOINT` it can reach).
- **P7 staging webhooks and keys**: a workstation test API is not reachable for LiveKit's webhooks
  (meeting attendance rows) unless the operator starts a temporary HTTPS tunnel to it and sets
  `WEBHOOK_URL` to that during staging; the test API also needs the key pair (copy `secrets.env` to
  the workstation, mode 600, delete afterwards) unless a separate staging key is added.

`audit-host.sh` (read-only) prints instance type, CPU/RAM/disk, load, containers and usage, who
holds the media ports, the host firewall, cloudflared, which LiveKit/recording variables are set
(names only), webhook/egress counts of the last 7 days and network totals:

```sh
scp -i ~/.ssh/virtual-hr-staging.pem infra/livekit-selfhost/audit-host.sh ubuntu@<host>:/home/ubuntu/
ssh -i ~/.ssh/virtual-hr-staging.pem ubuntu@<host> 'sh /home/ubuntu/audit-host.sh </dev/null' > audit.txt
```

## 3. Cost (co-located: estimates; confirm in the AWS Pricing Calculator, ap-southeast-2)

No new compute, disk or IP charge (the public IPv4 address is already billed). The only new cost is
**data transfer out** (inbound is free; TURN relaying on the same host adds nothing):
≈ $0.114/GB in Sydney after the 100 GB/month free allowance, which is shared across all of AWS and
already partly used by the application's own traffic through the tunnel.

1 Mbit/s for an hour ≈ 0.45 GB. Per subscribed track-hour: audio ≈ 0.02 GB; small video tile
0.07-0.2 GB; 720p 0.7-1.1 GB; screen share 0.45-0.9 GB. Light use (20 people on office audio,
5 people 1 h/day of video) ≈ 300 GB/month ≈ $25-35; heavy (10 people 2 h/day of video, 5 streams
each) ≈ 1 TB ≈ $115. Load tests against the server count too. LiveKit Cloud stays paid until the
rollback window closes.

## 4. Install (after approval; nothing here restarts the application)

On the host, as `ubuntu` with sudo. `<commit>` is the reviewed release commit.

```sh
# 1. Bundle, outside the app checkout (it must survive app rollbacks).
sudo install -d -o ubuntu -m 0750 /opt/hrvo-livekit
# (git fetch first if needed: fetching and archiving do not change the app checkout)
mkdir -p /tmp/hrvo-lk-bundle && git -C /opt/virtual-hr/app archive <commit> infra/livekit-selfhost \
  scripts/livekit-compose-policy.ts scripts/livekit-compose-check.ts | tar -x -C /tmp/hrvo-lk-bundle
cp -r /tmp/hrvo-lk-bundle/infra/livekit-selfhost/. /opt/hrvo-livekit/
mkdir -p /opt/hrvo-livekit/scripts && cp /tmp/hrvo-lk-bundle/scripts/livekit-compose-*.ts /opt/hrvo-livekit/scripts/
cd /opt/hrvo-livekit

# 2. Settings, secrets, rendering. ACME_CA=staging first (rate limits), ACME_EMAIL required.
cp livekit.env.example livekit.env      # set ACME_EMAIL, ACME_CA=staging, NODE_IP=<public IP>
./configure.sh init-secrets             # secrets.env + redis.env (600); prints the key NAME only
./configure.sh render                   # generated/*.yaml, generated/hrvo-livekit-guard.default, .env

# 3. Host guard, next to ADR 047's (fail closed: Docker requires both). The settings file is
#    mandatory (root-owned, not writable by others) and must name the same group and private ports
#    as the rendered Compose project (.env): check/apply refuse otherwise.
sudo install -m 755 livekit-guard.sh /usr/local/sbin/hrvo-livekit-guard
sudo install -o root -g root -m 644 generated/hrvo-livekit-guard.default /etc/default/hrvo-livekit-guard
sudo install -m 644 hrvo-livekit-guard.service /etc/systemd/system/hrvo-livekit-guard.service
sudo hrvo-livekit-guard apply           # one transaction on its own table; other tables untouched
sudo hrvo-imds-guard check              # ADR 047 still loaded and correct
sudo install -d /etc/systemd/system/docker.service.d
sudo install -m 644 docker-hrvo-livekit-guard.conf /etc/systemd/system/docker.service.d/hrvo-livekit-guard.conf
sudo systemctl daemon-reload && sudo systemctl enable hrvo-livekit-guard.service   # no Docker restart needed now

# 4. Validate before anything starts.
sudo -n docker compose config -q
sudo -n docker compose config --format json | sudo -n docker run --rm -i --network none \
  -v "$PWD/scripts:/s:ro" --entrypoint node hrvo-api:staging \
  --experimental-strip-types --no-warnings=ExperimentalWarning /s/livekit-compose-check.ts --gid 64900

# 5. Start (only after the security group rules and the two DNS-only records exist).
sudo hrvo-livekit-guard check && sudo hrvo-imds-guard check && sudo -n docker compose pull && sudo -n docker compose up -d
sudo hrvo-livekit-guard verify           # every LiveKit container (running or stopped) has LIVEKIT_GID
sudo -n docker compose ps                # livekit and redis healthy, caddy running
/opt/hrvo-livekit/prod-compose.sh ps    # the application's containers: same IDs, still healthy
```

Changing `LIVEKIT_GID` later (all four steps, in this order; the guard refuses in between, which is
the point):

```sh
./configure.sh render                                                     # .env + settings: new group
sudo install -o root -g root -m 644 generated/hrvo-livekit-guard.default /etc/default/hrvo-livekit-guard
sudo hrvo-livekit-guard apply                                             # the table now protects the new group
sudo -n docker compose up -d --force-recreate && sudo hrvo-livekit-guard verify   # containers follow
```

Verify the metadata service is unreachable from **every** LiveKit container (each must time out;
none may print `reachable`):

```sh
for c in hrvo-livekit-caddy-1 hrvo-livekit-livekit-1 hrvo-livekit-redis-1; do
  sudo -n docker exec "$c" wget -q -T 3 -O /dev/null http://169.254.169.254/latest/meta-data/ \
    && echo "$c: reachable (STOP: remove the stack)" || echo "$c: blocked"
done
```

From a workstation (outside the host), with Let's Encrypt **staging** certificates first
(`--cafile` = Let's Encrypt's staging roots), then again after switching `ACME_CA=production`,
`./configure.sh render` and `sudo -n docker compose up -d caddy`:

```sh
python3 infra/livekit-selfhost/check.py --livekit livekit.virtual-hr.site \
  --turn livekit-turn.virtual-hr.site --expect-ip <public IP>
```

All checks must pass: DNS = the instance's IP (not a Cloudflare address), both certificates valid,
`GET /` = OK, `/rtc` = 401 without a token, TURN/TLS answers STUN through 443, STUN on UDP 3478,
ICE/TCP 7881 open, 7880/6389/5349 closed.

Webhook: `livekit.yaml` posts to `WEBHOOK_URL` signed with the new key. Pointed at the production
API before the switch (§6), those webhooks are rejected (401, "webhook rejected" in the API log):
expected and harmless while only test rooms exist.

Monitoring: `restart: unless-stopped` and Docker healthchecks restart a failed process; add an
external uptime check on `https://livekit.virtual-hr.site/` (expects `OK`); watch
`sudo -n docker compose logs livekit` for `"level":"error"` and `sudo -n docker stats` during busy
hours. Certificates renew automatically (Caddy).

## 5. Testing

### Regression tests (repository; no containers, no root)

- `npm run test:livekit-guard`: a user + network namespace plays the EC2 host (fake metadata
  service, Internet client, API and web bridges, unrelated nftables tables, a stub Docker). Proves:
  every LiveKit identity (uid 0 and 999, group 64900) is cut off from IPv4/IPv6 metadata and the
  IMDSv2 token; ADR 047 still lets only the API through; 5349/7880/6389 closed from outside but open
  on loopback; 443/80/7881/3478 open; other tables byte-identical after apply, re-apply and remove;
  tampering is detected and repaired; a missing, malformed, foreign-owned or world-writable settings
  file and a group or ports that differ from the Compose project all fail closed (environment
  variables ignored); a changed group is refused until settings, table and containers all follow
  (`verify`); `remove` refuses while a LiveKit container runs or the Docker drop-in is installed.
- `npm run test:imds-guard` (ADR 047) unchanged and passing.
- `apps/api/test/livekit-selfhost-infra.test.ts` (in `npm test`): compose policy on the shipped file
  and on mutated renderings, digests, Let's Encrypt staging/production rendering and refusals,
  secret placement, guard settings and systemd units, `prod-compose.sh` (Supabase overlay, the
  allow-list and every bypass from the review), this runbook's commands, backups (private directory
  outside the checkout, atomic, never overwritten), the drain check of `drop-previous` against a
  stand-in LiveKit server, and the `to-cloud` rollback verified through the API's own webhook check.
  `docker compose config` and `caddy validate` run there when `DOCKER_COMPOSE` / `CADDY_BIN` are
  available (not on the workstation that wrote them: see the ADR 067 report).

### Local rehearsal (done 2026-11-17 on a workstation, before the P1-P11 fixes)

The bundle ran under rootless podman with `LIVEKIT_DOMAIN=livekit.hrvo.test`,
`TURN_DOMAIN=turn.hrvo.localhost` (WebRTC's own TURN lookups ignore Chromium's resolver rules but
resolve `*.localhost` to loopback; the signalling name cannot be a `.localhost` name because the
app's `followPageHost` rewrites local names to the page host), `TLS_ISSUER=internal`,
`NODE_IP=<the workstation's LAN address>`, ports shifted to avoid other local LiveKits.

| Check | Result |
|---|---|
| `check.py` (TLS both names via SNI, `GET /`, `/rtc` 401, ListRooms, TURN/TLS STUN through the TLS front, TURN/UDP STUN, ICE/TCP, internal ports closed on the LAN address) | 10/10 (plain TURN reachable on the LAN: no guard in that rehearsal; now covered by `livekit-guard.sh`) |
| Existing media specs vs livekit-server 1.13.11 (17, 22, 25, 34, 35, 36, 39) | 14/14 (22 failed once under load average ≈ 12, passed when re-run) |
| Spec 90 through the TLS front: meeting, network drop and reconnect, blocked microphone | 3/3 |
| Spec 90 relay-only (TURN/TLS, TURN/UDP) | relay allocations obtained over both; relayed media cannot loop back into an SFU on the same machine, so these skip with `LIVEKIT_REHEARSAL_LOCAL=1` and must pass in the staging gate |
| Load: 4 audio rooms × 8 + 1 video room × 8 (720p), 60 s | 80/80 tracks, 0% audio / 0.003% video loss; 0.13 cores, 199 MB |

Since then the containers' user/group, limits and digests changed (P1, P9, P10) and Egress was
removed; the staging gate re-runs everything on the real host.

Recording start gap (pre-existing): the UI shows "Recording" before Egress has started Chrome
(≈ 5 s), so the first seconds of a meeting are not in the file.

Rehearsal spec knobs: `LIVEKIT_REHEARSAL=1`, `LIVEKIT_REHEARSAL_HOSTS=livekit.hrvo.test`,
`LIVEKIT_REHEARSAL_LOCAL=1`, `LIVEKIT_REHEARSAL_TURN_PORT_MAP=443:8453`. Against the real endpoint
set only `LIVEKIT_REHEARSAL=1`.

### Staging gate on the real endpoint (the app stays on LiveKit Cloud)

A **separate** test API and web on a workstation (own database, fixture accounts, never production
data) pointed at `wss://livekit.virtual-hr.site` (P7), two people on two real networks (one on
mobile data):

1. Two-user microphone call. 2. Camera. 3. Screen share. 4. Meeting join/leave with
`meeting_participants` rows opening and closing (needs P7's webhook route). 5. Office room switching.
6. Network reconnection (toggle Wi-Fi 5-10 s). 7. TURN fallback: spec 90 without rehearsal knobs,
and a real device on a network that blocks UDP shows a `relay` path. 8. Blocked microphone.
9. Recording: not on this host (P6). 10. Concurrency: a moderate `lk load-test` (≈ 20 participants)
while watching host CPU/memory and the application's response times. Then 24-72 h soak.

## 6. Production switch-over (only with explicit approval)

Preconditions: §5 staging gate passed; LiveKit Cloud credentials still valid; a quiet time
(Australia night) agreed. All application commands go through `prod-compose.sh`.

**Phase A — ship the dual-server window (no behaviour change).** Check out the ADR 067 release in
`/opt/virtual-hr/app` (this also ships the hotfix b1584a8 for the first time), with `.env.staging`
still on LiveKit Cloud and `LIVEKIT_EXTRA_URLS=wss://livekit.virtual-hr.site` added. Tag the live
API and web images for rollback first (`sudo -n docker tag <live image> <name>:pre-adr067`), then:

```sh
/opt/hrvo-livekit/prod-compose.sh build api web
/opt/hrvo-livekit/prod-compose.sh up -d --no-deps api web
```

Verify: a call on Cloud still works; `curl -sI https://app.virtual-hr.site/login | grep -i
content-security` lists both LiveKit hosts; the API still talks to Supabase (the health check and
a sign-in work; the API log shows no local `postgres` host).

**Phase B — switch new joins to the self-hosted server.**

1. Confirm LiveKit Cloud has no active rooms (Cloud dashboard → Sessions). If people are in calls,
   wait; never switch a running call.
2. Re-render with the production webhook URL if staging used another one, restart LiveKit
   (`sudo -n docker compose up -d livekit` in /opt/hrvo-livekit), then on the app host:
   ```sh
   cd /opt/virtual-hr/app
   sudo python3 /opt/hrvo-livekit/switch-api-env.py --env .env.staging \
     to-selfhost --secrets /opt/hrvo-livekit/secrets.env --url wss://livekit.virtual-hr.site
   /opt/hrvo-livekit/prod-compose.sh up -d --no-deps api      # only the API
   ```
3. Immediately: one test call between two operator accounts; the API log shows
   `webhook accepted: participant_joined` without "via previous key"; `check.py --secrets` lists the
   room.

**Phase C — drain.** Calls that were on Cloud keep running there until they end; their webhooks
still verify ("via previous key"). When none appear for a day:
`sudo python3 /opt/hrvo-livekit/switch-api-env.py --env .env.staging drop-previous`, then
`/opt/hrvo-livekit/prod-compose.sh up -d --no-deps api`. `drop-previous` asks the previous server
(ListRooms with its own key) and refuses while it reports rooms or cannot be asked;
`--confirm-no-rooms` is for a server that is gone, after the operator has checked by other means.

**Backups.** Every change made by `switch-api-env.py` first writes a backup of `.env.staging` to
`/var/backups/hrvo-livekit-env` (created root-only, mode 700; files mode 600), never into the app
checkout: atomically (temp file, fsync, link into a name that cannot already exist), named
`.env.staging.<UTC time to the microsecond>.before-<command>.bak`, never overwritten and never
deleted by the script. `switch-api-env.py --env .env.staging list-backups` lists them (no values).
They contain every production secret: delete old ones deliberately, by hand, once the switch-over
is closed.

**Phase D — retire Cloud** after an agreed clean period (e.g. two weeks): revoke the Cloud key pair
in the LiveKit Cloud dashboard. Until then it is the rollback.

Real-user verification after Phase B: two or three real users make a call and a meeting; check
that `meeting_participants` closes, the office voice dots, and the API log for webhook rejections.

## 7. Rollback

**Order matters: step 1 before step 2.** The previous web image's Content Security Policy does not
allow the self-hosted server, so rolling back images while the API still hands out self-hosted
tokens breaks every call.

1. **The API back to LiveKit Cloud (if Phase B happened):**
   ```sh
   cd /opt/virtual-hr/app
   sudo python3 /opt/hrvo-livekit/switch-api-env.py --env .env.staging to-cloud
   /opt/hrvo-livekit/prod-compose.sh up -d --no-deps api
   ```
   `to-cloud` takes the Cloud values from the previous pair, or (after a `drop-previous`) from the
   newest `before-to-selfhost` backup (or `--cloud-from <path from list-backups>`). It refuses when
   already on Cloud. New joins go back to Cloud at once (the web image allows both). The self-hosted
   pair becomes the previous one, so rooms still running on the self-hosted server keep closing
   their attendance through webhooks. **Keep the self-hosted stack running and
   `/opt/hrvo-livekit/secrets.env` in place until those rooms have drained**; `drop-previous` checks
   that before it removes the pair. (`restore <backup>` puts a file back byte for byte but forgets
   the self-hosted pair: last resort only.)
2. **The application images (if Phase A must be undone; only after step 1):** retag the
   `:pre-adr067` images to the live tags, `git -C /opt/virtual-hr/app checkout --detach <previous commit>`,
   then `/opt/hrvo-livekit/prod-compose.sh up -d --no-deps api web` (the wrapper is outside the
   checkout, so it still exists). The schema is unchanged.
3. **The LiveKit stack itself (only after step 1 and the drain):** in /opt/hrvo-livekit,
   `sudo -n docker compose down`; then remove the docker drop-in
   (`/etc/systemd/system/docker.service.d/hrvo-livekit-guard.conf`) and `sudo systemctl daemon-reload`,
   `sudo systemctl disable hrvo-livekit-guard.service`, `sudo hrvo-livekit-guard remove` (deletes only
   its own table; it refuses while a LiveKit container runs or the drop-in is still installed), then
   the security group rules and the two DNS records. Nothing in the application database depends on it.
