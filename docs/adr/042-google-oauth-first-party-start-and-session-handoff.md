# ADR 042: Start Google sign-in with a navigation and hand the session over by token

Date: 2026-10-28. Status: accepted. Requirements: FR-AUTH-003/004/005, NFR-SEC-003/004.
Related: ADR 037, ADR 040, ADR 041, [runbook](../runbooks/google-oauth-invalid-state.md).

## Problem

On the public demo the web app and the API are on two sites (quick tunnels, ADR 040). "Continue
with Google" called `POST /auth/google/start` with `fetch`, and the API set the `hrvo_oauth` state
cookie on that response. For the browser that is a **third-party cookie**: set by the API site
while the top-level page is the web site. Browsers that refuse third-party cookies (private
windows in Chrome and Edge, Safari, Firefox with Total Cookie Protection, Brave) never store it,
whatever its `SameSite` attribute says. Google then redirects to the callback without the cookie
and every sign-in ends in `invalid_state`. ADR 041's diagnostic ran Chromium with third-party
cookies allowed, which is why it passed while real browsers failed.

The same layout broke the step after a successful callback: the callback is a top-level page of
the API site, so the refresh cookie it set (`SameSite=None; Partitioned`) belonged to the API
site's own partition. The web app's later `POST /auth/refresh` runs under the web site's partition
and did not carry it, so the sign-in stalled at "Finishing your Google sign-in".

## Decision

1. **The start is a top-level navigation.** The web app navigates to
   `GET /auth/google/start?mode=…&returnTo=…`; the API validates the query with the same schema,
   sets the state cookie and answers `302` to Google. The cookie is now a first-party cookie of
   the API site, stored and returned on the callback by every browser. A refused start (bad
   input, Google not configured) returns to the web app with `?sso=error&code=…`, like the
   callback does. `POST /auth/google/start` no longer exists; linking from the profile keeps its
   authenticated `POST /auth/google/link`.
2. **The callback hands the session over by token.** On success the API creates the session but
   sets no cookie. It redirects to `/login?sso=ok#token=<handoff>`: an HS256 JWT (audience
   `hrvo-google-handoff`, 60 seconds) naming the session id. The web app posts it to
   `POST /auth/google/complete`, which claims the session **once** by rotating it exactly like a
   refresh (ADR 018: a second claim is reuse and revokes the family) and sets the refresh cookie
   from a request made by the web site, as a password login does. The pending session expires
   with the token, and its own refresh token is never issued. Only `GOOGLE` sessions can be
   claimed. The 2FA challenge and enrolment tokens already used this pattern.
3. The state cookie keeps ADR 040's attributes (`Lax` locally, `None; Secure` for two-site
   demos, host-only, `/auth/google`, ten minutes, never `Partitioned`). State, PKCE, nonce,
   ID-token checks, MFA rules, password login, refresh rotation and CSRF are unchanged.

## Consequences

- Sign-in works with third-party cookies blocked; no same-origin proxy or named tunnel needed.
- The handoff token is a bearer token for one minute, in a fragment (never sent to servers,
  removed from the address bar on read, and useless after its single use or 60 seconds).
- Linking Google from the profile still starts from a fetch; with third-party cookies blocked on
  a two-site demo it will report `invalid_state`. Moving it to a navigation needs a signed
  one-time ticket because the route is authenticated; left for a later slice.
- `scripts/check-google-oauth-state.mjs … block-third-party-cookies` reproduces the old failure
  and verifies the fix in a browser without a Google account.
