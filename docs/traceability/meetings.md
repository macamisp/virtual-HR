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
