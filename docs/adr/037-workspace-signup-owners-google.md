# ADR 037: Self-service workspaces, owners, Google sign-in and configurable roles

**Status:** accepted (2026-10-22)
**Requirements:** FR-AUTH-001, FR-AUTH-005, FR-AUTH-006, FR-AUTH-009; FR-ORG-001, FR-ORG-009; FR-ADM-002.

## Context

Until now an organisation existed only when seeded, and every account came from an invitation
sent by HR or an admin. The product needs the opposite entry point too: someone creates a
workspace, becomes its owner, invites people and shapes roles, without a database seed. Auth and
permissions will be ported to Next.js later, so the rules must stay in framework-free services
with the request and response contracts as Zod schemas in `packages/shared`.

## Decisions

1. **Workspace signup.** `POST /auth/signup` creates an organisation (a new RLS tenant, under its
   own `app.org_id` context) and its first user as `SUPER_ADMIN` with `users.is_owner = true`. The
   slug is derived from the name; a clash takes the next numbered variant. The workspace opens
   only after the e-mailed verification link (`email_verification_tokens`, 24 h, single use,
   resendable); sign-in before that answers `403 EMAIL_NOT_VERIFIED`. Abuse controls: the
   `signup` rate bucket, a CAPTCHA hook (`CAPTCHA_PROVIDER` turnstile/hcaptcha/recaptcha with
   `CAPTCHA_SECRET`; no-op when unset) and a disposable-domain block
   (`SIGNUP_BLOCK_DISPOSABLE_EMAILS`, `SIGNUP_BLOCKED_EMAIL_DOMAINS`).
   Invited, admin-created and seeded accounts count as verified (`email_verified_at` defaults to
   now; signup sets it to null).
2. **Owners.** "Owner" is the display name of `SUPER_ADMIN`; ownership itself is the
   `is_owner` flag, which the permission resolver turns into `org.owner`. That permission is never
   part of a role (custom roles refuse it). An owner is changed only by an owner; the last active
   owner can never be demoted, suspended, offboarded or stripped of ownership (`ownerChangeProblem`
   in `apps/api/src/admin/role-rules.ts`). Ownership moves through `ownership_transfers`: the
   current owner confirms with their password or a 2FA code, the new owner accepts within 7 days;
   `keepOwnership` keeps the initiator as a second owner. Removing ownership (`POST
   /org/owners/:id/remove`) also needs re-authentication.
3. **One address, several workspaces.** Login checks the password against every matching account
   first and only then answers `chooseWorkspace` with the matching workspaces, so the list never
   reveals anything to someone without the password. `workspace` (the slug) selects one.
4. **Sign in with Google (OIDC).** Authorization code with PKCE (S256), random `state` and
   `nonce`. They travel with the verifier in a signed httpOnly cookie on the API origin
   (`hrvo_oauth`, 10 min, `SameSite=Lax`, `Path=/auth/google`); nothing is stored. The ID token is
   verified against Google's JWKS (RS256 signature, issuer, audience, expiry, nonce) and the
   address must be `email_verified`. Linking: a known subject signs in directly; otherwise only an
   account with the same verified address, in the chosen or only workspace; an invited person's
   Google address must equal the invited one; nobody joins by domain unless the owner set
   `sso_auto_join_domain`. Roles that need 2FA still answer a TOTP challenge after Google unless
   the owner switched `mfa_for_sso` off; unenrolled ones get an enrolment token. The outcome
   comes back to the web app as `?sso=ok|totp|enroll|error&code=…`, tokens in the URL fragment,
   the session as the usual refresh cookie. Client id, secret and redirect URI come from the
   environment only (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`; the
   calendar-sync names are accepted as a fallback so one client can serve both). A signed-in
   person may link or remove Google on their profile; the last sign-in method (password or
   Google) can never be removed. Every login, link and refusal is audited where a tenant is known
   (`GOOGLE_LOGIN_FAILED` carries the reason). `returnTo` is accepted only as a same-app path.
   The test suites use a local fake OIDC provider (`apps/api/test/support/fake-google.ts`), also
   started for Playwright; `npm run google:check` validates the configuration without printing
   secrets.
5. **Roles.** The built-in roles keep their identifiers (`SUPER_ADMIN`, `ADMIN`, `HR_MANAGER`,
   `HR`, `MANAGER`, `TEAM_LEAD`, `EMPLOYEE`, `SUBCONTRACTOR`, `INTERN`, `AUDITOR`) and their
   permission sets; their display names are now Owner, Admin, HR manager, HR, Project manager,
   Team lead, Member, Subcontractor, Intern, Finance / Auditor (`ROLE_LABEL`,
   `ROLE_DESCRIPTION`). System roles stay fixed (FR-AUTH-006); "editable by the owner" is met by
   custom roles. Every permission now carries a plain-language description
   (`PERMISSION_GROUPS`), and `ACCESS_AREAS` / `visibleAreas()` derive what a set of permissions
   opens in the app, used by the role editor preview and the effective-access page.
   A job title (`users.job_title`) is descriptive only.
6. **Delegation, server side.** Unchanged rules (nobody grants what they do not hold, nobody
   changes their own role, only super admins touch super admins) plus the owner rules above;
   invitations may only carry a role within the inviter's permissions. A built-in role change ends
   the person's sessions (tokens and sockets, via `revokeSessionsOf` and the `hrvo_auth_events`
   trigger); a custom-role change applies on the next request. The permission resolver now checks
   the token's session as well (30 s cache, invalidated at once by every revocation on this
   instance and, with `COORDINATION=redis`, on every instance).
7. **People.** `PUT /admin/users/:id/status` suspends (reversible), reactivates or offboards
   (final: open tasks reassigned or unassigned, team-lead and manager links cleared, ownership
   dropped, sessions ended). Invitations are e-mailed, listed, resent with a fresh link and
   revoked.

## Consequences

- New tables `email_verification_tokens`, `oauth_identities`, `ownership_transfers` (all with
  `org_id` and FORCE RLS) and columns on `organizations` (`work_week`, `sso_auto_join_domain`,
  `mfa_for_sso`, `onboarded_at`), `users` (`is_owner`, `job_title`, `email_verified_at`) and
  `invitations` (`revoked_at`, `last_sent_at`); SECURITY DEFINER lookups for the unauthenticated
  steps. Existing super admins became owners in the migration.
- Screens: `/signup`, `/verify-email`, Google buttons on sign-in, signup and invitation
  acceptance, `/onboarding` (wizard, later the workspace and sign-in settings), `/admin/users`,
  `/admin/invitations`, `/admin/users/:id/access`, `/account/profile`; the role editor shows
  descriptions and a preview.
- Tests: `workspace-e2e.test.ts`, `google-signin-e2e.test.ts` (fake Google), `role-rules.test.ts`,
  Playwright `31-workspace-signup.spec.ts`.
- Not in this change: billing, Microsoft sign-in, CAPTCHA widgets in the web app (the API hook is
  ready), timesheet locking on offboarding, a sessions-and-devices page (FR-AUTH-009 remains
  partial on the UI side).
