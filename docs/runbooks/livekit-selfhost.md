# Runbook: self-hosted LiveKit (ADR 067)

Replaces LiveKit Cloud with the open-source LiveKit server at `wss://livekit.virtual-hr.site`,
keeping LiveKit Cloud as the rollback. Every step that touches production (new instance, DNS,
security group, `.env.staging`, containers) needs the operator's explicit approval first.

Files: `infra/livekit-selfhost/` — `docker-compose.yml`, `livekit.yaml.tmpl`, `caddy.yaml.tmpl`,
`livekit.env.example`, `configure.sh`, `check.py`, `switch-api-env.py`, `audit-host.sh`.

## 1. What runs where

| Service | Image | Listens on | Public? |
|---|---|---|---|
| Caddy (layer4, TLS, SNI routing) | `livekit/caddyl4:v2.11.3` | TCP 443, TCP 80 (ACME) | yes |
| LiveKit signalling + Twirp API | `livekit/livekit-server:v1.13.11` | 127.0.0.1:7880 | no (via Caddy) |
| LiveKit ICE/UDP | same | UDP 50000-60000 | yes |
| LiveKit ICE/TCP | same | TCP 7881 | yes |
| TURN/UDP (also STUN) | same | UDP 3478 | yes |
| TURN/TLS | Caddy 443 → LiveKit 5349 (plain) | 5349 binds on all interfaces | **must be closed** (security group + host firewall) |
| Redis (LiveKit ↔ Egress) | `redis:7.4.6-alpine` | 127.0.0.1:6389 | no |
| Egress (recording, optional) | `livekit/egress:v1.15.0` | health 9091 | no |

DNS (Cloudflare zone virtual-hr.site): `livekit` and `livekit-turn`, type A, **DNS only (grey
cloud)**, to the media host's Elastic IP. Proxied (orange) records break WebRTC: Cloudflare's
proxy carries only HTTP(S)/WebSocket, not UDP media or TURN. Both names need port 80 reachable for
Let's Encrypt (HTTP-01).

Security group for the media host (inbound): TCP 80, 443, 7881 and UDP 3478, 50000-60000 from
0.0.0.0/0; TCP 22 from the operator's /32 only. Nothing else.

## 2. Infrastructure audit (read-only) and placement decision

```sh
scp -i ~/.ssh/virtual-hr-staging.pem infra/livekit-selfhost/audit-host.sh ubuntu@<host>:/home/ubuntu/
ssh -i ~/.ssh/virtual-hr-staging.pem ubuntu@<host> 'sh /home/ubuntu/audit-host.sh </dev/null' > audit.txt
```

It prints instance type, CPU/RAM/disk, load, containers and their usage, who holds the media
ports, the host firewall, cloudflared, which LiveKit/recording variables are set (names only), the
webhook/egress activity of the last 7 days (counts only) and network totals. It changes nothing.

Decide placement from it:

| | Co-located on the app host | Dedicated media host (recommended) |
|---|---|---|
| Added compute cost | none | one small compute-optimised instance (§3) |
| Isolation | media and ClamAV/API/web compete for CPU; a burstable (t-class) host can run out of CPU credits mid-call | media load cannot slow the app, and the reverse |
| Exposure | publishes the app host's IP (today hidden behind the Cloudflare tunnel); a flood against media also hits the app | the app host stays behind the tunnel |
| Ports | 80/443 must be free on the app host (audit) | clean host |
| Egress | only if the host has ≥ 4 spare vCPU / 4 GB | its own sizing |

Co-location is acceptable for a pilot only when the audit shows a non-burstable instance with
spare CPU and free ports 80/443.

## 3. Sizing and cost (estimates; confirm in the AWS Pricing Calculator for ap-southeast-2)

Load measured in the local rehearsal (§5) and LiveKit's benchmarks (one 16-core node carried 150
video publishers + 150 subscribers at 85% CPU): an office of tens of people with audio-mostly
calls and a few video meetings needs about 2 vCPU. Bandwidth, not CPU, is the cost driver.

| Item | Size | Estimate (USD/month) |
|---|---|---|
| Media instance | c7g.large (2 vCPU Graviton, 4 GB) or c6i/c7i.large (x86) | ≈ 55-85 (US-East list $0.0725-0.089/h; Sydney is typically 20-30% higher) |
| Elastic IP (public IPv4) | 1 | 3.60 ($0.005/h) |
| Disk | 20 GB gp3 | ≈ 2 |
| Data transfer out | audio ≈ 40 kbit/s per subscribed track; 720p video ≈ 1-2.5 Mbit/s per subscribed track | first 100 GB/month free (all of AWS); then ≈ $0.11-0.12/GB in Sydney (verify) |
| Egress host (only if recording is kept) | 4 vCPU / 8 GB, e.g. c7g.xlarge | ≈ 110-140, or run it only when needed |

