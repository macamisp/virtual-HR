# ADR 043: SMTP with STARTTLS and login for the Internet demo (Gmail App Password)

Date: 2026-10-29. Status: accepted. Requirements: FR-AUTH-001 (e-mail confirmation),
FR-AUTH-008 (reset links), NFR-SEC-001 (TLS in transit), NFR-SEC-003 (no secrets in code or logs).
Related: ADR 039, [mail runbook](../runbooks/mail.md), [Internet demo runbook](../runbooks/demo-internet.md).

## Problem

The public Internet demo sent its account e-mails to Mailhog, which only the owner can read, so
visitors never received confirmation, invitation or password-reset links. The owner wants real
delivery without a sending domain, from a dedicated Gmail account (`smtp.gmail.com:587`) with a
Google App Password. The `smtp` transport was a plaintext Mailhog client: no STARTTLS, no login,
and `SMTP_USER` / `SMTP_PASSWORD` were ignored, so Gmail refused it before `MAIL FROM`.

## Decision

1. `MAIL_TRANSPORT=smtp` reads `SMTP_USER` and `SMTP_PASSWORD`. Both set means submission with
   login; neither means the old plaintext Mailhog client; only one is a start-up error.
2. With a login the client must upgrade with **STARTTLS** before anything else. If the server does
   not offer it, the send fails before `AUTH`; there is no plaintext fallback. The certificate and
   host name are verified against the system trust store (`rejectUnauthorized` is never turned
   off; the `ca` option exists for tests only and is not read from the environment).
3. Login is `AUTH PLAIN` after the second `EHLO`. A refused login reports only the reply code.
   The password is never logged and never appears in an error.
4. Node's built-in `tls` module does the upgrade, so no new package.
5. `smtp` is still refused when `NODE_ENV=production`. Production mail stays on Resend (ADR 039).
   *Superseded in part by ADR 046 (2026-10-30): production now accepts authenticated submission
   on port 587 with a plain sender; the unauthenticated form is still refused.*
   Gmail is for the development-mode Internet demo only: its daily sending limit (about 500 per
   day for a consumer account), Google's anti-abuse checks and the `@gmail.com` sender do not
   suit a product.

## Consequences

- Local development is unchanged: `.env` sets no `SMTP_USER`, so mail still goes to Mailhog on
  `localhost:1025`.
- `.env.demo-internet` (git-ignored, mode 600) carries `MAIL_TRANSPORT=smtp`, `SMTP_HOST`,
  `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASSWORD` and `MAIL_FROM`. It is sourced before the API
  starts, so it overrides `.env`.
- The App Password is written without spaces: the file is sourced by bash, and Google's spaced
  display form (`abcd efgh ijkl mnop`) would split the line.
- If the App Password leaks, revoke it at https://myaccount.google.com/apppasswords and create a
  new one; the account's own password is unaffected.
