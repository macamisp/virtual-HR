# Google OAuth invalid_state: public demo verification

Requirements: FR-AUTH-003/004/005, NFR-SEC-003/004. Date: 2026-10-28. Decision: ADR 041.

## Confirmed cause

The running API was older than the existing ADR 040 state-cookie fix (commit `b2ac3c0`). Its
`POST /auth/google/start` returned a 200 JSON authorization URL and this cookie policy:

| Attribute | Before API restart | After API restart |
| --- | --- | --- |
| SameSite | Lax | None |
| Secure / HttpOnly | Both set | Both set |
| Domain | Absent (API host only) | Absent (API host only) |
| Path | `/auth/google` | `/auth/google` |
| Max-Age | 600 seconds | 600 seconds |
| Partitioned | Absent | Absent |
| Chromium block reason | `SchemefulSameSiteLax` | None |
| State cookie on callback | Absent | Present |
| Simulated cancellation result | `invalid_state` | `denied` |

The frontend uses `apiFetch` with `credentials: 'include'`, receives `authorizeUrl`, then calls
`window.location.assign`. CORS allows the precise frontend origin and credentials. The two
quick-tunnel hosts are separate sites, so a cross-site fetch could not set the Lax cookie.
The redirect URI was already correct; changing Google credentials was unnecessary.

State, nonce and the PKCE verifier are generated with cryptographic randomness and held in a
signed HS256 JWT cookie with issuer/audience checks and a ten-minute expiry. Callback validation
uses the API's stable JWT signing secret. Redis, database persistence and an in-process state
map are not involved. Only one API listener was found. A process restart does not lose the
state if the signing secret stays unchanged; multiple instances must share that secret.

## Repeatable signed-out browser diagnostic

From the repository root:

```bash
node scripts/check-google-oauth-state.mjs \
  https://overseas-friendly-appeared-fwd.trycloudflare.com \
  https://adoption-iowa-forwarding-atlanta.trycloudflare.com
```

Expected: `passed: true`, no blocked reasons, `callbackCookieSent: true`, and result `denied`.
The script uses the actual login button and API, intercepts the navigation to Google before
sign-in, and simulates consent cancellation with that attempt's state. It prints no cookie,
state, authorization code or token values. This is a cookie/callback check, not a login test.

The real Google authorization page was also reached separately (`Sign in - Google Accounts`),
without entering credentials. Real Google consent and public authenticated-session creation
remain unverified until the manual steps below succeed.

## Deployment and checks

Rebuilt the API and gracefully restarted only its listener on port 3001, preserving its
environment and JWT signing secret. The web server, Cloudflare tunnels, local infrastructure
and media services were left running. No schema change or demo-record deletion was needed.
The isolated regression database remains local; tests never connected to the demo database.

- 54 focused tests passed: `google-signin-e2e`, `auth-hardening-e2e`, `route-guards`.
- New regressions cover missing cookie/state/code, mismatched state, expired signed state,
  altered payload/signature, and provider errors with missing or mismatched state. Rejections
  clear state, issue no refresh cookie and never contact the token endpoint.
- The valid Google test completes PKCE, ID-token validation, session creation, refresh and an
  authenticated request against the test provider. Existing MFA/tenant/audit checks also pass.
- API build, frontend production build, lint, API typecheck and frontend typecheck passed.
- The frontend build used a separate output directory to preserve the running demo build.

## Manual acceptance demo

1. Open the public frontend's `/login` in the browser used for the demo. Start a new attempt
   with **Continue with Google**; do not reuse an old callback or browser-back URL.
2. Select an eligible Google account and complete consent. Complete MFA if requested; Google
   sign-in must not waive the mandatory role rules.
3. Confirm the workspace opens and an authenticated API request succeeds.
4. Reload and confirm the session survives; check that `/auth/refresh` succeeds and the workspace
   remains accessible. A callback redirect alone does not prove authenticated-session success.
5. In a fresh attempt, cancel at Google: expect the cancellation message, never `invalid_state`.

If the browser blocks third-party cookies, record the blocked reason without copying cookie
values. `SameSite=None` does not override browser privacy policy. The documented named-tunnel,
same-site deployment is the alternative; do not disable state, PKCE, nonce, MFA or CSRF checks.
