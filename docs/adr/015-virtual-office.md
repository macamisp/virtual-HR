# ADR 015: Virtual Office (without media)

**Status:** Accepted
**Date:** 16 October 2026
**Requirements:** SRS 5.3 FR-VO-001, 002, 003, 004, 005 (without media), 007, 008, 012, 013; 7.4 offices, rooms; 8.4 WebSocket events; NFR-PERF-002, 003.

## 1. Decisions agreed with the product owner

| Topic | Decision |
| --- | --- |
| Rendering | **pixi.js 8.21.0**, exact-pinned, in `apps/web` only (8.22.0 was 15 days old). No plugins, no asset packages: floors, walls, furniture, desks and avatars are drawn from simple shapes in code (`office-renderer.ts`); text uses Pixi's runtime bitmap fonts from the system Arial. No artwork from any other product. |
| Map | **One default map per organisation**, generated in code (`default-map.ts`): open area with 20 desks, four meeting rooms, two private rooms, reception, lounge. Stored as Tiled-style JSON in `offices.map_json` on first visit. Admins may replace it with their own Tiled JSON through `PUT /office/map` (validated). The map editor (FR-VO-006) is out of scope. |
| Proximity | **Groups computed now, media later.** The server forms proximity groups (radius per office, default 96 px = 3 tiles) and sends each person their group; the canvas draws links; "room-only mode" opts out. LiveKit will attach to these groups in the media slice. |
| Desks | **HR/admin assign; anyone may claim a free desk** (and release their own); one desk per person; audited. |

## 2. Map format (Tiled subset)

Orthogonal, 32 px tiles, at most 200 × 200 tiles, up to five floors per office (`OfficeDefinitionSchema`). Layers: tile layers `floor` (0 = void, not walkable) and `walls` (non-zero blocks); object groups `rooms` (properties `type`, `capacity`, `access`), `desks` (name = label), `furniture` (`collides`, `kind`), `spawn`. Rooms and desks are synchronised into the `rooms` and `desks` tables by object id, so access settings, passwords, invites and desk assignments survive a map replacement as long as the object id stays. A map can never set a password; a `PASSWORD` room in a map arrives as `KNOCK` until an admin sets one.

## 3. Movement and authority (FR-VO-002)

- **The server is authoritative.** Every `office:move` is checked against the collision grid built from the map (`collision.ts`, shared by API and browser): the avatar's bounding square must be on walkable tiles, the straight segment from the last accepted position must not cross a wall, and the distance must be within 200 px/s × elapsed server time (capped at 1 s) + 24 px slack. Entering a room the user may not enter is refused (`ROOM_KNOCK`, `ROOM_INVITE`, `ROOM_PASSWORD`, `ROOM_FULL`). A refusal returns the authoritative position; the client snaps back. More than 15 moves per second per socket are refused.
- The browser **predicts** with the same functions (sliding along walls, A* click-to-move with line-of-sight smoothing that avoids rooms it may not enter), so a well-behaved client is never corrected.
- Client clocks are never authoritative; a move carries the sender's clock only so it can be echoed to observers for latency measurement, and only for moves made since the previous tick.

## 4. Fan-out (FR-VO-013, NFR-PERF-003)

- One in-memory `OfficeWorld` per organisation (`office-registry.ts`). A **10 Hz tick** sends each observer a delta of their **neighbourhood**: the 3 × 3 interest cells of 512 px around them on their floor. Entries are compact tuples `[id, x, y, dir, status, roomId, echo]`; people who left the neighbourhood are listed in `gone`.
- Proximity groups (union-find over a radius grid) and roster changes (join, leave, room, status) are computed in the same tick and sent only when they change.
- **Limitation:** the world lives in one API instance. Running the office on several instances needs a Redis-backed world or sticky routing per organisation — required before horizontal scaling (as for rate limits, ADR 005).

## 5. Presence (FR-VO-003)

The attendance gateway now publishes every presence change to listeners; the office maps it onto the avatar ring: the attendance engine decides Active, Idle (and Paused → Away), On break, In meeting and Offline; the user may choose **Away** or **Do not disturb** and a message (`users.vo_status`, `vo_status_message`). DND wins over everything; a break is a fact and wins over Away.

The office opens its **own socket with `purpose: 'office'`**. The attendance gateway ignores such sockets when deciding whether the last connection is gone, so an open office tab never keeps an attendance session alive (tested).

## 6. Rooms (FR-VO-004, 008)

