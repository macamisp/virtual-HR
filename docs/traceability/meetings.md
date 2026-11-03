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

## The call and the office presence survive navigation (ADR 048)

| Requirement | Implementation | Tests |
| --- | --- | --- |
| FR-VO-005 / FR-MEET-002 the call keeps going on every page; one session for the office and `/meetings/[id]` | `lib/media/call-controller.ts` (one `MediaSession` and one `OfficeClient` per tab, `current` = office route or meeting), `components/media/call-provider.tsx` mounted by `AppShell`, `CallAudio` (remote audio once per tab) | Playwright 36 (B keeps receiving A's audio and video while A is on `/attendance` and `/tasks`; Return to office without a new `/media/token`), 17, 25, 34, 35 |
| FR-VO-002 / FR-VO-003 presence stays; "away from the office view" for others | socket `office:view`, `Avatar.sockets[].viewing`, `RosterEntry.away`, position tuple element 8, map (faded, dashed ring, "away" badge), people list text; `OFFICE_LEAVE_GRACE_MS` reload grace | office-e2e "away from the office view", "a dropped connection keeps the avatar for the grace"; Playwright 36 |
| FR-MEET-005 controls on every page: floating dock (tiles with speaking ring and hand, mute, camera, share, raise hand, leave, return), draggable, keyboard, `aria-live` status, inside the viewport | `components/media/call-dock.tsx`, `lib/media/dock-store.ts` (alerts move above it) | Playwright 36 (dock present with every control on `/attendance` and `/tasks`; mute and raise hand seen by B) |
| One tab owns the call; take over | Web Lock `hrvo-call-owner` in `call-controller.ts` (`acquire`, `takeOver`, `onTaken`), "This call is open in another tab" in `office-media.tsx` and the meeting page | Playwright 36 (second tab does not double-join; take over moves the call; the first tab leaves) |
| Hidden tabs keep the call; Document Picture-in-Picture; devices released on leave, sign-out, revoke, reload | no `visibilitychange` handling; `CallDock` "Float over other tabs" (`documentPictureInPicture`, in-page dock elsewhere); `AppShell.signOut` → `shutdown()`, `CallProvider` on `status === 'anonymous'`, LiveKit `pagehide` | Playwright 36 (no live local tracks after Leave and after sign-out; reload rejoins the same room call) |
| FR-ATT-006 / FR-MEET-009 a call is a meeting segment: `inCall` heartbeats open `IN_MEETING` (never idle), leaving credits `meeting_seconds`, a session closed mid-call keeps it; keeps counting on other pages; sign-out ends the call | `attendance-state-machine.ts` `handleHeartbeat` (rows 6/7 from the heartbeat), `closeLastSegment` credit; `MediaSession` active counter → `usePresenceStore.inCall` → heartbeat worker (page-independent) | attendance-state-machine "ADR 048: a call reported by the heartbeat" (5), agent-companion; Playwright 36 (`presence_events` heartbeats with `inCall` and `IN_MEETING` while on `/tasks`; the Meeting total grows; Active again after Leave) |
| "Mute my microphone when I leave the office page" per user | `users.vo_mute_on_leave`, `GET /office` `me.muteOnLeave`, `PUT /office/me/preferences`, checkbox in the office Audio and video card, `CallController.setOfficeView` | office-e2e "call preferences" (default off, saved per user, validated) |
