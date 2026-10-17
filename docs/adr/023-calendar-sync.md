# ADR 023: Two-way calendar sync with Google and Outlook

**Status:** Accepted (needs the organisation's own OAuth apps before it can be used)
**Date:** 17 October 2026
**Requirements:** SRS 5.4 FR-MEET-006; FR-MEET-003 (scheduled meetings, `.ics`).

## Decisions

The owner chose **two-way sync for both providers**, tested against local fakes. It works for real once the organisation registers an OAuth app with Google and with Microsoft and sets the client IDs and secrets. No new package is used; the adapters call the REST APIs with `fetch`.

## Behaviour

| | Google Calendar | Microsoft Outlook (Graph) |
| --- | --- | --- |
| **Out:** our meetings in their calendar | `events.import` with our iCalendar UID (`<meeting>@hrvo`), the **host as organizer** and the person as attendee. Google sends no e-mails. Reschedules patch the event; cancellations delete it. | `POST /me/events` **without attendees** (Graph would otherwise e-mail invitations), with `transactionId` = UID so a retried create is idempotent. Patched and deleted like Google's. |
| **In:** their response | Their RSVP (accepted, declined) becomes the attendee's response here. Deleting the event counts as declining. | Graph has no RSVP on one's own copy: deleting it, or marking it free, counts as declining. |
| **In:** busy | `freeBusy` for the next 14 days. | `calendarView` (not free, not cancelled) for the next 14 days. |

- **Scope of sync:** scheduled meetings the person hosts, or attends and hasn't declined, ending in the future and starting within 60 days.
- **When:** a reconciliation job every 5 minutes (`calendar-sync`), plus **Sync now** on the page. It compares each person's meetings with `calendar_event_links` (the last pushed `ics_sequence`), so no outbox is needed. A meeting that is cancelled, declined, or that the person was removed from is taken out of their calendar if it's still upcoming; past ones stay as history.
- **Busy times** are stored as start and end only (`calendar_busy`), never titles. The schedule form shows "Busy at this time (from their calendar): …".

## Security

- **OAuth:** authorization-code flow with **PKCE (S256)** and a random `state`. The state is stored hashed in `calendar_oauth_states` (10 minutes, single use) together with the verifier.
- **Callback:** `GET /calendar/oauth/callback` is public by design (a browser redirect with no session). It looks the state up through a `SECURITY DEFINER` function, is rate limited (`oauth` bucket), and redirects back to the web page with a short result code. It never shows provider error text.
- **Tokens:** access and refresh tokens are **sealed with a fresh data key wrapped by the document key provider** (KMS in AWS, purpose `calendar`, context = organisation + connection id). Tokens are refreshed shortly before expiry and re-sealed. A refused refresh marks the connection `ERROR` with "Connect the calendar again".
- **Never logged:** tokens, provider response bodies and event content. Errors carry only the HTTP status.
- **Scopes:**
  - Google: `openid email calendar.events calendar.freebusy`.
  - Microsoft: `openid email offline_access Calendars.ReadWrite`.
- **Disconnect:** removes our upcoming events from their calendar (best effort), revokes the Google grant (Graph has no revoke endpoint), and deletes tokens, links and busy times. Audited.
- **Production:** overriding provider URLs (used for the test fakes) is refused.
- **Tables:** all four have `org_id` and forced RLS.

## Configuration

- **Settings:** `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `MICROSOFT_OAUTH_CLIENT_ID/SECRET`, `MICROSOFT_OAUTH_TENANT` (default `common`), and `CALENDAR_OAUTH_REDIRECT_URL`, which is the redirect URI to register with each provider.
- **Terraform:**
  - The client IDs are variables, and a provider is off while its ID is empty.
  - Each enabled provider gets a client-secret entry in Secrets Manager, injected into the tasks. An empty secret would stop tasks from starting, which is why disabled providers get none.
  - Google's app needs verification for the `calendar.events` scope before it can be used outside test users.

## Tests

`calendar-sync-e2e.test.ts`, with fakes of both providers that verify PKCE and bearer tokens:
- both providers offered;
- connect through the real redirect, tokens not stored in plain text, state single use, audited;
- import with our UID and the host as organizer;
- a reschedule updates rather than duplicates;
- accept and decline come back, and a declined meeting leaves the calendar;
- busy times;
- Outlook create without attendees, idempotent, and removed on cancel;
- refresh, and a revoked grant gives ERROR;
- disconnect;
- production URL guard and unknown providers;
- RLS.

## Limits

- Only the primary calendar.
- Changes the person makes to time or title in their own calendar are not pulled back (the host owns the meeting).
- Recurring meetings sync as their next occurrence (the meeting row).
- Pull is periodic (5 minutes), not push notifications or webhooks.
