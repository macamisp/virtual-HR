# ADR 016: Media and meetings (LiveKit)

**Status:** Accepted
**Date:** 16 October 2026
**Requirements:** SRS 5.4 FR-MEET-001, 002, 003, 004, 005, 008, 009, 010 (basic), 011; 5.3 FR-VO-005, 009, 010; 3.3C; 7.4 meetings, meeting_participants.

## 1. Decisions agreed with the product owner

| Topic | Decision |
| --- | --- |
| Packages | **Client SDK only:** `livekit-client` 2.22.3, exact-pinned, in `apps/web`. No `livekit-server-sdk`: access tokens, webhook verification and the room service calls are written by hand with `jsonwebtoken` (already a dependency) and `fetch` (`apps/api/src/media/livekit.ts`). `.ics` files and RRULEs are written by hand (`meetings/ics.ts`). |
| Server | `livekit/livekit-server:v1.9.1` in Docker Compose for local development (`infra/livekit/livekit.dev.yaml`, host networking, dev key). Production keys come from the environment; `liveKitConfig()` refuses the dev secret when `NODE_ENV=production`. |
| Proximity | **One LiveKit room per proximity group** (`prox-<org>-<group>`). A token is issued only for the caller's own current group, as the in-memory office world knows it. |
| Hosts | **Host + co-hosts.** Hosts name co-hosts; both admit from the lobby, mute everyone and remove people. Invited people skip the lobby. Room meetings (closed office rooms) have no lobby; `org.manage` moderates them. |

## 2. Tokens: the server picks the room (token scoping)

`POST /media/token` takes only *what the token is for* (`{kind:'room'}`, `{kind:'proximity'}` or `{kind:'meeting', meetingId}`, strict schemas: no extra fields). The client can never name a LiveKit room.

- **room:** the avatar must currently stand inside a non-OPEN room (server position). Outside the office or in an open area: 409.
- **proximity:** the caller must be in a proximity group right now: otherwise 409.
- **meeting:** goes through the same rules as `POST /meetings/:id/join`; anything but READY (lobby WAITING, DENIED, not visible) gives no token.

Tokens are HS256 JWTs (`iss` = API key, `sub` = user id, `video` grant with that one room, `roomJoin`, publish/subscribe/data, sources camera, microphone, screen share). They live **10 minutes**. They are never logged. Moderation never goes through participant grants; it is done by the API with the room service.

## 3. Webhooks: attendance from the server clock

LiveKit posts events to `POST /media/livekit/webhook` (public by design; listed in `scripts/route-permissions.mjs`). The raw body is kept (1 MB limit) and verified: the `Authorization` JWT must be signed with our key and its `sha256` claim must equal the SHA-256 of the body. Unknown or foreign-org rooms are ignored.

- `participant_joined` → meeting LIVE (first time), a `meeting_participants` row with `joined_at = now()` (database clock, UTC).
- `participant_left` → `left_at`, `duration_seconds`.
- `room_finished` → open rows closed; the meeting ENDED (a recurring one goes back to SCHEDULED for the next occurrence).
- Office rooms: the first join creates a ROOM meeting (`<office room livekit name>#<timestamp>`; at most one live per room, unique index).
- Proximity rooms produce no meeting rows.

Client times are never used. **Attendance:** the browser sets `inCall` while any LiveKit connection is open (`media-session.ts` counts connections); the heartbeat worker sends it, and the attendance state machine (ADR 001) turns it into IN_MEETING and credits `meeting_seconds`. Proximity calls are credited this way only.

## 4. Meetings (FR-MEET-001, 002, 003, 008)

- **INSTANT** — starts at once; invitees get a `meeting:ring` socket event.
- **SCHEDULED** — start/end (≤ 12 h), optional RRULE subset (DAILY/WEEKLY/MONTHLY, INTERVAL, COUNT or UNTIL, BYDAY). Attendees get an email with a `METHOD:REQUEST` `.ics` attachment (UID per meeting, SEQUENCE bumped on reschedule, lines folded at 75 octets). Cancel sends `METHOD:CANCEL` and deletes the LiveKit room. Accept/decline is recorded.
- **ROOM** — created by the webhook when people talk in a closed office room.
- Visibility: host, attendees, anyone who took part or waited in the lobby, and `org.manage`; others get 404. A shared join link still lets an uninvited person *ask to join* (the web page falls back to that on 404).
- Notes (Markdown) may be edited by anyone in the meeting; the other fields by host/co-hosts only; optimistic `version` check.
- Action items (assignee must be the host or an attendee) **convert into tasks through `TasksService.create`**, so the normal task assignment rules apply: a host who may not assign tasks to that person gets 403. This is deliberate (see the open question below).

## 5. Lobby and host controls (FR-MEET-005)

`meeting_lobby` (WAITING / ADMITTED / DENIED). An uninvited person who joins a lobby meeting is WAITING; hosts and co-hosts get `meeting:lobby` and decide; the person gets `meeting:lobby-decision` and joins on admit. **Mute all** calls `MutePublishedTrack` for every microphone except the caller's. **Remove** sets the lobby entry to DENIED (no re-entry) and calls `RemoveParticipant`. All audited.

## 6. Browser (FR-MEET-004, 010, 011; FR-VO-005, 009, 010)

- `MediaSession` wraps a `Room`: echo cancellation, noise suppression and auto gain; simulcast, dynacast, adaptive stream, DTX/RED; a connection-quality value per tile; **automatic audio-only** when the local connection becomes Poor (or by choice).
- **Pre-join check:** camera preview, live microphone level, speaker test tone (with `setSinkId` where supported) and device choice, remembered in `localStorage`.
- Call view: tiles with speaking ring, mute and hand indicators; a shared screen takes the stage (presentation mode); controls for mic, camera, screen share, raise hand (LiveKit data, topic `hrvo`), audio-only, leave; host controls and the lobby panel.
- **Office:** after the user turns media on, walking into a closed room joins its call, standing near people in the open area joins the group call (debounced 600 ms; one retry when the server's grouping lags a tick). Volume falls off with distance (1 → 0.15 at the edge of the radius). Room-only mode keeps proximity off.
- **Broadcast** (FR-VO-010): `POST /office/broadcast` (`office.broadcast`: admins, HR, managers) pushes `office:broadcast` to the organisation; audited.
- Web hardening changed: `Permissions-Policy` now allows `camera`, `microphone`, `display-capture` and `speaker-selection` for the app's own origin (it had blocked them); CSP `connect-src` adds `NEXT_PUBLIC_LIVEKIT_URL` (ws and http).

## 7. Tests

- API (`meetings-e2e.test.ts`, against a real LiveKit): token scoping (no token for a knock room from outside, for someone else's group, for an uninvited lobby meeting, or with extra fields), tokens accepted by LiveKit's `/rtc/validate`, forged and tampered webhooks rejected, webhook attendance, invites and `.ics`, lobby, mute all, remove, action items to tasks, broadcast. `meeting-rules.test.ts`: ICS escaping, folding, RRULE, next occurrence.
- Playwright (`17-meetings.spec.ts`) with Chromium's fake camera and microphone: ring → pre-join (real frames, moving level meter) → two people see each other, hand raise, webhook attendance rows; lobby admit and host remove; office proximity call and screen share.

## 8. Not done / limitations

- **Background blur** is not done: it needs `@livekit/track-processors` (a new package).
- Recording, transcription and breakout rooms are out of scope.
- The office world (and so proximity tokens) is in one API instance (ADR 015).
- Open question for the product owner: FR-MEET-008 says action items become tasks; with the task rules a host cannot create a task for someone outside their reports. We kept the task rules.
