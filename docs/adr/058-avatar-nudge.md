# ADR 058: Avatar nudge: a bell for a colleague nearby

Date: 2026-11-15. Status: proposed (built and tested locally on `feature/office-avatar-nudge`; not pushed, not deployed).
Related: FR-VO-016, FR-VO-003 (status), FR-VO-008 (knock and call); ADR 015 (office), ADR 048 (presence), ADR 056 (avatar actions and consent).

## Context

People in the office want a light way to get the attention of someone standing near them: a bell
on the avatar, a notification the other person can accept or ignore, and a short sound. It must
not change attendance, work time, meetings, authentication, the schema or the existing avatar
actions, and it must not become a way to pester people or to reach another organisation.

## Decision

1. **On the existing office socket, modelled on the hug request (ADR 056).** New events:
   - `office:nudge { to }` from the sender, acknowledged with the nudge id or a refusal code;
   - `office:nudge-request` to the person nudged;
   - `office:nudge-answer { id, accept }` from the person nudged;
   - `office:nudge-cancel { id }` from the sender;
   - `office:nudge-closed { id, from, to, outcome }` to both people, once, with
     `accepted`, `ignored`, `cancelled`, `expired` or `gone`.

   Every body is a strict Zod schema (`packages/shared/src/office/nudge.ts`). Messages go to
   `vo:<userId>` only, so nobody else in the office sees a nudge. A nudge is separate from the
   hug and high-five requests: it never starts an avatar action.
2. **The server decides.** The sender and the person nudged are looked up in the sender's own
   organisation's world through the authenticated, joined socket (`office.use` is checked at
   join, as before). A nudge is refused, with a code, when:
   - it is to oneself (`SELF`);
   - the person is not in this organisation's office, which is also what another organisation's
     person looks like (`NOT_FOUND`);
   - they are not on the same floor and in the same room within the reach (`TOO_FAR`);
   - they are on Do not disturb (`DND`) or not looking at the office (`AWAY`);
   - the sender already has an unanswered nudge (`PENDING`), or the person already has five
     waiting (`BUSY`);
   - the sender nudged this person within the cooldown (`COOLDOWN`, with the time left);
   - the sender sent six nudges in the last minute (`RATE_LIMITED`, with the time left).

   Only the person nudged can answer and only the sender can cancel; anyone else is told the
   nudge is not open. Someone on Do not disturb can still nudge others.
3. **Configurable rules.** `OFFICE_NUDGE_REACH_PX` (default 160, bounded 32 to 640),
   `OFFICE_NUDGE_COOLDOWN_MS` (default 30 000, 0 to 600 000) and `OFFICE_NUDGE_TTL_MS` (default
   20 000, 1 000 to 120 000), read by `nudgeRules()`; a missing or nonsense value keeps the
   default. The join acknowledgement carries the rules in force (`nudge`, an optional field), so
   the browser offers the bell at the same distance the server accepts.
4. **Cleanup.** Open nudges live in the organisation's in-memory world, like pair requests. The
   world's tick ends them at their expiry, or as `gone` when either person is no longer behind
   their avatar. When a person's last office socket goes (leave or drop), their nudges end at
   once for the other person. The browser clears its cards on disconnect and on rejoin.
5. **Nothing is stored.** No table, no migration, no audit entry: a nudge is as transient as a
   wave. It changes no status, attendance, work time or meeting, and the roster and position
   streams are untouched.
6. **Controls.** In the map view every other avatar already has a focusable button with a menu
   (Call, Go to). A colleague who can be nudged now also gets:
   - a small bell at the corner of the avatar, shown while the pointer is over the avatar or the
     keyboard focus is on it, and always on a touch screen (32 px there);
   - "Nudge …" in the avatar's menu. When it is not possible the item is disabled and says why
     (walk closer, do not disturb, not looking at the office, waiting for an answer).

   The bell is offered from what the browser knows; the server's answer is what counts.
7. **Notifications.** `NudgeNotices` sits in a corner of the window (bottom on a phone), so it
   is seen in the map and the list view wherever the page is scrolled:
   - the person nudged: "… nudged you." with Accept and Ignore;
   - the sender: "Nudge sent to … Waiting for an answer…" with Cancel;
   - both, for six seconds or until dismissed: accepted, ignored, cancelled, expired or left.

   The card of the person nudged stays until the server's `office:nudge-closed` arrives, so both
   screens change on the same event. The region is announced to screen readers. A badge over
   the avatar marks who nudged me and whom I nudged.
8. **Sound.** Two soft notes made with the Web Audio API (`nudge-sound.ts`): no audio file, no
   new dependency, no Content Security Policy change. The audio context is created at the first
   click, tap or key press on the page, which is when browsers allow sound; before that the
   chime is skipped and the notification is shown silently. A "Nudge sound" switch (Notifications
   card, saved in this browser) turns it off.
9. **Reduced motion.** The bell icon bounces only without `prefers-reduced-motion`; the bell's
   fade is switched off under it. Nothing else moves.

## Consequences

- Single instance, like the office world (ADR 015 §4): nudges and cooldowns are per API process.
- Accepting a nudge does nothing beyond telling both people. Following it with a call or a walk
  over is left to them.
- The list view shows incoming nudges but has no bell: it has no positions, so it cannot tell
  who is near.
- A client from before this change ignores the new events and the new join field.
- Tests:
  - `apps/api/test/office-nudge.test.ts`: reach, settings and strict bodies;
  - `apps/api/test/office-nudge-e2e.test.ts`: delivery to one person, Accept, Ignore, Cancel,
    expiry, who may answer or cancel, cooldown, one at a time, the per-minute limit, yourself,
    Do not disturb, away, too far, both directions across organisations, bad bodies, not joined,
    disconnect and leave, and that nothing is stored;
  - `apps/web/e2e/46-office-nudge.spec.ts`: two signed-in people in two browsers (hover, click,
    keyboard, the chime blocked then played, all five outcomes on both screens, cooldown, Do not
    disturb, distance), the phone layout by touch, and reduced motion. The e2e API runs with an
    8 s cooldown and a 6 s expiry.

## Screenshots

In `docs/assets/office-nudge/`, written by spec 46 from two signed-in browsers: the bell on
hover (01), the request and the pending card (02, 03), accepted on both screens (04, 05), the
cooldown notice (06), ignored (07), expired (08), Do not disturb in the menu (09), the other
person left (10), the phone bell, request and outcome (11 to 13) and reduced motion (14).
