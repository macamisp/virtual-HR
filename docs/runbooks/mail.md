# E-mail: what HRVO sends, and how to receive it (ADR 039)

HRVO sends four account e-mails. Each has one button and, under it, the same link as plain text,
so it works in any mail program:

| E-mail | Subject | Button | Opens | Valid |
| --- | --- | --- | --- | --- |
| Confirm a new workspace owner's address | Confirm your e-mail to open *Workspace* on HRVO | Confirm e-mail and sign in | `/verify-email` | 24 hours, once |
| Invitation | *Name* invited you to *Workspace* on HRVO | Accept invitation | `/accept-invitation` | 7 days, once |
| Password reset | Reset your HRVO password | Choose a new password | `/reset-password` | 30 minutes, once |
| Ownership transfer | You have been asked to take ownership of an HRVO workspace | Review the request | `/admin/users` | 7 days |

Every page those links open ends with a visible next step. An expired or already used link says so
and offers **Send a new link**, which mails the address the old link was sent to. Section 4 has
the details.

## 1. Development: Mailhog (nothing leaves your computer)

```bash
podman compose up -d mailhog        # or: docker compose up -d mailhog
```

In `.env`:

```
MAIL_TRANSPORT=smtp
SMTP_HOST=localhost
SMTP_PORT=1025
MAIL_FROM=no-reply@hrvo.local
APP_WEB_URL=http://localhost:3000
```

Restart the API. Read every e-mail at **http://localhost:8025**. The "Check your e-mail" page
links there in development (`next dev`); a production build shows the link only if
`NEXT_PUBLIC_MAIL_VIEWER_URL` is set, which it must not be.

`MAIL_TRANSPORT=memory` and `MAIL_TRANSPORT=file` are for automated tests: **nothing is
delivered**, and the API prints a warning at start. If signup "only shows Check your e-mail and
nothing arrives", this setting, or a stopped Mailhog, is the reason.

## 2. Real e-mail: Resend

**Never use a personal mailbox password.** In production use a transactional mail provider with an
API key that you can revoke. (The development-mode Internet demo may use a dedicated Gmail account
with an App Password instead; see section 2a.)

1. Create an account at https://resend.com and add your sending domain under **Domains**. Add the
   DNS records it shows (SPF, DKIM) at your DNS provider, and wait until the domain is
   **Verified**.
2. **API Keys → Create API key**, permission **Sending access**, limited to that domain. Copy the
   key; it is shown once.
3. In `.env` on the server, and nowhere else (never in git, chat or tickets):

   ```
   MAIL_TRANSPORT=resend
   RESEND_API_KEY=re_...
   MAIL_FROM=HRVO <no-reply@your-domain.example>
   APP_WEB_URL=https://hrvo.your-domain.example
   ```

   On AWS put `RESEND_API_KEY` in Secrets Manager next to the other secrets (ADR 020).
4. Restart the API. Create a test workspace, or use "Forgot your password?", and check the e-mail
   arrives with a working button.

If a key leaks, delete it in Resend (API Keys → the key → Delete), create a new one, and replace
it in `.env`.

**Amazon SES** is not built in yet. Its SMTP interface would work with the STARTTLS login of
section 2a, but `smtp` is refused in production; enabling it there needs the owner's decision.
Until then use Resend.

## 2a. Internet demo: Gmail with an App Password (ADR 043)

For the development-mode public demo only (`smtp` is refused in production). Use a **dedicated**
Gmail account, never a personal one.

1. On that account turn on 2-Step Verification, then create an App Password at
   https://myaccount.google.com/apppasswords (name it e.g. `Virtual-HR`).
2. Type it yourself into `.env.demo-internet` (git-ignored; keep it `chmod 600`), **without the
   spaces** Google shows, because the file is sourced by bash. Never paste it into chat, tickets or
   a tracked file.

   ```
   MAIL_TRANSPORT=smtp
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=sender@gmail.com
   SMTP_PASSWORD=<16 letters, no spaces>
   MAIL_FROM=sender@gmail.com
   ```

   With `SMTP_USER` and `SMTP_PASSWORD` set the API upgrades with STARTTLS, verifies Google's
   certificate and only then logs in; a server without STARTTLS is refused. Leave both unset in
   `.env` so local development keeps using Mailhog.
3. Restart only the demo API with `.env.demo-internet` sourced (see the Internet demo runbook).
4. Sign up once with an address you control and check the inbox (and spam folder).

`SMTP login refused (reply 535)` in the API log means Google rejected the App Password: create a
new one. Gmail allows roughly 500 messages a day. If the App Password leaks, revoke it on the same
page and create a new one.

## 3. Links must open on the reader's device: APP_WEB_URL

Every link in an e-mail starts with `APP_WEB_URL`. `http://localhost:3000` works only on the
computer that runs HRVO. Opened on a phone or another computer, it points at that device itself and
fails.

| Where people open the e-mails | APP_WEB_URL |
| --- | --- |
| Only on this computer | `http://localhost:3000` |
| Phones or other computers on the same network | the LAN HTTPS address from `npm run lan:env` (e.g. `https://192.168.1.20:3443`); see `docs/runbooks/lan-https.md` |
| Anywhere | the public HTTPS address of the web app |

`npm run lan:check` warns when `APP_WEB_URL` still says localhost while the other addresses point at
the network. Links sent before you change it keep the old address; use **Send a new link**.

## 4. What the pages do

- **Check your e-mail** (after signup) shows:
  - the address the e-mail went to, and three numbered steps;
  - **Resend e-mail**: one e-mail per address per minute. The button counts down, and the server
    enforces the same wait;
  - **Open Mailhog**, in development only;
  - **Already confirmed? Sign in**.
- **Confirm address** (`/verify-email`), one outcome per case:
  - *E-mail confirmed* → **Continue to sign in**, with the address filled in;
  - opened again → *Your e-mail is already confirmed* → **Continue to sign in**;
  - expired, or replaced by a newer e-mail → **Send a new link** and **Sign in**;
  - not recognised → enter your address → **Send a new link**.
- **Accept invitation**, one outcome per case:
  - *You are joining Workspace as address* → name and password, or Google → *Account created* →
    **Continue to sign in**, with the address filled in. Owners, admins and HR then set up 2FA;
  - already accepted → **Sign in**;
  - withdrawn → ask the inviter (no new link);
  - expired → **Send a new link**, which goes to the invited address.
- **Choose a new password**, one outcome per case:
  - *Password changed* → **Sign in**, with the address filled in;
  - used or expired → **Send a new link**.
- **Google signup** sends no e-mail. Google has already verified the address, so the new owner goes
  straight to 2FA set-up and is then signed in.

Tests: `apps/api/test/account-emails-e2e.test.ts` and `mailer.test.ts`, and Playwright
`31-workspace-signup`, `32-google-signin` and `33-account-emails`. The Playwright tests read the
real e-mails (`MAIL_TRANSPORT=file`) and press their buttons.
