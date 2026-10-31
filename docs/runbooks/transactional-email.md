# Transactional email with Resend

The API uses the same `MailTransport` for password resets, user invitations, workspace email
verification, notifications and meeting calendar invitations. Existing templates and links are
unchanged (FR-AUTH-001/008, FR-NOTIF-002, FR-MEET-003; ADR 039).

## API environment (Railway when hosting is implemented)

```dotenv
NODE_ENV=production
MAIL_TRANSPORT=resend
RESEND_API_KEY=
RESEND_FROM=
APP_WEB_URL=https://app.example.com
```

Fill `RESEND_API_KEY` with a sending API key and `RESEND_FROM` with your verified sender address,
for example `HRVO <no-reply@mail.example.com>`. These are backend settings; never use a
`NEXT_PUBLIC_` variable for the API key. `APP_WEB_URL` must be the real frontend URL so existing
verification, invitation, reset and notification links reach the preview. In a shell or `.env`
file, quote a sender containing spaces or angle brackets; enter the value without shell quotes
in a hosting environment-variable editor. No Railway or Vercel configuration is created here.

When `resend` is selected, a missing/blank key or sender, a key containing whitespace, or an invalid
sender address stops startup. Production also refuses implicit/explicit development SMTP and
the memory outbox. It never falls back to another transport. All other production guards,
including JWT, CORS, MFA and KMS checks, still apply.

## Manual Resend setup

1. Add a sending domain or subdomain you own in Resend. Publish the DNS records it supplies and
   wait for verification. See [Resend's domain guide](https://resend.com/docs/dashboard/domains/introduction).
2. Create an API key with **Sending access**, preferably restricted to that domain. Keep it in the
   backend's secret environment only. See [Resend's API key permissions](https://resend.com/docs/api-reference/api-keys/create-api-key).
3. Set `RESEND_FROM` to an address on the verified domain and configure the API variables above.
   Disable open and click tracking for transactional mail in Resend, especially single-use links.
4. Confirm the backend can reach `https://api.resend.com`. The integration uses the official
   [Send Email API](https://resend.com/docs/api-reference/emails/send-email); no SDK is installed.

## Preview demo/checks (after manual provider setup)

Use preview accounts and inboxes you control. Do not paste tokens, links, message bodies or API
keys into logs or issue reports. This implementation has only been tested with a mocked provider;
real delivery must be checked once the provider and preview environment are configured.

1. Request a password reset for a preview account. Confirm the email arrives and its link opens
   the configured frontend; complete the reset once and confirm the link cannot be reused.
2. Invite a new preview user and complete the existing invitation flow from the delivered email.
3. Create a preview workspace with another controlled address. Complete email verification from
   the delivered email; confirm access still requires verification.
4. Trigger an enabled email notification and confirm its existing text and links.
5. Schedule a meeting with a controlled recipient. Confirm `invite.ics` arrives and opens in a
   calendar client; check the title, time and join link. Check an update/cancellation too.
6. In a separate disposable configuration, remove `RESEND_API_KEY` or `RESEND_FROM`: startup must
   fail with the missing setting's name. Do not change credentials on a running shared preview.

## Delivery behavior and limits

Each transport call sends one HTTPS POST with a 10-second deadline, including reading the response.
Redirects are refused. Success requires a successful HTTP status and an email ID. Text attachments
are encoded as UTF-8 Base64 with their filenames and MIME types, including calendar `method`
parameters. Provider response bodies and raw network errors are never logged or propagated;
HTTP failures expose only the status code. No transport retry is added, including on timeouts
or rate limits. A timeout can mean Resend accepted the email before the response was lost.

The **existing** BullMQ notification workflow still retries failed notification jobs up to five
attempts. This integration does not change that workflow or guarantee exactly-once delivery:
an ambiguous provider/network failure can still cause a duplicate on a job retry. Reset,
invitation, verification and meeting sends do not gain automatic retries here. Check delivery
in Resend before manually repeating a send after an ambiguous failure.

For local development keep `MAIL_TRANSPORT=smtp` and the existing `SMTP_*` settings (Mailhog).
Automated tests keep `MAIL_TRANSPORT=memory` with `NODE_ENV=test`; no Resend credentials are needed.

```bash
npm run build
node --test dist/apps/api/test/mailer.test.js
```

The mail tests mock every Resend request and use a loopback fake SMTP server. No real emails are sent.
