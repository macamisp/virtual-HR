# ADR 041: Verify Google OAuth state cookies in the deployed browser flow

Date: 2026-10-28. Status: accepted. Requirements: FR-AUTH-003/004/005, NFR-SEC-003/004.
Related: ADR 037, ADR 040, [incident and demo steps](../runbooks/google-oauth-invalid-state.md).

## Evidence

The public API process started before the ADR 040 state-cookie correction was compiled. Although
its environment contained `REFRESH_COOKIE_SAMESITE=none`, it still returned `SameSite=Lax` for
`POST /auth/google/start`. Chromium reported `SchemefulSameSiteLax`, stored no state cookie,
sent none to the callback, and received `invalid_state`. Changing only that response attribute
to `None` in an isolated diagnostic made the cookie reach the callback. After rebuilding and
gracefully restarting only the API, the same public browser diagnostic passed without overrides.

## Decision

Keep the ADR 040 cookie correction: cross-site HTTPS starts use `SameSite=None; Secure`, local
HTTP starts use `Lax`, and the ten-minute state cookie remains host-only, HttpOnly, scoped to
`/auth/google`, and unpartitioned. A cookie partitioned under the frontend site cannot reliably
bind a top-level callback on the API site. No new navigation endpoint or authentication proxy
is needed to resolve the observed Lax-cookie rejection.

Validate the query state against the signed cookie before handling provider error responses as
well as successful responses. Missing, expired or tampered state must never reach token exchange
or create a session. Retain PKCE, nonce and ID-token verification and the existing MFA rules.

Treat source tests and deployed-browser checks as separate evidence. The repeatable diagnostic
logs only attributes, block reasons and result codes; it intercepts the Google navigation and
simulates cancellation. It does not establish Google consent or authenticated-session success.
Those require a real Google account and, where required, MFA followed by authenticated access
and session refresh. Browser policies blocking third-party cookies can still affect deployments
on separate sites; a named tunnel on one site remains the documented alternative.

## Validation

54 focused API auth/permission tests passed on a newly created local test database, including
valid Google login and refresh with a test OIDC provider, missing/expired/tampered state,
cross-site/local cookie attributes, MFA, password login, refresh rotation, CSRF and permissions.
API compilation, frontend production build, lint and both typechecks passed. No demo database
records, Google credentials, refresh-cookie policy or media configuration were changed.

Cookie semantics: [Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)
and [partitioned cookies](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies/Partitioned_cookies).
