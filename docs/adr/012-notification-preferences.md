# ADR 012: Notification Preferences, Quiet Hours and Email Templates

**Status:** Accepted
**Date:** 16 October 2026
**Requirements:** SRS 5.9 FR-NOTIF-001 (centre, already in ADR 007), FR-NOTIF-002 (templates, unsubscribe), FR-NOTIF-004 (preferences by type and channel, quiet hours in the user's timezone).

## 1. Model

- **Preferences can only switch channels off.** Each feature decides which events are emailed (`email: true` on the event); a preference never adds an email the feature did not ask for. A missing row means both channels on, so `notification_preferences` holds only the exceptions.
- **Critical types** (`NOTIFICATION_TYPE_META[...].critical`: malware found, document-password lockout and recovery, share-link lockout) ignore preferences and quiet hours and cannot be unsubscribed. They are security notices.
- **Quiet hours** are stored on `users` as minutes after local midnight (`quiet_hours_start`, `quiet_hours_end`), evaluated in `users.timezone`, falling back to the organisation's zone. The window may cross midnight.
  - During quiet hours an email is **held**, not dropped: the row gets `email_after` = the window's end. The in-app notification and socket push happen at once.
  - The `deferred-emails` job (every minute) releases rows whose `email_after` has passed and hands them to delivery. The sender's atomic claim (`emailed_at IS NULL` and `email_after IS NULL OR <= now`) means a release raced by two instances still sends once.
- **In-app off, email on:** the row is created with `in_app = false` so the sender has something to claim and the history is complete, but the centre and the unread count never show it.
- `users.timezone` is new and validated against `Intl.supportedValuesOf('timeZone')`. Reports (slice 3) will use it too.

## 2. Emails (FR-NOTIF-002)

- `email-templates.ts` renders every notification email: greeting by display name, the event text, the deep link, and a footer saying which organisation sent it. Non-critical mails carry a one-click unsubscribe link for that type and a link to the settings page; critical mails say they are always sent.
- Subjects are `[Org name] title`. Plain text only, because the SMTP transport is text-only; a production provider (SES/Resend) can add HTML later without changing the data.
- **Unsubscribe token:** `v1.<base64url(org.user.type)>.<HMAC-SHA256>` signed with `JWT_SECRET`, verified in constant time. It carries no expiry on purpose (links in old mails must keep working) and can only ever turn *email* off for *one type* of *one user*, so a leaked link is at most a nuisance. The web page keeps the token in the URL fragment so it never reaches server logs; the API route `POST /notifications/unsubscribe` is public and rate-limited (`RATE_LIMIT_UNSUBSCRIBE`, default 20/min).
- Confidential document titles still never reach emails (ADR 010).

## 3. Routes and UI

- `GET`/`PUT /notifications/preferences` (any signed-in user, own settings only). `PUT` replaces the whole set; it refuses unknown zones, equal quiet-hour bounds, duplicates and any attempt to switch a critical type off. Changes are audited (`NOTIFICATION_PREFERENCES_UPDATED`, `NOTIFICATION_UNSUBSCRIBED`).
- Web: `/account/notifications` (timezone, quiet hours, a per-type table with in-app and email boxes; critical rows disabled) and the public `/unsubscribe` page.

## 4. Migration `20261021000000_notification_preferences`

- `users.timezone`, `quiet_hours_start`, `quiet_hours_end` with a CHECK (both null, or both 0–1439 and different).
- `notifications.email_after`, `notifications.in_app`, index on `(org_id, email_after)`.
- `notification_preferences` (PK `user_id, type`) with RLS forced and a same-organisation trigger.

## 5. Tests

- `notification-rules.test.ts`: quiet windows (same day, across midnight, same instant quiet in one zone and not another), channel resolution including critical types, token round-trip and tampering.
- `notification-preferences-e2e.test.ts` (16 tests): defaults; validation; in-app-off still emails but stays out of the centre; both-off creates nothing; critical ignores everything; quiet hours hold the email, the sender refuses it early, the job sends it after the window, and the mail has the template footer with the link; RLS and the same-org trigger; unsubscribe from the real email link, idempotent, tampered/critical/unknown/cross-org tokens refused, nobody else affected; the settings page can turn email back on while an old link cannot.
- Playwright `13-notification-settings.spec.ts`.

## 6. Known gaps

- No digest (FR-NOTIF-006), web push (003) or Slack/Teams (005).
- Quiet hours apply to email only; in-app pushes still arrive, by design.
- The deferred-emails job runs per API instance through BullMQ's de-duplicated scheduler, like the other jobs.
