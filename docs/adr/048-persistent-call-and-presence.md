# ADR 048: The call and the office presence survive navigation; floating call dock

Date: 2026-11-03. Status: accepted. (Numbered 046 in the first commit of this work; renumbered because the staging release branch had already taken 046 and 047.) Requirements: FR-VO-002, FR-VO-003, FR-VO-005, FR-MEET-002,
FR-MEET-005, FR-MEET-009, FR-ATT-006. Related: ADR 015 (office), ADR 016 (media), ADR 044 (room
audio route), ADR 045 (screen viewer).

## Problem

The LiveKit session and the office Socket.IO connection were owned by the page components
(`OfficeMedia` on `/office`, `MeetingCall` on `/meetings/[id]`). Going to any other page unmounted
them: the call dropped, the avatar vanished for everyone, the attendance `inCall` flag went false
and meeting time stopped counting. People expect what Google Meet does: the call keeps going, a
small window follows them, and they come back to the same conversation.

## Decision

### 1. One controller above the pages

`apps/web/src/lib/media/call-controller.ts` is a framework-free singleton (`subscribe`/`getVersion`
like `MediaSession` and `OfficeClient`) created by `CallProvider`, which `AppShell` mounts once
the session is restored and the monitoring notice accepted. It owns:

- the one `MediaSession` (LiveKit) of the tab;
- the one `OfficeClient` (office socket, position, roster, proximity, knocks), created the first
  time the office page hands it a snapshot and kept until **Leave the office**, sign-out or a
  session revoke;
- `current`: what the session is for, `{ kind: 'office', key }` (a room or a proximity group,
  chosen by `mediaRoute` as in ADR 044) or `{ kind: 'meeting', meetingId }`;
- the device preferences chosen in the pre-join check, and whether office audio/video is on
  (`sessionStorage`, as before).

The office auto-join (walk into a room → room call; stand near people → proximity call) runs inside
the controller from the office client's changes, debounced 600 ms, on every page. A meeting call
takes precedence: while `current.kind === 'meeting'` the office route is ignored, and when the
meeting is left the office route is applied again. Joining a meeting from the office, or walking
the office while in a meeting, therefore never opens a second session: `MediaSession.connect`
disconnects the previous room first, and there is exactly one `MediaSession` per tab.

Pages render from this shared state. `/office` recreates its Pixi canvas on every visit; the
client, the socket and the position are untouched. `/meetings/[id]` shows the call when
`current` is that meeting, so coming back to it shows the running call without a new join.
The remote `<audio>` elements live in the provider (`CallAudio`), rendered once, so sound plays on
every page and never twice.

### 2. Presence while away from the office view

The office socket stays connected on other pages, so the avatar stays where it was and the server's
proximity and room rules keep applying to it. The client tells the server whether the office view
is shown (`office:view { visible, positions }`); the server marks the avatar **away from the office
view** when none of its sockets shows it. The flag travels as `RosterEntry.away` and as the eighth
element of the position tuple. The map draws such avatars faded with a dashed ring and an "away"
badge; the people list says "away from the office view". The attendance-driven status ring is
unchanged (FR-VO-003 stays truthful).

`positions` is sent as `false` while the map is not shown, so a tab on `/tasks` does not receive
the 10 Hz position stream; the server forgets what that observer has seen so the map is complete
when it comes back.

**Reload grace (server).** When the last socket of an avatar drops without `office:leave`, the
avatar is kept for `OFFICE_LEAVE_GRACE_MS` (default 8 s, 0 disables) and removed by the world tick
if nobody rejoins. A reload therefore comes back to the same spot and the same room call. The
place is kept for the login session family that dropped (stable across refresh rotations, so a
reload qualifies): a fresh sign-in during the
grace starts at the desk or the reception as always, so nobody is put back into a room by a
previous session. An explicit leave (Leave the office, sign-out) removes the avatar at once, as
before.

### 3. Floating call dock

`components/media/call-dock.tsx` is mounted by the provider on every page except where the full
view is already shown (`/office` during an office call, `/meetings/<id>` during that meeting). It
shows the participants (initials or camera, speaking ring, hand), the microphone and camera state,
and the controls: mute, camera, share screen, raise hand, leave, and **Return to office** /
**Return to meeting**. It is a `role="dialog"` region that is draggable with the pointer and with
the arrow keys on its handle; its position is remembered per browser and clamped to the viewport
on resize, so it stays on screen on a phone. Its status line is `aria-live="polite"`. The default
corner is bottom-right, and the incoming-call alerts move up above it so a ring is never hidden.

### 4. One tab owns the call

Like the heartbeat leader, the call owner holds the Web Lock `hrvo-call-owner`. A tab that wants
to connect asks with `ifAvailable`; when another tab holds it, the tab shows "This call is open in
another tab" with **Take over** (`steal: true`), and the previous owner, whose lock request is then
aborted, leaves the call and shows that it was taken over. Without Web Locks (old browsers) the
tab connects and the server-side single-identity rule of LiveKit applies.

### 5. Hidden tabs, picture-in-picture, releasing devices

Nothing reacts to `visibilitychange`: LiveKit keeps the connection in a background tab, and the
heartbeat worker keeps reporting `inCall`. Where the Document Picture-in-Picture API exists
(Chromium), **Float over other tabs** moves the dock into a PiP window that stays visible over other
tabs and apps; the dock comes back to the page when the window closes. Elsewhere the in-page dock
is the fallback.

