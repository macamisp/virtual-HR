# ADR 067: Self-hosted LiveKit media server

Date: 2026-11-17. Status: proposed (built and rehearsed locally on `feat/livekit-selfhost-2026-11-17`;
nothing provisioned, deployed or switched; production audit pending SSH access).
Related: FR-VO-009, FR-MEET-004, FR-MEET-005, FR-MEET-007, FR-MEET-010; ADR 016 (LiveKit), 024
(recording), 046 (single-EC2 staging), 047 (IMDS isolation), 048 (persistent call, hotfix b1584a8).

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
   its own Redis on loopback (required by Egress); optional `livekit/egress` v1.15.0 behind the
   `recording` profile. Keys and the Redis password come from `secrets.env` (mode 600) through
   `LIVEKIT_KEYS` / `REDIS_PASSWORD`; the rendered configs hold no secret. `configure.sh` generates
   a new production key pair (never printed, never the development pair) and renders the configs;
   `check.py` verifies DNS, TLS, signalling, TURN/TLS, TURN/UDP, ICE/TCP and closed ports from
   outside.
2. **Media never passes through Cloudflare's proxy or an HTTP proxy.** Both names are DNS-only
   (grey cloud) A records to the media host's Elastic IP. UDP 50000-60000, TCP 7881 and UDP 3478
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
   (`switch-api-env.py`: names only, mode-600 backups, byte-identical restore).
5. **Where it runs is the operator's choice, after the audit** (runbook §2): co-located on the
   existing EC2 host (no new instance cost, shares CPU with the app and exposes the host's IP) or a
   dedicated small compute-optimised instance (recommended; needs cost approval). Egress for
   recording needs ≥ 4 vCPU / 4 GB per LiveKit's guidance, so recording either stays on a sized
   host or recording is paused until one is approved.

## Consequences

- No change to tokens, room names, tenant isolation, permission guards, HR workflows or the
  database. The hotfix b1584a8 (ADR 048) is the base of this branch and is untouched.
- The server version moves from 1.9.1 (local dev) to 1.13.11; the existing media specs were
  re-run against 1.13.11 (runbook §5).
- We now operate a media server: TLS renewals (automatic), version upgrades, UDP capacity and
  monitoring become ours. LiveKit Cloud stays configured as the rollback until the drain is over
  and the self-hosted server has run cleanly for an agreed period.
- New images: `livekit/caddyl4`, `livekit/egress` v1.15.0 and `livekit/livekit-cli` (tests only).
  No npm package was added.