Worked example: 20 people × 4 h/day of office audio with 3 peers each ≈ 95 GB/month; 5 people ×
1 h/day of video meetings with 4 streams each at 1 Mbit/s ≈ 200 GB/month. Total ≈ 300 GB, i.e.
≈ $20-25 after the free 100 GB. Co-located: only the data transfer and nothing else is new.

## 4. Install (after approval of placement and cost)

On the media host (Ubuntu, Docker with the compose plugin):

```sh
sudo install -d -o ubuntu -m 0750 /opt/hrvo-livekit && cd /opt/hrvo-livekit
# copy infra/livekit-selfhost/* here (git archive of the release commit), then:
cp livekit.env.example livekit.env      # set ACME_EMAIL and NODE_IP=<Elastic IP>
./configure.sh init-secrets             # new production key pair; prints the key NAME only
./configure.sh render
docker compose pull && docker compose up -d     # recording: docker compose --profile recording up -d
docker compose ps                        # livekit and redis healthy, caddy running
```

Host firewall (in addition to the security group), so the plain TURN port can never be opened by
accident: `sudo ufw deny 5349/tcp` (or the equivalent nftables rule) if ufw is in use; the audit
shows which firewall is active. Prometheus metrics stay off; enable `prometheus.port` only bound
behind the security group.

Then, from a workstation (outside the host):

```sh
python3 infra/livekit-selfhost/check.py --livekit livekit.virtual-hr.site \
  --turn livekit-turn.virtual-hr.site --expect-ip <Elastic IP>
# with the secrets file copied to the workstation temporarily, mode 600, deleted afterwards:
#   --secrets secrets.env   adds an authenticated ListRooms call
```

All checks must pass: DNS = Elastic IP (not a Cloudflare address), both certificates valid ≥ 14
days, `GET /` = OK, `/rtc` = 401 without a token, TURN/TLS answers STUN through 443, STUN on UDP
3478, ICE/TCP 7881 open, 7880/6389/5349 closed.

Webhook: the generated `livekit.yaml` posts to `https://api.virtual-hr.site/media/livekit/webhook`
signed with the new key. Until the API is switched (§6) these webhooks are rejected (401, logged as
"webhook rejected"), which is expected and harmless while nobody uses the new server.

Monitoring: `restart: unless-stopped` and Docker healthchecks restart a failed process; add an
external uptime check on `https://livekit.virtual-hr.site/` (expects `OK`) and watch
`docker compose logs livekit` for `"level":"error"`. Certificates renew automatically (Caddy).

## 5. Testing

### Local rehearsal (done 2026-11-17 on a workstation; repeatable)

