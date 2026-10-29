# ADR 044: The office audio route follows the server's room, by room type

Date: 2026-10-29. Status: accepted. Requirements: FR-MEET-002, FR-VO-004, FR-VO-005.
Related: ADR 015 (office), ADR 016 (media).

## Problem

Two people inside the same meeting room could not hear each other; in the open area they could.
Reproduced on the public demo with two browsers (LiveKit Cloud, synthetic microphones, WebRTC
`getStats`): in Meeting room A/B both clients asked for a *proximity* token, the server answered
409 "Nobody is near you" twice, no call was made and no audio packet arrived. Two client bugs:

1. **The client never learnt its own room while walking.** `OfficeClient.self.roomId` was set only
   by the join and teleport acks. A successful `office:move` ack was `{ ok: true }`, so walking
   through a door left the client in its old room (the "in Reception" label stayed too) while the
   server had moved the avatar into the room's group (`room:<id>`).
2. **Client and server classified rooms differently.** `mediaTarget` asked for a room call only when
   `accessMode !== 'OPEN'`; the server's grouping and `MediaService.roomToken` use
   `type !== 'OPEN'`. Meeting rooms A–C are `MEETING` with `OPEN` access, so even after a teleport
   the client asked for a proximity call that the server (correctly) refuses inside a closed room.

The server's rules were right and stay unchanged: room tokens only for the room the server has the
avatar in, knock/invite/password checks, `room:` groups never get proximity tokens.

## Decision

1. `packages/shared` owns the rule: `isClosedRoom(room)` is `type !== 'OPEN'` (access mode only
   decides who may walk in), and `mediaRoute(...)` picks room call, proximity call or none. The
   server's tick and room token, and the client's `mediaTarget`, all use them.
2. Both `office:move` acks carry the server's `roomId` (`{ ok: true, roomId }` and the correction).
   The client sets `self.roomId` from it, and from `office:presence` entries about itself.
3. A reload or a dropped connection that closes the last socket still removes the avatar; the next
   join starts at the desk or spawn and the route follows the join ack. A short network blip that
   keeps the socket keeps the room (verified with a 6 s drop).

## Consequences

- Walking into any closed room (meeting rooms included) joins its LiveKit room; walking out leaves
  it; two rooms never share a call; the open area keeps distance-based proximity calls.
- Regression tests: `office-rules` (route and server grouping agree for every room),
  `meetings-e2e` (walking through a door: acks, same LiveKit room for both, 403 outside, other room
  separate, repeated transitions, simultaneous entry, reload), `office-e2e` (correction carries the
  room), Playwright spec 34 (real audio RTP in a meeting room, leaving by walking, isolation).
- Not changed: a reload puts the user back at their desk, not in the room they were in.
