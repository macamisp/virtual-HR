# ADR 067: Self-hosted LiveKit media server

Date: 2026-11-17 (revised the same day after the pre-install safety review). Status: proposed
(built, rehearsed and regression-tested locally on `feat/livekit-selfhost-2026-11-17`; nothing
provisioned, deployed or switched).
Related: FR-VO-009, FR-MEET-004, FR-MEET-005, FR-MEET-007, FR-MEET-010; ADR 016 (LiveKit), 024
(recording), 046 (single-EC2 staging), 047 (IMDS isolation), 048 (persistent call, hotfix b1584a8),
052 (Supabase).

## Context

Office audio, meetings, screen sharing and recording run on LiveKit Cloud. We want to run the
open-source LiveKit server ourselves, at `wss://livekit.virtual-hr.site`, without changing how the
application uses media and without interrupting calls when switching.

How HRVO uses LiveKit (unchanged by this ADR):

- The API mints short-lived, one-room tokens (`apps/api/src/media/livekit.ts`) and returns
  `LIVEKIT_URL` in every token response. The browser connects to the URL in the token, not to a
  build-time constant.
- The web build compiles `NEXT_PUBLIC_LIVEKIT_URL` into the Content Security Policy (connect-src),
  per request in `apps/web/src/middleware.ts`. A token naming any other server is blocked.
- The API calls the Twirp RoomService/Egress at `LIVEKIT_HTTP_URL` (default: `LIVEKIT_URL` with
  ws→http) and verifies webhooks (participants, meetings, recordings) with the single key pair.
- Recording uses LiveKit Egress (room composite → S3 staging prefix → encrypted by the API). On
  LiveKit Cloud, Egress is part of the service; production compose runs no Egress container.

## Decision

1. **Deployment bundle `infra/livekit-selfhost/`**, following LiveKit's official VM layout
   (`livekit/generate`): its own Compose project with host networking; `livekit/livekit-server`
   v1.13.11; `livekit/caddyl4` v2.11.3 terminating TLS on 443 and routing by SNI (signalling name →
   LiveKit :7880 on loopback; TURN name → LiveKit's TURN listener, `turn.external_tls: true`);
   its own Redis on loopback. Images pinned to their multi-arch index digests. The LiveKit key
   pair and the Redis password come from `secrets.env`, Redis gets only its password from
   `redis.env` (both mode 600); the rendered configs hold no secret. Let's Encrypt is chosen
   explicitly per run (`ACME_CA=staging|production`, no default) with a required `ACME_EMAIL`. `configure.sh` generates
   a new production key pair (never printed, never the development pair) and renders the configs;
   `check.py` verifies DNS, TLS, signalling, TURN/TLS, TURN/UDP, ICE/TCP and closed ports from
   outside.
2. **Media never passes through Cloudflare's proxy or an HTTP proxy.** Both names are DNS-only
   (grey cloud) A records to the host's public IP. UDP 50000-60000, TCP 7881 and UDP 3478
   go straight to LiveKit; TCP 443 (signalling and TURN/TLS) to Caddy, TCP 80 for ACME only.
   7880 (Twirp/WebSocket, plain), 6389 (Redis) and 5349 (plain TURN behind Caddy) stay closed.
3. **Dual-server window in the application** (this is the only code change):
   - `NEXT_PUBLIC_LIVEKIT_EXTRA_URLS` (compose build arg `LIVEKIT_EXTRA_URLS`): the CSP also allows
     these LiveKit servers (`packages/shared/src/net/livekit-urls.ts`). Built with both Cloud and
     self-hosted URLs, the same web image works with either, so switching and rolling back change
     only the API's environment and recreate only the API.
   - `LIVEKIT_PREVIOUS_API_KEY/SECRET`: webhooks signed by the previous server's pair are accepted
     (`webhookSigner`), so calls that were running on Cloud at the switch still close their
     `meeting_participants` rows (otherwise people stay BUSY for up to 12 h). Tokens and API calls
     always use the current pair. Production refuses a short or reused previous pair. Webhook log
     lines from the old server end in "via previous key", which is how the drain is watched.
4. **Switching never moves a live call.** Clients keep their connection to the server they joined
   until they leave; new joins go to the new server. The switch is made at a quiet time after
   LiveKit Cloud reports no rooms; the API-only switch and rollback are scripted
   (`switch-api-env.py`: names only). The rollback `to-cloud` is the mirror image of `to-selfhost`:
   Cloud becomes current and the self-hosted pair becomes the previous one, so rooms still running
   on the self-hosted server keep closing their attendance; it must run before any rollback of the
   application images (their CSP does not allow the self-hosted server). `drop-previous` asks the
   previous server for its rooms and refuses while any remain. Backups of `.env.staging` go to a
   root-only directory outside the checkout (/var/backups/hrvo-livekit-env), are written atomically
   and never overwritten.
5. **Co-located on the application's EC2 host** (operator decision, 2026-11-17: no new paid
   infrastructure; m7i-flex.large, 2 vCPU, 7.6 GB). Limits fit that host: LiveKit 1 GiB / 1 CPU,
   Caddy 128 MiB / 0.5 CPU, Redis 64 MiB / 0.25 CPU, no swap, `oom_score_adj: 500` so the kernel
   kills these before the application under memory pressure. **No Egress** on this host (recording
   needs ≥ 4 CPUs): recording is unavailable on the self-hosted server until a sized host is
   approved. `scripts/livekit-compose-policy.ts` checks all of this on the rendered project.
