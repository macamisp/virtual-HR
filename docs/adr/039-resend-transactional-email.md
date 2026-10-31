# ADR 039: Resend transactional email

**Status:** Accepted
**Date:** 31 October 2026
**Requirements:** FR-AUTH-001, FR-AUTH-008, FR-NOTIF-002, FR-MEET-003; SRS 4.1 (Resend).

Use Resend's HTTPS API through the existing `MailTransport`, with Node's native `fetch` and no
new dependencies. `MAIL_TRANSPORT=resend` requires `RESEND_API_KEY` and `RESEND_FROM`. Production
refuses SMTP and memory delivery; local development and tests keep their existing modes.

Keep consumers and templates unchanged. Encode existing text attachments as UTF-8 Base64 and
preserve MIME parameters. Use a fixed HTTPS endpoint, reject redirects, enforce a 10-second
deadline, validate the successful response and expose only sanitized failures. The transport
does not log content or credentials and does not retry.

Existing BullMQ notification retries remain unchanged. Ambiguous failures can still cause
duplicates when those jobs retry; changing notification delivery semantics or adding durable
idempotency is outside this transport change. No schema, authentication, deployment or cloud
resource changes are included. See [setup and preview checks](../runbooks/transactional-email.md).
