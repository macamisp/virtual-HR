# Traceability: Meetings (SRS 5.4)

Meetings, media and the lobby: ADR 016 (tests: meetings-e2e, meeting-rules, Playwright 17). Calendar sync: ADR 023 (calendar-sync-e2e).

## Recording with consent (ADR 024)

| Requirement | Implementation | Tests |
| --- | --- | --- |
| FR-MEET-007 recording to encrypted storage | `recordings.service.ts` process (AES-256-GCM, KeyProvider purpose `recording`), `media/livekit.ts` Egress client | recordings-e2e "stopping hands the file to processing", Playwright 22 |
| FR-MEET-007 visible banner | `RecordingBanner` in `recording-ui.tsx`, `Meeting.recording`, socket `meeting:recording` | Playwright 22 |
| FR-MEET-007 recorded-consent log; all-participant consent; late joiners | `recording-rules.ts` consentOutcome, `recording_consents` (insert-only), join gate `CONSENT_REQUIRED`, `enforceOnJoin` | recording-rules, recordings-e2e consent, late joiner, refusal, expiry, withdrawal |
| FR-MEET-007 retention and ACL | `retention_recordings_days`, `maintenance` crypto-shred, `canWatchRecording` | recordings-e2e "watch", "crypto-shredded", RLS |
| SRS 13 off by default; FR-ADM-004 recordings as a data type | `organizations.recording_enabled`, `/admin/recording`, Admin → Data retention | recordings-e2e "is off by default", admin-e2e retention, Playwright 22 |

## Office calls and the meeting chat (ADR 035)

| Requirement | Implementation | Tests |
| --- | --- | --- |
| FR-VO-008 / FR-MEET-001 ring-and-accept from an avatar and the people list; decline; missed; busy | `meetings/calls.service.ts` (`meeting_calls`, 45 s ring, `call-expiry` job), `POST /meetings/:id/accept|decline|calls/cancel`, `GET /meetings/incoming`, `GET /meetings/:id/calls`; people list **Call**, avatar overlay menu (`components/office/avatar-actions.tsx`), ring alert, caller's call responses | meetings-e2e "Ring decisions and meeting chat" (decline is final, missed once, busy, 12-hour bound, caller name, tenant isolation), Playwright 25 and 17 |
| FR-MEET-005 / 012 / 013 meeting chat with mentions and scanned file sharing | `chat.service.ts` `meetingChannel` (one persisted channel per meeting, membership follows the meeting), `POST /meetings/:id/chat`, `components/meeting-chat.tsx`, Chat toggle | meetings-e2e "keeps one persisted chat per meeting…", Playwright 25 (mention, two-way chat, persisted after leaving) |
