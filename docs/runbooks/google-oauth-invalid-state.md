# Google OAuth invalid_state: public demo verification

Requirements: FR-AUTH-003/004/005, NFR-SEC-003/004. Decisions: ADR 041 (2026-10-28, first
diagnosis), ADR 042 (2026-10-28, root cause and fix).

## Confirmed cause (ADR 042)

The state cookie was set by the response to a **cross-site fetch** (`POST /auth/google/start`
from the web site to the API site). For the browser that is a third-party cookie. Browsers that
block third-party cookies (Chrome and Edge private windows, Safari, Firefox, Brave) never store
it, so Google's redirect reached the callback without it and the API answered `invalid_state`.
The server side was correct: with the cookie present, a simulated cancellation returned
`denied` and a wrong state returned `invalid_state`.

Reproduced in Chromium through the public tunnels with the shipped fetch-based page:

| Third-party cookies | State cookie stored | Block reason | Cookie on callback | Result |
| --- | --- | --- | --- | --- |
| allowed | yes | none | yes | `denied` (correct) |
| blocked (private window setting) | no | `UserPreferences` | no | `invalid_state` |

A second defect on the same layout: the refresh cookie set by the callback (a top-level page of
the API site) lived in the API site's cookie partition, so the web app's `POST /auth/refresh`
could not present it and the sign-in stalled at "Finishing your Google sign-in".

## Fix

- "Continue with Google" **navigates** to `GET /auth/google/start?…`; the API sets the state
  cookie as a first-party cookie of its own site and redirects to Google.
- The callback creates the session and redirects to `/login?sso=ok#token=<60-second handoff>`;
  the web app posts it to `POST /auth/google/complete`, which claims the session once (replay
  revokes the family) and sets the refresh cookie from the web site's request.
- State, PKCE, nonce, ID-token verification, MFA, password login, refresh and CSRF unchanged.

## Repeatable signed-out browser diagnostic

From the repository root, once with third-party cookies allowed and once blocked:

```bash
node scripts/check-google-oauth-state.mjs \
  https://overseas-friendly-appeared-fwd.trycloudflare.com \
  https://adoption-iowa-forwarding-atlanta.trycloudflare.com
node scripts/check-google-oauth-state.mjs \
  https://overseas-friendly-appeared-fwd.trycloudflare.com \
  https://adoption-iowa-forwarding-atlanta.trycloudflare.com block-third-party-cookies
```

Expected both times: `passed: true`, no blocked reasons, `callbackCookieSent: true`, result
`denied`. The script uses the real login button and API, intercepts the navigation to Google
before sign-in and simulates consent cancellation with that attempt's state. It prints no cookie,
state, authorization code or token values. It is a cookie/callback check, not a login test.

## Automated regressions (`apps/api/test/google-signin-e2e.test.ts`)

- Start: `302` to Google with `Cache-Control: no-store`; open redirects and unknown fields return
  to the web app with `code=failed` and set no state; no client configured gives
  `code=not_configured`.
- Callback: missing cookie, missing state or code, mismatched state, expired cookie, tampered
  signature or payload, and provider errors with missing or mismatched state all give
  `invalid_state`, clear the state cookie, set no refresh cookie and never call the token endpoint.
- Handoff: the callback sets no refresh cookie; the token is audience-bound and lives at most 60
  seconds, as does the pending session; expired, tampered, wrong-audience (a 2FA challenge token)
  and forged-for-a-password-session tokens are refused; a replay is refused and revokes the
  family; the completed session refreshes normally.

## Deployment

Rebuilt the API (`dist/`) and the demo web bundle (`.next-demo-internet`), then restarted only
those two processes with the demo environment. Tunnels, storage, Postgres, Redis, ClamAV, KMS
stub, LiveKit and Mailhog were left running. No schema change, no Google Cloud change, no demo
record deleted.

## Manual acceptance (needs a Google account)

1. In a private window, open the public `/login` and click **Continue with Google**.
2. Choose an eligible account and complete consent, then MFA if asked.
3. The workspace opens; reload: the session survives (`/auth/refresh` succeeds).
4. Start again and cancel at Google: the cancellation message appears, never `invalid_state`.
5. Profile → link Google: with third-party cookies blocked on a two-site demo this one path can
   still report `invalid_state` (ADR 042, consequences). It works with them allowed or on a
   same-site deployment.