6. **Isolation on a shared host.** Host networking (LiveKit's guidance for media) makes these
   containers' packets leave through the host's output path, which ADR 047's `inet hrvo_imds`
   table does not filter, so they could otherwise reach the instance metadata service and the
   role's KMS credentials. Every LiveKit container therefore runs with a dedicated group
   (`LIVEKIT_GID`, 64900) and `livekit-guard.sh` loads a table of its own, `inet hrvo_livekit`:
   - output: drop that group's packets to 169.254.169.254 and fd00:ec2::254;
   - input: 5349 (plain TURN), 7880 (signalling/Twirp) and 6389 (Redis) answer on loopback only.
   `cap_drop: ALL` + `no-new-privileges` keep any process from changing its group. The table is
   replaced atomically and no other table is touched or flushed; a systemd unit loads it before
   Docker and a Docker drop-in refuses to start without it (fail closed, like ADR 047). Its one
   settings file is mandatory, root-owned and strictly parsed, and its group and private ports must
   equal those of the rendered Compose project, so a changed `LIVEKIT_GID` fails closed instead of
   leaving the old group protected; `verify` also checks every LiveKit container's group, and
   `remove` refuses while one runs or the drop-in is installed. Bridge
   networking with a single UDP port would isolate more (no host loopback either) but is
   unrehearsed; the residual risk is that a compromised LiveKit process shares the host's network
   namespace (loopback-bound app ports, password-protected bridges).
7. **Production compose commands always keep the Supabase overlay.** `prod-compose.sh` (installed
   to /opt/hrvo-livekit, outside the app checkout) is the only documented way to drive the
   application stack: it adds the HTTPS and Supabase overlays and `.env.staging.supabase`, refuses
   to run when any is missing, and runs only an allow-list (`ps`, `images`, `logs`, `version`,
   `build api|web`, `config -q`, and recreating api/web detached without their dependencies:
   `prod-compose.sh up -d --no-deps api`); global options, `config`/`convert`
   with output, `down`, `exec`, `run` and the like are refused, and inherited `COMPOSE_*` variables
   cleared. Without it, recreating
   the API with the pre-Supabase command would point it at the old local PostgreSQL.

## Consequences

- No change to tokens, room names, tenant isolation, permission guards, HR workflows or the
  database. The hotfix b1584a8 (ADR 048) is the base of this branch and is untouched.
- The server version moves from 1.9.1 (local dev) to 1.13.11; the existing media specs were
  re-run against 1.13.11 (runbook §5).
- We now operate a media server: TLS renewals (automatic), version upgrades, UDP capacity and
  monitoring become ours. LiveKit Cloud stays configured as the rollback until the drain is over
  and the self-hosted server has run cleanly for an agreed period.
- New images: `livekit/caddyl4` and `livekit/livekit-cli` (tests only). No npm package was added.
- Tests: `npm run test:livekit-guard` (functional, user + network namespace; also re-proves ADR 047)
  and `apps/api/test/livekit-selfhost-infra.test.ts` (policy, Let's Encrypt rendering, secrets,
  `prod-compose.sh`, runbook commands, `to-cloud` through the API's webhook check). `docker compose
  config` and `caddy validate` run in that file only where those binaries exist.
- Open before staging (runbook §2): ports 80/443 free on the host and the content of the root-only
  HTTPS overlay (P4), Elastic IP (P5), recording decision (P6), webhook route and key for the
  staging test API (P7).
