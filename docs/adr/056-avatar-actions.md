# ADR 056: Avatar actions: sit, jump, wave, dance, hug and high five

Date: 2026-11-13. Status: proposed (built and tested locally on `feature/office-campus-expansion`; not pushed, not deployed).
Related: FR-VO-002, FR-VO-003, FR-VO-004, FR-VO-014 (emotes); ADR 015, 048, 053, 055.

## Context

People in the office should be able to sit on chairs, jump, wave, dance, and hug or high-five a
colleague, and see each other do it. Movement, collision, room permissions, teleports,
attendance, work time, meetings, authentication, LiveKit and the schema must not change. Hug
and high five involve another person, so they need that person's explicit consent.

## Decision

1. **Server-checked, on the existing office socket.** These new events act only on the caller's
   own avatar, in the caller's own organisation's world, found through the authenticated socket:
   - `office:action` (`jump`, `wave`, `dance`, `stop`);
   - `office:sit` / `office:stand`;
   - `office:pair`, `office:pair-answer`, `office:pair-cancel`.

   Every body is a strict Zod schema. Solo actions and sitting are limited to 8 per 5 s per person;
   a pair request to one per 3 s, with one outstanding at a time.
2. **What everyone sees travels in the roster.** `RosterEntry.action` is
   `{ kind, since, with?, seat?, facing? }` or null. It goes to `vo-org:<orgId>` only, so it never
   reaches another organisation, and it is never part of the 10 Hz position stream. The world ends
   timed actions on its tick (jump 0.6 s, wave 1.8 s, hug 2.2 s, high five 1.3 s, dance at most
   30 s). Sitting lasts until the person stands, walks or teleports.
3. **Seats come from the map.** `mapSeats(map)` (shared) lists desk chairs, chairs above and below
   meeting tables, either side of café tables, and above and below chess and game tables: 90 on
   the default map. Only walkable points count. The painter draws chairs at exactly these points,
   so every chair shown can be sat on.

   Sitting needs all of the following:
   - the chair exists on the person's floor;
   - it is free (occupancy is read from the avatars, so it frees itself when the sitter leaves);
   - it is within 48 px;
   - the straight line to it is walkable;
   - it is in a room the person may enter.

   Reach is shorter than a wall plus two avatar radii (52 px), so no chair can be reached through a
   wall. The server places the avatar on the seat point. No position the collision map forbids is
   ever produced.
4. **Jump is cosmetic.** The sprite rises, but the avatar's position, collision box and room never
   change.
5. **Hug and high five need a yes.**
   - The request is refused unless both people are on the same floor, in the same room, and within
     80 px. It is also refused if the other person is away, set to Do not disturb, or already has a
     request open.
   - The person asked sees "… would like a hug" with Accept and Decline. The asker sees
     "Waiting…" with Cancel.
   - The request lapses after 15 s (`OFFICE_PAIR_TTL_MS` shortens it in tests).
   - On acceptance, reach is checked again, then both avatars play the action facing each other.
   - Decline, cancel, timeout, too far, and leaving all close the request for both people with a
     reason.
6. **Cleanup.** When a person's last office socket goes (leave or drop), their action is cleared at
   once, and requests to or from them close with "gone". The avatar's place in the office keeps
   the existing reload grace (ADR 048).
7. **Art.** Each of the six characters gets 14 original poses in the same generated spritesheet:
   - sitting ×4 facings;
   - wave ×2, dance ×2;
   - jump crouch and air;
   - hug and high five, left and right.

   The renderer swaps poses in the Pixi ticker. It adds a lift for the jump, a slight sway for the
   dance, and a small heart, sparkle or note drawn once per change. Under
   `prefers-reduced-motion`, poses still show but without lift, sway or alternation. My own
   jump, wave or dance starts at once on my screen; the server's echo of it is not played a
   second time.
8. **Controls.**
   - **E:** sit on the free chair in reach, or stand up. A nearby game still comes first (ADR 055).
   - **Space:** jump.
   - **Actions button over the map:** a menu (arrow keys, Escape) with Sit or Stand, Jump, Wave,
     Dance or Stop dancing, and "Friendly hug…" and "High five…", which list the colleagues in
     reach.
   - **Stop dancing:** a visible button for as long as the dance lasts.

   All of it works by touch on a phone.

## Consequences

- Nothing here writes to the database or touches attendance, status, work time or meetings. An
  end-to-end test checks that attendance sessions and segments are unchanged.
- Action state is in memory per API instance, like the rest of the office world (ADR 015). It would
  need the Redis-backed world before the office runs on more than one instance.
- The spritesheet grows from 12 to 26 columns (832 x 192 px). It is still one texture per renderer.
- Tests:
  - `apps/api/test/office-actions.test.ts`: seats, sitting rules, pair reach, the tick;
  - `apps/api/test/office-actions-e2e.test.ts`: the socket protocol, organisation isolation, rate
    limits, consent, decline, cancel, timeout, Do not disturb, disconnect, and attendance untouched;
  - `apps/web/e2e/45-office-actions.spec.ts`: two people in browsers, sitting, reduced motion, a
    dropped connection, and the phone layout.
