# ADR 039: Account e-mails that lead somewhere; 2FA after Google; joining by invitation

**Status:** accepted (2026-10-23)
**Requirements:** FR-AUTH-001 (amended), FR-AUTH-004 (clarified), FR-AUTH-005, FR-AUTH-008; SRS 1.1.
**Amends:** ADR 037 decision 4 (sign in with Google) and the join-by-domain rule.

## Context

A new owner reported that after creating an account "there is only an e-mail and no clear way to
sign in from it". Tracing every account e-mail end to end showed:

- **Plain-text e-mails only.** No button: in Mailhog, and in many mail programs, the link is just
  text.
- **No resend after signup.** "Check your e-mail" offered only "Go to sign in". There was no resend
  button and, in development, no pointer to Mailhog.
- **Old links ended in error text.** An expired or used invitation or reset link, and a
  confirmation link opened twice, showed raw error text with no button. Nothing said whether the
  link was used, expired, replaced or withdrawn.
- **Nothing to see in development.** `MAIL_TRANSPORT=memory` keeps e-mails in the API's memory, and
  the local `.env` used it with no Mailhog running. Nothing told the developer.
- **No real mail provider.** The only alternative to Mailhog was a plaintext SMTP client.
  `.env.example` offered `SMTP_USER` / `SMTP_PASSWORD`, which were never read and invited a Gmail
  password.
- **localhost links.** Links are built from `APP_WEB_URL`. Left at `http://localhost:3000`, they do
  not open on a phone or another computer.
- **Tests never read a real e-mail.** The browser tests replaced the tokens in the database.

The owner also took the two decisions left open by the 23 October status review:
- Owner, Admin and HR always need 2FA after a Google sign-in.
- Self-service workspace creation stays, but joining an existing workspace is by invitation only;
  domain auto-join stays off by default.

## Decisions

1. **One e-mail layout** (`apps/api/src/common/email-layout.ts`).
   - Each account e-mail has an HTML part with one button and the same address as a plain link
     under it, plus a text part that names the action and gives the link.
   - Links are always built from `APP_WEB_URL`.
   - SMTP sends the two parts as `multipart/alternative`.
   - The four e-mails are confirm address, invitation, password reset and ownership transfer.
2. **Every landing page ends with a visible next step.**
   - *E-mail confirmed* and *Account created* end with **Continue to sign in**; *Password changed*
     ends with **Sign in**. Each opens the sign-in page with the address filled in (`?email=`).
   - The person signs in rather than being signed in by the link, because roles that need 2FA
     enrol at that point.
   - A confirmation link opened again says *already confirmed* instead of failing.
3. **Old links say why, and send a new one.**
   - `POST /auth/links/status` reports whether a link is valid, used, expired, withdrawn or
     invalid.
   - `POST /auth/links/renew` sends a fresh link, only ever to the address the old link was sent
     to, never to one from the request. It always answers the same way.
   - Renewal covers an unconfirmed address, an expired pending invitation (audited as
     `INVITATION_RESENT` by `invitee_expired_link`) and a used or expired reset link.
   - A withdrawn invitation and an already accepted one are never renewed.
   - Limits: the `signup` rate bucket per IP, plus a per-person wait. That is one confirmation
     e-mail per address per `VERIFICATION_RESEND_COOLDOWN_SECONDS` (default 60), and one
     invitation renewal per minute.
4. **"Check your e-mail" after signup** shows:
   - the address and three numbered steps;
   - **Resend e-mail**, counting down the server's wait (`resendAfterSeconds` in the signup
     answer);
   - **Already confirmed? Sign in**;
   - **Open Mailhog**, in development only. The link appears in `next dev`, or when
     `NEXT_PUBLIC_MAIL_VIEWER_URL` is set, which a production build must not set.
5. **Mail transports** (`mailer.ts`; no new package):
   - **smtp:** Mailhog, development only.
   - **resend:** the Resend HTTPS API. `RESEND_API_KEY` and `MAIL_FROM` come from the environment
     only.
   - **memory:** API tests.
   - **file:** browser tests, one JSON file per e-mail.
   - In production, memory, file and smtp are refused. Outside tests, memory and file print a
     warning that nothing is delivered.
   - `SMTP_USER` and `SMTP_PASSWORD` were removed from `.env.example`. HRVO never uses a personal
     mailbox password.
   - Amazon SES is not built in: it needs an SDK package or SMTP with TLS and login, which needs
     the owner's approval.
6. **`APP_WEB_URL` must be reachable by the reader.** `.env.example` and
   `docs/runbooks/mail.md` say so. `npm run lan:check` warns when `APP_WEB_URL` is localhost while
   the other addresses point at the network (`localhostLinkWarning`, `scripts/lan-config.ts`).
7. **2FA after Google (FR-AUTH-004).**
   - Roles that need 2FA (Owner/Super Admin, Admin, HR Manager, HR, and custom roles holding
     their permissions) answer it after Google exactly as after a password.
   - The permission resolver's Google exemption is gone.
   - The organisation's `mfa_for_sso` switch now only decides whether people who turned 2FA on
     for themselves are asked after Google. The settings screen says so.
8. **Joining by invitation (FR-AUTH-001, amended in SRS 1.1).**
   - Anyone may create a new workspace, after confirming their address or with a Google-verified
     address.
   - An existing workspace is joined by invitation; the role comes from the invitation.
   - The one exception remains the owner's join-by-domain option. It is off by default (`NULL`),
     and it now accepts only the domain of the owner's own e-mail address, never a public mail
     service such as gmail.com (`autoJoinDomainProblem`).

## Consequences

- **API:** `account-links.service.ts`, two public routes and `VerifyEmailResponseSchema`.
  `SignupResponse` gains `resendAfterSeconds`, and `LinkTokenDto` / `LinkStatus` are added to
  `packages/shared`.
- **Web:** a shared `LinkProblem` card, `useLinkStatus` / `renewLink` / `signInHref`, and
  reworked `/signup` (done state), `/verify-email`, `/accept-invitation` and `/reset-password`.
  The sign-in page reads `?email=`. A second link pasted into the same tab reloads the page.
- **Tests:**
  - `mailer.test.ts`: layout, multipart, file and Resend transports, production rules.
  - `account-emails-e2e.test.ts`: link states, renewals, cooldown, e-mail content, expired
    invitation refused.
  - `workspace-e2e` and `google-signin-e2e`: updated for the decisions.
  - `lan-config.test.ts`: the warning.
  - Playwright `31-workspace-signup` now reads and presses the real confirmation and invitation
    e-mails. `32-google-signin` checks that Google signup sends no e-mail and that the owner
    always does 2FA. `33-account-emails` covers resend, the Mailhog link, replaced, used, expired
    and withdrawn links, and the reset flow.
- **Data:** no migration; existing columns (`created_at`, `last_sent_at`) carry the cooldowns.
- **Local setup:** with `MAIL_TRANSPORT=memory` in `.env`, signup e-mails never arrive. Use
  `smtp` with Mailhog (`docs/runbooks/mail.md`).