Camera, microphone and screen tracks are stopped by `room.disconnect()` (LiveKit stops local tracks
on unpublish) in every end-of-call path: Leave, Leave the office, sign-out (`AppShell` shuts the
controller down before `POST /auth/logout`), session revoke (the provider watches the auth store
and shuts down when it turns anonymous), and reload (LiveKit's own `pagehide` handler). The Web
Lock is released with the document, so a reloaded tab becomes the owner again.

### 6. Attendance: a call is a meeting segment

`MediaSession` keeps counting the connected session into `usePresenceStore.inCall`, which the
heartbeat worker sends (ADR 016). Because the session now outlives the page, `inCall` stays true
while the person works on another page and drops within one heartbeat of leaving the call.

Until now `inCall` only kept the state `ACTIVE` (FR-ATT-006); nothing entered `IN_MEETING` or
credited `meeting_seconds` (the `joinMeeting`/`leaveMeeting` hooks of ADR 001 were never called;
FR-MEET-009 open). The state machine now applies SRS 6.2 rows 6 and 7 from the heartbeat:
`inCall` while `ACTIVE`, `IDLE` or `PAUSED` closes the current segment and opens an `IN_MEETING`
segment without a meeting id; a heartbeat without `inCall` closes it, credits `meeting_seconds`
and goes back to `ACTIVE`. In-call heartbeats never go idle or paused. A segment opened by the
meetings hook (with a meeting id) is still only closed by that hook. `closeLastSegment` credits an
`IN_MEETING` segment whenever it ends, so a session closed mid-call (logout, timeout, midnight,
maximum length) keeps the meeting time. The live board, the tracking badge and the office status
ring therefore show "In meeting" during any call (FR-VO-003), and My attendance shows the
meeting total growing. Linking a meeting id (FR-MEET-009's "credited to the meeting") stays open.

Known limit: `inCall` is sent by the heartbeat leader tab; when another tab of the same browser
owns the call the flag is not sent (the two elections are independent).

### 7. "Mute my microphone when I leave the office page"

A per-user setting, off by default, in the office snapshot (`me.muteOnLeave`) and saved with
`PUT /office/me/preferences` (`users.vo_mute_on_leave`). When set, leaving `/office` during an
office call mutes the microphone; the dock shows the microphone and camera state at all times.

### 8. Idle recovery: the office socket outlives the access token (2026-11-03, V2 QA)

**Bug.** After a while in the office, sometimes only after a quiet period, the avatar froze: keys
did nothing and only a reload helped. Root cause, reproduced by Playwright spec 37 with a
two-minute token: at the access token's `exp` the gateway emits `auth:expired` and immediately
`disconnect(true)`s the socket (`AttendanceGateway.applyAuth`). Socket.IO never reconnects on its
own after a server-side disconnect or a refused handshake, and the office client only set
`connected = false`, so `OfficeClient.step()` returned early for ever. The shell refreshes the
session a minute before expiry, but nothing handed the new token to the office or UI sockets, and
a throttled background tab can refresh late anyway. The heartbeat worker already handled all of
this; the office and UI sockets did not.

**Fix (client only, no server change).** `OfficeClient` and `lib/ui-socket.ts` now: hand every
refreshed access token to the live socket (`auth:refresh`, which extends the server's expiry timer,
so an idle tab is not kicked at all); on `disconnect` with reason `io server disconnect`, or a
`connect_error` of `Unauthorized`, refresh the session if the token is within 30 s of expiry and
call `socket.connect()` (with a growing delay after repeated refusals); retry `office:join` after a
transient failure (`Forbidden` is final). Two hardenings found on the way: a move whose
acknowledgement never arrives (network drop mid-walk) no longer blocks every later move
(`inFlight` and the path are reset on disconnect and on join), and held movement keys are
forgotten when the window or tab loses focus, so a keyup lost to another window cannot keep the
avatar walking. No automatic page reload anywhere.

Found by repeating spec 37: the first version of this fix still answered `auth:expired` with
`auth:refresh`; the server disconnects right after emitting that event, so the reply never comes,
and the 10-second acknowledgement timeout then disconnected the socket that had meanwhile
reconnected (a teleport sent in that window was refused with "Join the office first"). Now
`auth:expired` is ignored (the disconnect handler does the work) and a late reply cannot touch a
socket that has reconnected since (`socket.id` is compared).

**Proof.** Spec 37: (1) A idles past the token's life, then walks and enters a room that B sees,
and B's call still rings on A's page (UI socket); (2) a network drop while a key is held, then the
walk reaches the server again (room entered and left by walking). The e2e API issues 120-second
tokens (`ACCESS_TOKEN_TTL_SECONDS`, new; default 15 min, minimum 60 s), which also makes every
longer spec (36 is three minutes in the office) cross an expiry.

## Consequences

- The automatic audio-only fallback (FR-MEET-010) now needs the connection to stay poor for 5 s;
  a single poor report right after connecting used to switch the camera off again (seen in spec 36).
- No new package. Server changes: `office:view`, the `away` flag, the leave grace, one column and
  one endpoint.
- Playwright spec 36 covers the brief end to end with two users and fake devices: audio and video
  keep flowing to the other person while the caller browses other pages; the away indicator;
  dock controls; Return to office without a new token; Leave ends the call for one person and
  stops the camera tracks; a second tab does not double-join and can take over; reload rejoins;
  sign-out ends the call; `meeting_seconds` increases while on `/tasks`.
- API tests (`office-e2e`): explicit leave removes at once, a dropped socket is kept for the grace
  and a rejoin keeps the position, the away flag, and the preference endpoint.
  `attendance-state-machine` "ADR 048: a call reported by the heartbeat" (five cases: ACTIVE and
  IDLE into the call, past the pause threshold, credit on leaving, hook-opened meetings untouched,
  credit on logout, timeout and midnight); `agent-companion` updated (a browser call next to an
  agent is `IN_MEETING`).
- The office socket now stays open while the user is anywhere in the app after visiting the office,
  until Leave the office or sign-out. It still uses purpose `office`, so it never keeps an
  attendance session alive (ADR 015).