The bundle ran unchanged under rootless podman with this `livekit.env`: `LIVEKIT_DOMAIN=livekit.hrvo.test`,
`TURN_DOMAIN=turn.hrvo.localhost` (WebRTC's own TURN lookups ignore Chromium's resolver rules but
resolve `*.localhost` to loopback; the signalling name cannot be a `.localhost` name because the
app's `followPageHost` rewrites local names to the page host), `TLS_ISSUER=internal`,
`NODE_IP=<the workstation's LAN address>`, `WEBHOOK_URL=http://127.0.0.1:3101/media/livekit/webhook`,
ports shifted (7990, 7991, 8453, 5369, 3498, 6392, 52000-52200) to avoid other local LiveKits.

| Check | Result |
|---|---|
| `check.py` (TLS both names via SNI, `GET /`, `/rtc` 401, ListRooms with the key, TURN/TLS answers STUN through the TLS front, TURN/UDP STUN, ICE/TCP, 7990/6392 closed on the LAN address) | 10/10 pass. Plain TURN port 5369 is reachable on the LAN: no firewall in the rehearsal; production closes it in the security group and host firewall |
| Existing media specs vs livekit-server 1.13.11 + egress 1.15.0 (17, 22, 25, 34, 35, 36, 39) | 14/14 (spec 22 failed once under load average ≈ 12, passed when re-run; see "Recording start gap") |
| Spec 90 through the TLS front: meeting with two-way audio, network drop and reconnect, blocked microphone | 3/3 pass |
| Spec 90 relay-only (TURN/TLS, TURN/UDP) | the browser obtained relay allocations over TURN/TLS (via Caddy) and TURN/UDP, but relayed media cannot loop back into an SFU on the same machine; these two tests skip with `LIVEKIT_REHEARSAL_LOCAL=1` and must pass in the staging gate |
| Load: 4 audio rooms × 8 + 1 video room × 8 (720p), 60 s, `lk load-test` v2.19.0 | 80/80 tracks, 0% audio loss, 0.003% video loss, 0 errors; livekit-server 0.13 cores (i5-1145G7), 199 MB RSS, ≈ 11.5 Mbit/s forwarded |
| API: livekit-selfhost, meeting-rules, media-errors, meetings-e2e, recordings-e2e, meeting-time-e2e, staging-compose-policy, lan-config | 90/90 |

Recording start gap (pre-existing, not caused by this change): the UI shows "Recording" when the
API has asked Egress to start, but Egress needs about 5 s (7 s under load) to launch Chrome before
it records, so the first seconds of a meeting are not in the file. A self-hosted Egress on a
small host makes the gap longer; consider showing "Starting recording…" until `egress_active`.

Rehearsal spec knobs: `LIVEKIT_REHEARSAL=1`, `LIVEKIT_REHEARSAL_HOSTS=livekit.hrvo.test`,
`LIVEKIT_REHEARSAL_LOCAL=1` (internal CA, loopback for WebRTC), `LIVEKIT_REHEARSAL_TURN_PORT_MAP=443:8453`.
Against the real endpoint set only `LIVEKIT_REHEARSAL=1`.

### Staging gate on the real endpoint (before any production switch)

Point a **separate** test API and web (the SSH-mode stack or a workstation run, with its own test
database and fixture accounts — never production data) at `wss://livekit.virtual-hr.site` with the
new key pair, then run, with two people on two real networks (one on mobile data):

1. Two-user microphone call — both hear each other.
2. Camera — both see each other.
3. Screen share — the other side sees it; stopping removes it.
4. Meeting join/leave — `meeting_participants` rows open and close (webhooks arrive).
5. Office room switching — audio follows the room (spec 34 behaviour).
6. Network reconnection — toggle Wi-Fi for 5-10 s; the call resumes.
7. TURN fallback — `LIVEKIT_REHEARSAL=1` spec 90 against the real names (no rehearsal knobs), and a
   real device on a network that blocks UDP (e.g. a corporate/guest Wi-Fi) shows a `relay` path.
8. Microphone permission blocked — the pre-join explains it.
9. Recording and playback — only if an Egress host is approved.
10. Concurrency — `lk load-test` against the real server while a real call runs; CPU < 60%.

## 6. Production switch-over (only with explicit approval)

Preconditions: §5 staging gate passed; LiveKit Cloud credentials still valid; a quiet time
(Australia night) agreed; current `.env.staging` backed up (the script does it too).

**Phase A — ship the dual-server window (no behaviour change).** Deploy the ADR 067 release (API +
web) with `.env.staging` still on LiveKit Cloud and `LIVEKIT_EXTRA_URLS=wss://livekit.virtual-hr.site`
added, so the web build's CSP allows both servers. Build with the release procedure in
`staging-ec2.md` §5 (tag the current images first for rollback). Verify: a call on Cloud still
works; `curl -sI https://app.virtual-hr.site/login | grep -i content-security` lists both
LiveKit hosts.

**Phase B — switch new joins to the self-hosted server.**

1. Confirm LiveKit Cloud has no active rooms (LiveKit Cloud dashboard → Sessions, or `lk room list`
   with the Cloud pair). If people are in calls, wait; never switch a running call.
2. On the app host:
   ```sh
   cd /opt/virtual-hr/app
   sudo python3 /opt/hrvo-livekit/switch-api-env.py --env .env.staging \
     to-selfhost --secrets /opt/hrvo-livekit/secrets.env --url wss://livekit.virtual-hr.site
   $C up -d --no-deps api      # only the API; the web image already allows both servers
   ```
   (If LiveKit runs on a different host, copy its `secrets.env` to the app host first: mode 600,
   root-owned, and delete the copy afterwards.)
3. Immediately: one test call between two operator accounts; `docker logs` of the API shows
   `webhook accepted: participant_joined` without "via previous key"; `check.py --secrets` shows
   the room in ListRooms.

**Phase C — drain.** Calls that had been on Cloud keep running there until they end; their
webhooks still verify ("via previous key" in the API log). When no such lines appear for a day
and Cloud shows no rooms, run `switch-api-env.py --env .env.staging drop-previous` and recreate
the API.

**Phase D — retire Cloud** after an agreed clean period (e.g. two weeks): revoke the Cloud key
pair in the LiveKit Cloud dashboard. Until then it is the rollback.

Real-user verification after Phase B: ask two or three real users for a call and a meeting; check
`meeting_participants` closes, the office voice dots, and the API log for webhook rejections.

## 7. Rollback

- **After Phase B (API switched):** `sudo python3 /opt/hrvo-livekit/switch-api-env.py --env
  .env.staging restore .env.staging.livekit-backup-<timestamp>` then `$C up -d --no-deps api`.
  New joins go back to Cloud immediately; the web image already allows Cloud. People in a
  self-hosted call stay there until they leave (keep the media host running until then).
- **After Phase A (new images):** retag the images saved before the deploy and
  `$C up -d --no-deps api web` (staging-ec2.md rollback pattern). The schema is unchanged.
- **Media host:** `docker compose down` in `/opt/hrvo-livekit` stops it; remove the two DNS
  records to take the names away. Nothing in the application database depends on it.
