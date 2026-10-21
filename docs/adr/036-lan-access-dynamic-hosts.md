# ADR 036: Access from other devices on the local network

**Status:** accepted (2026-10-21)

## Context

HRVO is demonstrated on one computer with phones and laptops on the same Wi-Fi. The camera, the
microphone, `crypto.subtle` (heartbeat signing, FR-ATT-004) and WebRTC only work in a secure
context, which a browser grants to `http://localhost` and to `https://` pages. Until now:

- the web app had one API address baked in (`NEXT_PUBLIC_API_URL`, default
  `http://localhost:3001`), so a page opened as `http://192.168.1.20:3000` on a phone sent its
  requests to the phone's own localhost;
- `CORS_ORIGINS` was an exact-match list, so each device-facing address had to be spelled out;
- the LAN HTTPS tooling depended on mkcert and Docker, neither of which is installed on every
  developer machine (this one has OpenSSL and Podman);
- the web dev server was pinned to 127.0.0.1 behind the proxy.

## Decision

1. **Listen on every interface.** The API binds to `0.0.0.0` unless `HOST` says otherwise
   (`listenHost()` in `apps/api/src/common/config.ts`); the Next.js dev server and the TLS proxy
   bind to `LAN_BIND`, default `0.0.0.0`.
2. **The browser follows the page host.** `followPageHost()` in
   `packages/shared/src/net/local-url.ts` replaces the hostname of a configured address with the
   page's own hostname when the configured one is local (localhost, loopback, RFC 1918 or
   link-local IPv4, `.local`/`.lan`/`.home`/`.internal` names). Scheme and port stay as
   configured. The web app applies it to the API address (REST, Socket.IO heartbeat and office
   sockets) and to the LiveKit signalling address in media tokens. Storage presigned URLs are not
   rewritten: their host is part of the signature, so `S3_PUBLIC_ENDPOINT` must be the
   device-facing address. A public address is never rewritten, so production is unaffected.
3. **CSP per request.** The Content Security Policy moves from `next.config.mjs` to
   `apps/web/src/middleware.ts`, where `connect-src` is built from the request host with the same
   rule, so the browser is allowed to connect to what it will actually call.
4. **CORS patterns, not wildcards.** A `CORS_ORIGINS` entry may contain `*` for one host label
   or the port (`https://192.168.*.*:3443`, `https://hrvo.local:*`). `*` never matches a dot, so
   `192.168.*.*` does not match `192.168.evil.com`. `*` alone stays refused, and patterns are
   refused in production. Outside production the default allow-list is localhost, 127.0.0.1 and
   the private IPv4 ranges on port 3000. HTTP CORS, the Socket.IO handshake and the refresh-cookie
   CSRF check share one matcher.
5. **Certificates with mkcert or OpenSSL.** `npm run lan:certs` uses mkcert when it is installed,
   otherwise an OpenSSL local certificate authority in `.lan-https/ca.pem` (825 days; leaf
   certificates 397 days, RSA 2048, serverAuth, Subject Alternative Names). The certificate names
   `LAN_HOST`, every IPv4 address of the computer, `localhost`, `127.0.0.1` and `::1`. Once a root
   exists it is kept, so devices that trust it keep trusting later certificates.
6. **A Node proxy by default.** `scripts/lan-proxy.ts` (no packages) terminates TLS on
   3443/3444/7443/8443 and forwards to the web app, API, LiveKit and storage on this computer,
   WebSockets included, adding `X-Forwarded-For` which the API trusts from loopback only
   (`TRUST_PROXY=loopback`). The Caddy container (docker-compose profile `lan-https`) remains an
   option with `LAN_PROXY=caddy`.

## Consequences

- One `npm run lan:up` gives a trusted `https://` address to every device that has imported the
  root once; `npm run lan:check` proves it with TLS probes against that root and, where
  `certutil` exists, a real browser.
- A plain `http://<ip>:3000` page now works for everything except the camera, microphone and
  heartbeat signing (no secure context); the pre-join screen explains this and points to the
  runbook. Chrome's "insecure origins treated as secure" flag is documented as a test-only
  shortcut.
- Private keys, certificates and `.env.lan` stay out of git (`.gitignore`).
- Tests: `apps/api/test/lan-config.test.ts` (URL derivation, host following, CORS patterns,
  bind address) and `route-guards.test.ts` (runtime fail-closed guard).
