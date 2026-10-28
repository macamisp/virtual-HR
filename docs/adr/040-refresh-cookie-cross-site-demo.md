# ADR 040: Refresh cookie across two sites (internet demo on quick tunnels)

Date: 2026-10-28. Status: accepted. Related: ADR 005 (security baseline), FR-AUTH-003, docs/runbooks/demo-internet.md.

## Context

The refresh token travels only as an httpOnly cookie scoped to `/auth/refresh`, `SameSite=Strict` (FR-AUTH-003, ADR 005). A browser sends a Strict cookie only when the page and the API are the same *site*. With a named tunnel on one domain they are. With Cloudflare **quick tunnels** each service gets a random `*.trycloudflare.com` host, and `trycloudflare.com` is on the Public Suffix List, so the web app and the API are two different sites: the browser never sent the cookie, people were signed out on every reload and after 15 minutes. The runbook listed this as a known limitation of option B2.

## Decision

A new setting, `REFRESH_COOKIE_SAMESITE`, defaults to `strict` and accepts `none`. With `none` the cookie is sent with `SameSite=None; Secure; Partitioned`:

- `Secure` because SameSite=None cookies are refused otherwise; the setting is refused unless `APP_WEB_URL` is `https://`, and the API refuses to start on any other value.
- `Partitioned` (CHIPS) so the browser keeps the cookie per top-level site: the one set while the demo web app is open is only sent from the demo web app.
- The CSRF defence of `/auth/refresh` is unchanged and is what makes SameSite=None acceptable: the custom `X-HRVO-CSRF` header forces a CORS preflight, and the `Origin` must be on the `CORS_ORIGINS` allow-list, which lists exactly the web origin. A cross-site form cannot send the header, and a cross-site script is stopped by the preflight.

Nothing changes for local development, the LAN proxy or a named-tunnel demo: the default stays `strict`.

## Consequences

- Option B2 (quick tunnels) keeps people signed in across reloads in Chrome, Edge and Firefox.
- Safari blocks third-party cookies altogether, so on Safari and iPhone a reload still signs the visitor out (the 15-minute access token still works until then). Option B1 (named tunnel, one domain) remains the recommendation for anything longer than a short click-through.
- `REFRESH_COOKIE_SAMESITE=none` must never be set for a same-site deployment: it only widens where the cookie travels, with no benefit.
