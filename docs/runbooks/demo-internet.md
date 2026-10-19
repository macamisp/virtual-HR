# Runbook: internet demo (Option B: tunnel + LiveKit Cloud)

Show HRVO to people outside your network, from your own machine, for a few hours. Three local services are published through an encrypted tunnel (Cloudflare `cloudflared`), and meetings use **LiveKit Cloud** instead of the local LiveKit.

> **This is a demo, not a deployment.** Use only the generated demo accounts and invented data: no real employees, documents, tax IDs or bank details. **Shut the demo down whenever it is not in use** (see [Shut down](#shut-down)). A running tunnel makes your machine reachable from the internet.

## What is exposed, and what is not

| Service | Local port | Public | Why |
| --- | --- | --- | --- |
| Web app (Next.js) | 3000 | yes, `https://app…` | the pages |
| API (NestJS + Socket.IO) | 3001 | yes, `https://api…` | the browser calls it; LiveKit Cloud sends webhooks to it |
| Document storage, S3 API (SeaweedFS, compose service `storage`) | 9000 | yes, `https://files…` | browsers upload documents with 5-minute presigned URLs |
| Storage internals (master and volume ports) | not published | **no** | the compose file publishes only the S3 port, on 127.0.0.1 |
| Postgres, Redis, ClamAV, KMS emulator | — | **no** | never tunnel these |
| LiveKit | — | LiveKit Cloud | a local LiveKit cannot carry media through an HTTP tunnel |

Camera and microphone only work on HTTPS (or `http://localhost`); the tunnel provides HTTPS. Over a plain `http://` address the pre-join now says so instead of a generic error.

## Before you start

- The local stack runs as in [web-local.md](web-local.md): `docker compose up -d`, migrations applied.
- A LiveKit Cloud project (free tier is enough): <https://cloud.livekit.io>.
- `cloudflared` installed: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>.
- Recommended: a domain on Cloudflare (any cheap domain works), for the named tunnel in step 2.

## 1. Choose and create the tunnels

### Option B1 (recommended): named tunnel on your own domain

The three hostnames must share **one registrable domain you own**, for example `app.demo.example.com`, `api.demo.example.com` and `files.demo.example.com`. The API's refresh cookie is `SameSite=Strict`; the browser only sends it when web and API are the same *site*. With your own domain they are, so a page reload keeps people signed in.

```bash
cloudflared tunnel login                      # opens a browser; pick your domain
cloudflared tunnel create hrvo-demo           # prints the tunnel id and writes ~/.cloudflared/<id>.json
cloudflared tunnel route dns hrvo-demo app.demo.example.com
cloudflared tunnel route dns hrvo-demo api.demo.example.com
cloudflared tunnel route dns hrvo-demo files.demo.example.com
cp infra/demo/cloudflared.example.yml infra/demo/cloudflared.yml   # gitignored
# edit infra/demo/cloudflared.yml: credentials-file path and your three hostnames
```

The hostnames stay the same every time, so you build the web app once.

### Option B2: quick tunnels (no domain, with limitations)

`npm run demo:internet -- tunnels-start quick` starts three tunnels and prints three random `https://….trycloudflare.com` URLs.

- The URLs **change on every start**, so steps 2 and 4 (env values, web rebuild) must be repeated each time.
- The three URLs may count as different sites, so the `SameSite=Strict` refresh cookie may not be sent: people would be signed out on every page reload and after 15 minutes (access-token lifetime). Fine for a short click-through; use B1 for anything longer.

## 2. Set the demo environment

```bash
cp .env.demo-internet.example .env.demo-internet   # gitignored; never commit it
```

Fill it in:

| Variable | Value | Notes |
| --- | --- | --- |
| `APP_WEB_URL` | `https://app.demo.example.com` | links in invitations and notifications |
| `CORS_ORIGINS` | `https://app.demo.example.com` | exactly the web origin; no `*` |
| `NEXT_PUBLIC_API_URL` | `https://api.demo.example.com` | baked into the web build |
| `NEXT_PUBLIC_STORAGE_URL` | `https://files.demo.example.com` | baked into the web build (Content-Security-Policy) |
| `S3_PUBLIC_ENDPOINT` | `https://files.demo.example.com` | the API signs upload URLs for this host; it still talks to the storage on localhost |
| `NEXT_PUBLIC_LIVEKIT_URL` | `wss://<project>.livekit.cloud` | baked into the web build |
| `LIVEKIT_URL` / `LIVEKIT_HTTP_URL` | `wss://<project>.livekit.cloud` / `https://<project>.livekit.cloud` | the API mints room tokens and calls LiveKit's API |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | from LiveKit Cloud > Settings > Keys | create a key for this demo only |
| `TRUST_PROXY` | `loopback` | `cloudflared` on this machine is the only proxy: rate limits and audit logs then use the visitor's address, not 127.0.0.1 |
| `TRUST_PROXY_HEADERS` | empty | set `cloudflare` only if port 3001 is firewalled so that nothing but the tunnel reaches it; otherwise anyone on your network could forge `CF-Connecting-IP` |
| `JWT_SECRET` | `openssl rand -hex 32` | new for the demo |
| `AUTH_MFA_ENFORCEMENT`, `BREACHED_PASSWORD_CHECK` | empty | 2FA stays enforced for HR and admins; new passwords are checked against Have I Been Pwned |

Storage keys: in `.env` set `S3_SECRET_KEY` to a fresh value (`openssl rand -hex 24`) and recreate the storage with it, because the storage endpoint itself is public and its keys are the only lock (it accepts requests from any website origin, which uploads from your web address need):

```bash
docker compose up -d --force-recreate storage    # reads S3_ACCESS_KEY / S3_SECRET_KEY from .env
```

Load the overrides in **every terminal** you use for the demo. Exported variables take precedence over `.env`, so `.env` itself does not change:

```bash
set -a; . ./.env.demo-internet; set +a
```

## 3. LiveKit Cloud webhook

LiveKit Cloud > Settings > Webhooks > Add:

- URL: `https://api.demo.example.com/media/livekit/webhook`
- Signing key: the **same API key** as `LIVEKIT_API_KEY` (the API verifies the signature with it).

Meeting attendance (who joined, for how long) comes from these webhooks. Recording stays off: it is an organisation setting that is off by default, and the demo never needs it (LiveKit Cloud could not reach your local storage anyway).

## 4. Build and start the apps

`NEXT_PUBLIC_*` values are compiled into the browser bundle, so the web app must be **rebuilt** whenever they change (always after quick tunnels restart). In the terminal where you loaded `.env.demo-internet`:

```bash
npx tsc                                                         # API build (dist/)
(cd apps/web && NEXT_DIST_DIR=.next-demo-internet npx next build)
```

Then start them (each in its own terminal, overrides loaded):

```bash
node --env-file-if-exists=.env dist/apps/api/src/main.js                         # API on 3001
(cd apps/web && NEXT_DIST_DIR=.next-demo-internet npx next start -p 3000)       # web on 3000
```

The API prints a warning if 2FA enforcement were off; it must not.

## 5. Seed the demo organisation

```bash
npm run seed:demo:internet
```

- Creates **HRVO Internet Demo** with five accounts (`@internet.demo`) and a one-day invitation link.
- Every run generates **new random 20-character passwords**, prints them **once**, and stores only Argon2id hashes. Copy them from the terminal now; nothing else keeps them.
- HR and the admin enrol 2FA (authenticator app) at their first sign-in.
- It refuses to run if 2FA enforcement is off, the JWT or LiveKit secret is a development value, the breached-password check is the local stub, a public address uses `http://`, or storage is public with a weak key.

The local seed `npm run seed:demo` (one published password) now **refuses** whenever any of these addresses is public, so it cannot be used by mistake.

## 6. Start the tunnels

```bash
npm run demo:internet -- tunnels-start named hrvo-demo     # B1
# B2: the quick tunnels already run since step 1 (their URLs are in steps 2 and 4)
npm run demo:internet -- status
```

## 7. Check before you send the link

```bash
curl -s https://api.demo.example.com/health                                  # {"status":"ok",...}
curl -si -X OPTIONS https://files.demo.example.com/hrvo-documents/check \
  -H 'Origin: https://app.demo.example.com' -H 'Access-Control-Request-Method: PUT' | grep -i access-control-allow-origin
```

The second command must print an `Access-Control-Allow-Origin` header (the storage answers browser preflight requests for any origin). Then, in a private browser window:

1. Open `https://app.demo.example.com`, sign in as the worker: the tracking badge turns "Active".
2. Sign in as HR in another browser: 2FA enrolment appears.
3. Start a meeting: the pre-join shows the camera; a second person joins and both see each other.
4. Upload a small document: it shows "Ready" after the virus scan.

## Shut down

Shut the demo down as soon as you are done, and whenever it is not in use:

```bash
npm run demo:internet:teardown
```

This stops the tunnels and deletes the demo organisation with all its users, sessions and data. Then by hand:

- stop the API and web processes (Ctrl+C);
- LiveKit Cloud: delete the webhook and revoke the demo API key;
- named tunnel: remove the three hostnames in Cloudflare DNS (or `cloudflared tunnel delete hrvo-demo`);
- optional: remove uploaded demo objects (`docker compose down`, then remove the `storage_data` volume) if nothing else uses this local storage.

## Known limitations

- The API runs in development mode (production mode requires AWS KMS and a real mail provider). The refresh cookie is therefore not marked `Secure`; it is only ever sent to the `https://` API host. Mail is not delivered (`MAIL_TRANSPORT=memory`): password resets and invitations by email do not arrive; use the printed invitation link.
- Everything runs on your machine: its uptime, bandwidth and security are the demo's.
