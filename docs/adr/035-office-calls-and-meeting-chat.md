# ADR 035: Ring-and-accept calls from the office, and the meeting chat

**Status:** Accepted
**Date:** 19 October 2026
**Requirements:** FR-VO-008 (call a colleague with a ring-and-accept flow), FR-MEET-001 (instant call from an avatar or the people list), FR-MEET-005 (chat among the in-meeting controls), FR-MEET-012 (mentions), FR-MEET-013 (file sharing through the document module with virus scanning).

The migration `20261102000000_office_calls_chat` says "ADR 031" in its header; that number was taken in parallel by teams (ADR 031 on `feat/org-people`). Applied migrations are not edited (their checksum would change), so this is the ADR it refers to.

## Decision

**Calls are server state** (`meeting_calls`, one row per callee, RLS forced, same-organisation triggers). An instant call from the people list's **Call** button or an avatar's menu creates an INSTANT meeting and rings each callee for 45 seconds.

| State | When |
| --- | --- |
| `RINGING` | created; the callee gets `meeting:ring` and an alert "<caller> is calling you" with **Accept** / **Decline** |
| `ACCEPTED` / `DECLINED` | the callee's decision; final (a second answer is 409) |
| `MISSED` | nobody answered in 45 s; the callee gets a `CALL_MISSED` notification once (dedupe key) and an audit entry. The `call-expiry` job runs every 5 s; with jobs off, the next read expires due calls |
| `BUSY` | the callee was already in a call when it started: not rung, the caller sees it |
| `CANCELLED` | the caller pressed **Cancel call** (`POST /meetings/:id/calls/cancel`) |

Both sides get `meeting:call-state` on every change; the caller's meeting page shows each callee's state.

**Who is busy.** Connected to another meeting that is live, joined within the last 12 hours and with no "left" event; or accepted another call and not connected to it yet. The 12-hour bound stops a lost LiveKit webhook from marking someone busy for good. Only callees are busy: the caller is never blocked from starting a call, and joining a meeting is never refused for being "in another call", because LiveKit reports "left" some seconds after a call ends and that lag must not refuse people who just hung up. (The first version blocked all three; the end-to-end tests showed the false refusals.)

**Meeting chat.** One persisted conversation per meeting (`channels.meeting_id`, a GROUP channel). Its members follow the meeting (host, attendees, participants, admitted lobby guests; not denied ones); membership cannot be edited by hand, and the channel cannot be archived or left separately. Messages support mentions; a file is shared by picking a document the person manages that the virus scan has passed (`CLEAN`): the server checks the status again, grants the channel members access, and logs the share in the document access log. The chat opens with **Chat** in the call controls, or on the meeting page outside a call.

**Keyboard and screen readers.** The office map is a canvas, so every other person's avatar gets a focusable button laid over it ("Avatar actions for …"). Click, right-click, Shift+F10 or the Menu key opens a menu (Call, Go to); arrow keys, Home and End move, Escape closes and returns focus, Tab and a click outside close it.

## Consequences

- Answering and calling navigate from the request's promise, not from a per-call `onSuccess`: the server's call-state event can unmount the ring alert (or close the avatar menu) before the response arrives, and the callbacks of an unmounted component never run.
- Not done: group calls from the people list (one person per call there; the meetings page still starts group calls), and uploading a new file directly from the chat (the picker links to Documents).
