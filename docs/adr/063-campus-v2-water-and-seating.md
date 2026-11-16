# ADR 063: Campus v2: a pool and a pond in the garden, places to sit on benches and sofas

Date: 2026-11-16. Status: proposed (built and tested locally on `integration/local-qa-2026-11-16`; applied to the local
Acme Demo workspace only; not pushed, not deployed, no production map changed).
Related: FR-VO-019; ADR 055 (campus v1 and the map upgrade script), ADR 056 (sitting), ADR 060/061 (art).

## Context

V3 asks for a richer campus: water in the garden (a swimming pool with animation, a pond) and
interactive furniture. Water needs new map objects, which changes the stored map. The owner's rule:
"If new map objects are required, use a versioned, reversible, organisation-specific map upgrade.
Back up and rehearse it against a disposable local database first. Do not change production maps."

## Decision

1. **Campus v2 = campus v1 plus two new furniture objects.**
   - A swimming pool (`kind: pool`, tiles 89–94 × 4–7) and a pond (`kind: pond`, tiles 65–69 × 4–6), both
     colliding.
   - Their ids follow every id of campus v1 (`CAMPUS_V1_LAST_ID = 109`; the new ones are 110 and 111).
   - No tile, room, desk or earlier object changes, so every room and desk keeps its database row, and
     desk assignments and invitations stay.
   - New organisations get campus v2 from `defaultOffice()`.
2. **Versioned, reversible, one organisation at a time,** through the existing audited
   `PUT /office/map` and `scripts/office-map-upgrade.ts`.
   - The script now knows three versions: original, campus v1 and campus v2.
   - Each is identified by two independent checks: a recorded fingerprint (`CAMPUS_V1_FINGERPRINT`
     for campus v1), and equality to the map derived from code. Any other map is "customised" and
     never overwritten.
   - `--apply` moves the original or campus v1 to campus v2. `--rollback` goes back one step
     (v2 → v1 → original).
   - Each run writes a backup file and needs a typed confirmation. It then reads the office again and
     checks the rooms, desks, assignments, invitations and version.
3. **Places to sit.** `mapSeats` adds places along benches and sofas, in front of them and facing
   away from the back (seat kind `bench`).
   - They come from furniture already on every campus map, so no data change is needed.
   - The server's sitting rules apply unchanged: in reach, free, not through walls, one person each.
   - No chair is painted for them: the bench or sofa is the seat.
4. **Art and animation.**
   - Classic view: a tiled pool with a stone deck, lane ropes, shallow-end steps and a ladder; a pond
     with a pebble rim, lily pads, a flower and reeds.
   - Isometric view: the same, sunk into the deck.
   - The water glints: two prebuilt sets of sparkles swap every 700 ms, as the fairy lights do.
     Nothing is redrawn per frame, and nothing moves with the reduced-motion preference.

## Rehearsal and local application (2026-11-16)

1. `pg_dump` of `hrvo_demo`, restored into the disposable `hrvo_qa_rehearsal2`, with a second API on
   port 3201 against it. On that copy, Acme Demo (campus v1, version 6):
   - dry run: ELIGIBLE;
   - `--apply`: 11/11 checks ok (v7);
   - `--rollback`: back to exactly the campus v1 fingerprint (v8);
   - `--apply`: v9.
   - The assigned desk (object 21) kept its assignee throughout. `hrvo_demo` was untouched meanwhile.
2. On the local development database `hrvo_demo`, Acme Demo only: `--apply`, 11/11 checks ok (v6 → v7).
   - The script's backup is in `/run/media/macami/DataDrive/hrvo-db-backups/office-map/`; the database
     dump is `hrvo_demo-pre-campus-v2-20261116T0707Z.dump`.
   - The iCET workspaces (original maps) were not changed: upgrading them is their owner's decision.

## Rollback

Run `scripts/office-map-upgrade.ts <api> --rollback` as an administrator of the workspace. It moves
campus v2 back to campus v1 (the pool and pond go), with the same backup and checks. Nothing else
changes.

## Tests

- `office-map-upgrade-script-e2e`:
  - campus v1 recognised by its fingerprint and by derivation;
  - original → v2 → v1 → v2 → v1 → original, with every room, desk, assignment, invitation and
    password row unchanged;
  - customised maps refused.
- `office-actions` unit tests: 110 seats including 20 bench places, all walkable; sitting on a
  bench, and a taken place refused.
- `office-campus`, `office-map-upgrade-e2e` and `office-rules`.