- Access modes: **OPEN**; **KNOCK** — the knock goes to everyone inside; anyone inside admits or declines; the admission lasts until the person leaves that room; one knock per room per 10 s; **INVITE** — `room_invites` managed by admins; **PASSWORD** — Argon2id hash in `rooms.password_hash` (never returned, never logged), five wrong attempts per minute per person and room, a correct password grants entry for the visit. Capacity is checked before access and applies to MEETING, PRIVATE and BROADCAST rooms; OPEN-type areas (reception, lounge) are parts of the floor and are never "full" (found by the load test: 200 people arriving at a 30-person reception). Admins (`org.manage`) may enter any room.
- Changing a room's mode or password withdraws earlier knock and password grants.
- Teleport: to my desk, to a colleague (refused with the room's reason when they are in a room I may not enter), to a room (with its password), to another floor.

## 7. List view (FR-VO-012)

The office page has a **List** view without the canvas and without the position stream (`office:join { positions: false }`): rooms with occupants, access mode and "Go to" buttons, the people list with live status and location, status, desk and room-only controls — all native buttons, selects and labelled inputs, announcements in an `aria-live` region. The map itself is `role="application"` with keyboard instructions; everything it offers is also in the side panel.

## 8. Data model (`20261024000000_virtual_office`)

`offices` (one per organisation, `map_json`, `proximity_radius` 48–320, `version`), `rooms` (SRS 7.4 columns incl. `livekit_room_name`, CHECKs for type, access mode, capacity, and "password iff PASSWORD"), `room_invites`, `desks` (one desk per user: unique `assigned_user_id`), `users.vo_status` / `vo_status_message`. RLS forced on all four tables; a trigger keeps rooms, desks and invites inside their organisation. New permission `office.use` for every role.

## 9. Tests

- `office-rules.test.ts` (11): map schema and reachability of every room and desk; collision, speed, wall-jump and junk moves; pathfinding; interest cells; proximity groups (and 200 people under 20 ms per tick); status mapping.
- `office-e2e.test.ts` (17, real sockets): default office and RLS; admin-only changes, validation, audit; desks; join at the desk or reception; batched positions with p95 < 200 ms; server refusals with the authoritative position; rate limit; interest management (no updates from afar, `gone`, reappearance); proximity and room-only; presence ring from attendance and DND; people search; knock flow; invite, password (hash only, never logged, attempts limited) and capacity; teleports; leaving; the office socket not keeping attendance alive.
- Playwright `16-office.spec.ts`: map and WASD, people search and teleport to a colleague with proximity, knock prompt, list view with status and desk controls, and a 200-avatar render bench.
- Load: `load/office.js` (k6) — results in §10.

## 10. Measured

**Position latency (NFR-PERF-003, FR-VO-013)** — k6, 200 avatars in one office for 5 minutes, all on the same floor and inside one corridor through the reception and lounge (the worst case for interest management: each sees 133 others on average, up to 191), each walking at the client's 10 Hz send rate for 2–6 s, then standing still for 1–4 s (`load/office.js`, `load/out/office-summary-200x5m.json`):

| Measure | Result | Target |
| --- | --- | --- |
| Position latency, mover's send → observer's receipt (includes the up-to-100 ms batching wait) | p50 **70 ms**, p95 **127 ms**, p99 151 ms, max 724 ms | p95 < 200 ms |
| Move acknowledgement | p50 11 ms, p95 66 ms | — |
| Moves rejected by the server | 46 of ~1.2 M (TOO_FAST under event-loop bunching), rate 0.00 | < 1 % |
| Fan-out | 594 k batched messages, 48 M position entries, 5.6 GB in 5 min | — |

The first run found a real defect: OPEN-type areas enforced capacity, so the 31st person could not enter the 30-person reception (now fixed, §6). It also showed that echoing the client clock on resends made re-appearances look like slow deliveries; the echo is now limited to fresh moves (§3).

**Rendering (NFR-PERF-002)** — Playwright bench (`/office?bench=200`, 200 avatars moving at 10 Hz plus the user) on this development laptop, Intel Core i5-1145G7 with Iris Xe graphics (a mid-range laptop), Chromium headed on the GPU with the frame-rate cap disabled: **244 fps**, with **0.1 ms of script per frame** (so 60 fps with vsync on, four times over). In headless CI Chromium renders WebGL in software (SwiftShader) and reaches about 10 fps; the per-frame script cost there is the same 0.15 ms, so CI asserts that the bench runs and reports, and the GPU number is the evidence for the target. Reproduce: `OFFICE_BENCH_GPU=1 npx playwright test e2e/16-office.spec.ts -g bench --headed`.

## 11. Known gaps

- No media (LiveKit), screen share, broadcast rooms' behaviour or ring-and-accept *calls* yet — the media slice. Knock-to-enter is the ring-and-accept for rooms.
- Single-instance world (see §4). No avatar-to-avatar collision (people may overlap).
- No map editor (FR-VO-006); no emotes (FR-VO-014).
